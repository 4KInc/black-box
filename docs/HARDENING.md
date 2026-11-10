# Hardening: the execution lifecycle, settlement state, and evidence by reason

Branch `hardening`, from `main` at `e8505c3`. Five items, one commit each. No network calls: every
test runs against a scripted PayPal and the committed fixtures. No fixture, bench expectation,
policy, verdict enum or record format changed.

| Item | Commit |
|---|---|
| 1. Unknown outcomes are held, never blindly retried | `afe4c97` |
| 2. Settlement state shown apart from the verdict | `8221991` |
| 3. Evidence only where it fits the dispute reason | `ea10b3d` |
| 4. Docs (README, THREAT_MODEL, SUBMISSION, this report) | `5441cfa` |
| 5. A timeout on every PayPal call | this commit |

## Findings

**F1. An unknown outcome counted as done** (`executor/core.mjs`, `resolveDispute` / `act`).
The action lock was taken before the call and released only on a 4xx. On a timeout, a network
error or a 5xx, the lock stayed, and every later run returned `already-done`. The dispute was then
reported as handled whether PayPal had acted or not, and the buyer could go unrefunded with no
one told. A run that died between taking the lock and sending had the same effect.

**F2. A missing HTTP status counted as success** (`replay/cases.mjs`, `paypalFromLog`,
`payoutAttempts`). The checks were `e.status < 300`, and `null < 300` is true in JavaScript. A
logged call with no status (a thrown error) would have shown as executed on the case page and
as a payout. `alreadyExecuted` already required 2xx.

**F3. No dispute-status check before acting** (`executor/core.mjs`). Only the offered actions
(links) were checked, never whether the dispute was still open.

**F4. A lost payout response could block payouts forever or mislabel them**
(`executor/payout.mjs`, `reimburse`).
- If the POST threw, nothing was logged, so the payout still looked due.
- The kept lock then answered `already-done` to every later run.
- A batch whose item was still PENDING was reported as "already paid".

**F5. Evidence quoted the agent's own words** (`evidence/evidence.mjs`, `statementsFor`). The
statements sent to PayPal, and given to the AI note writer, included the agent's free-text reason.
On the honest fixture it says the jacket was "in stock". An agent's words can claim stock,
delivery or condition, which the record cannot show.

**F6. Evidence statements did not check the reason** (`statementsFor`). Only the planner kept
non-receipt disputes from getting evidence. The statements themselves would have been built for
any reason.

**F7. Reasons Black Box does not answer were only "planned"** (`executor/core.mjs`). Non-receipt
and unknown reasons ended as `planned`, with nothing logged to say a person must decide.

**F9. PayPal calls had no timeout** (`lib/paypal.mjs`, `createPayPal`; `executor/core.mjs`,
`uploadEvidence`; `killtest/kt.mjs`). A call that hung would hold its lock until the lock went
stale. A later run could then take the lock over and resend, while the hung call might still land
at PayPal.

**F8. An inquiry PayPal would not let Black Box escalate was retried** (`executor/core.mjs`). It
returned `not-ready`, so the autopilot retried it ten times and gave up silently, instead of
holding it with a reason.

## Fixes

**Attempts** (`executor/attempts.mjs`, new, with no imports, shared by the executor and the
replay).
- Every escalate, accept-claim, make-offer and provide-evidence call is now an attempt.
- Each attempt is logged before the call (`step: 'attempt'`) with a stable action ID and the
  SHA-256 of its exact payload. Its result is logged after the call, with the same action ID.
- The action ID is `<dispute>:<kind>`. A partial accept-claim uses the same kind, since it is the
  same endpoint.
- `attempts(entries)` reads each action's latest state:
  - `succeeded`: 2xx, or reconciled later.
  - `refused`: 4xx.
  - `unknown`: no result, a 5xx, or a network error.
- Logs written before this change still read correctly.

**Reconciliation** (`executor/core.mjs`, `resolveDispute`, `actionDone`). Before acting, each
earlier attempt at the planned action, and at escalating when the plan is evidence, is settled
against the dispute PayPal reports now:
- **(a) PayPal shows it happened.** The run logs `reconciled` and nothing is sent.
  - accept-claim: a buyer credit in `money_movements`, a refund transaction, or a refunded outcome.
  - make-offer: `offer.seller_offered_amount`.
  - provide-evidence: evidence with source `SUBMITTED_BY_SELLER`.
  - escalate: the life-cycle stage is no longer `INQUIRY`.
- **(b) PayPal shows it did not happen and still offers the action.** The run sends it again
  with the same action ID and payload.
- **(c) Anything else** (a closed dispute, or the action no longer offered with nothing to show
  for it): `held-for-person`, logged as `hold` with the reason `outcome unknown`.

**Checks before sending** (`executor/core.mjs`, `send`).
- The dispute must be in `OPEN`, `WAITING_FOR_SELLER_RESPONSE` or `UNDER_REVIEW`; any other status
  is held.
- Under the lock, the log is read again.
- A payload whose hash differs from the earlier attempt's at the same action ID is held, never sent.

**The lock** (`executor/core.mjs`, `executionLog`, `send`).
- The lock is now held only from an attempt to its result, and is released after.
- A lock older than `STALE_LOCK_MS` (5 minutes) belonged to a run that died, and is taken over
  (logged as `stale-lock`).
- A fresh lock held by another run answers `in-progress`.

**Timeouts** (item 5: `lib/paypal.mjs`, `executor/core.mjs`, `killtest/kt.mjs`).
- Every PayPal HTTP call, including the OAuth token request, now gives up after
  `PAYPAL_TIMEOUT_MS` (30 s), using `AbortSignal.timeout`.
- The multipart evidence upload gives up after `UPLOAD_TIMEOUT_MS` (60 s).
- `killtest/kt.mjs`, the one-off feasibility script, has the same limits.
- A timeout is an unknown outcome. The attempt is logged with the error and no HTTP status, so
  `attempts()` reads it as `unknown`, and the next run settles it from PayPal's dispute or batch
  state, as for any other unknown outcome.
- `STALE_LOCK_MS` stays at 5 minutes. A test asserts that it is at least 5 minutes and at least
  three times `LONGEST_CALL_MS`, which is a token request plus the upload, 90 s. A lock is
  therefore never taken over while its call can still be in flight.
- **Re-checks of a "not offered yet" action:** the autopilot waits `RETRY_MS` (60 s) between them
  and makes at most `MAX_RETRIES` (10). The watcher's poll also looks every 30 s, so a dispute is
  never checked more often than that, never in a tight loop. This is a fixed interval, not the
  doubling backoff, which applies to disputes held for the flagger.

**New outcomes**, handled by `executor/autopilot.mjs` and explained by `executor/resolve.mjs`:
- `in-progress` and `outcome-unknown` are re-checked later, like `not-ready`.
- `held-for-person` is final.

**Payouts** (`executor/payout.mjs`, `reimburse`, `payoutDue`; `replay/cases.mjs`, `payoutAttempts`).
- Each payout is logged as a `payout-attempt` (an action ID with the attempt number, the payload
  hash and the fixed `sender_batch_id`) before the POST, and its result after.
- `payoutAttempts` reads each attempt as `unknown`, `refused`, `pending`, `succeeded` or `failed`.
- An `--execute` run looks up a pending batch first.
- No new batch is made while one is pending.
- An unknown attempt is held for a person (`held-for-person`).
- Only an item PayPal reports as failed (FAILED, DENIED, RETURNED, BLOCKED) leads to a new batch,
  with a new `sender_batch_id`. A refused (4xx) attempt created no batch, so the next one reuses
  the same ID.
- A request that differs from the earlier attempt with the same batch ID is held.

**F2:** every log reader now requires a 2xx status.

**Settlement** (`replay/settlement.mjs`, new, with no imports).
- `settlement(paypal, verdict)` is a pure function. It returns where the money stands:
  `open`, `unknown`, `refund-pending`, `repayment-pending`, `repayment-failed` or `settled`.
- It also returns the buyer's refund and the shopping app's repayment separately, and a line of
  text that labels sandbox amounts as sandbox.
- `paypalFromLog` now adds `unknown` (the kinds of action whose outcome is unknown) and
  `payoutState` (the latest payout attempt's state).
- The line shows in the case page's PayPal panel, styled by state. In the explorer it is a
  scenarios column and a detail line.

**Evidence by reason.**
- `executor/core.mjs`: when executing, a dispute whose reason is outside UNAUTHORISED,
  INCORRECT_AMOUNT and NOT_AS_DESCRIBED is held for a person, with the reason logged. A dry run
  still only plans.
- `executor/core.mjs`: evidence on an inquiry that PayPal will not let Black Box escalate is held.
- `evidence/evidence.mjs`: `statementsFor` returns nothing for those other reasons, and no longer
  quotes the agent's reason. The reason stays in the attached record.

## Tests

The suite went from 246 to 284 tests. The bench is unchanged at 62 cases.

**`executor/test/lifecycle.test.mjs`** (new, 27 tests, against a scripted PayPal whose dispute
state each test changes):
- An attempt with its payload hash is logged before the result.
- **Duplicate webhook:** two deliveries through the autopilot, then a run in another process:
  one POST.
- **Webhook racing a poll in another process:** one `executed`, one `in-progress`, one POST.
- **Crash before the call:** PayPal shows nothing, so the action is resent with the same action
  ID and payload hash.
- **Crash after PayPal accepted:** PayPal shows the credit, so the action is reconciled with no
  resend.
- **Unknown state:** the dispute moves to `OTHER`, so it is held for a person.
- **Stale attempt:** with a fresh lock the run answers `in-progress` and sends nothing; once the
  lock is stale it is taken over and the action resent.
- **Changed payload:** the disputed amount changes, so the dispute is held and nothing is sent.
- **Action no longer allowed:** the link is gone and nothing shows, so it is held.
- **Closed dispute:** `RESOLVED`, so it is held and nothing is sent.
- **A 4xx refusal:** an error is raised, and a later run may send again.
- **Evidence:** an escalation with an unknown outcome is reconciled from the life-cycle stage,
  then the evidence is sent once.
- `actionDone` for each kind of action.
- **Payouts:**
  - Pending: no new batch, and the batch is looked up first.
  - Item failed: one new batch, with `-2`.
  - Item succeeded: never sent again.
  - Unknown: held for a person, with no second batch.
  - Refused: the same batch ID is reused.
- A reason Black Box does not answer (non-receipt, and an unknown one) is held, and a dry run
  only plans.
- An inquiry that cannot be escalated is held.
- An action PayPal does not offer yet sends nothing, and goes once offered.
- **Timeouts** (item 5), through the real client in `lib/paypal.mjs` with a scripted `fetch`:
  - *every PayPal call carries a timeout: 30 s, and 60 s for the evidence upload*
  - *a hung call times out and is recorded as an unknown outcome; the next run settles it from
    PayPal*
  - *a hung call that never reached PayPal is sent again on the next run, same ID and payload*
  - *the stale-lock threshold is at least 5 minutes and well over the longest call*
  - *a lock is never taken over before the threshold, however close to it* (lock ages of 0, 90 s
    and 4 min 55 s)
  - *a payout call that hangs times out and is held, with no second batch*

**`executor/test/autopilot.test.mjs`:**
- `outcome-unknown` and `in-progress` are re-checked, and `held-for-person` is final.
- *"not ready" re-checks are spaced by the retry interval, ten at most, never a tight loop.*

**`replay/test/settlement.test.mjs`** (new, 5 tests):
- All 9 live fixtures are pinned to their settlement, and checked to cover every live bench case.
- Every live case page shows its settlement with the same verdict and PayPal outcome as before.
- Each state is built from a mocked execution log.
- A simulated bench dispute has no settlement.

**`evidence/test/evidence.test.mjs`:**
- One test per reason: each claims only authorisation, the amount or the listing match, and none
  mentions delivery, shipping, arrival, condition, damage or stock.
- "received" appears only in "the text the model received".
- A reason outside the three gets no statements at all.

**`executor/test/payout.test.mjs`:** a pending batch now reads "payout pending", not "already paid".

## Remaining risks

- **Local lock, one instance.** The lock is a file created exclusively on the service's own disk.
  In the hosted demo that disk is the mounted Cloud Storage bucket, where exclusive create is only
  as reliable as the mount. The service must run with `--max-instances 1`, as it does.
- **No proof of exactly-once.** One case can still duplicate: the process dies after PayPal
  accepted the call and before the result is logged, and PayPal's dispute does not yet show the
  action when the next run reads it. That window is narrowed but not closed. The tests use a
  scripted PayPal, so they show the logic, not PayPal's behaviour under failure.
- **The "done" signals are inferred from PayPal's fields.**
  - The buyer credit (`money_movements`) and refund transactions appear in the committed live
    fixtures.
  - `offer.seller_offered_amount` and `evidences[].source` follow PayPal's documented dispute
    resource. No live response in this repository shows them.
  - If PayPal reports these differently, the dispute is held rather than resent, because the
    action would no longer be offered or the dispute would be closed. It could, however, be
    resent once if PayPal still offered the action after carrying it out.
- **A timed-out call may still land.** A timeout means Black Box stopped waiting, not that PayPal
  did not act. The next run reads PayPal's state before anything else. If PayPal has not shown the
  action yet but carries it out a moment later, that one action can be sent twice. The stale-lock
  threshold (5 minutes, over three times the longest call) keeps a second run from sending while
  the first may still be in flight. It cannot prevent PayPal applying a request late.
- **A payout whose response was lost is held, not looked up.** Without PayPal's batch ID, Black
  Box cannot read the batch, so a person checks it. The fixed `sender_batch_id` makes PayPal
  refuse a second batch for the same attempt.
- **"Not offered yet" is re-checked, not held at once.** When PayPal does not yet offer the
  planned action, nothing is sent and the autopilot re-checks it up to ten times, then leaves it
  to a person. Holding it at once would break evidence after an escalation, which PayPal offers
  only some time later. This differs from the brief's "action not currently allowed → hold". The
  final state is the same; it is only reached later.
- **Committed fixtures predate attempts.** The live fixtures carry no attempt data, so their
  settlement can never read "outcome unknown". It reads that only from new execution logs.
- **The CLI payout path is manual.** Payouts still run only from `node executor/payout.mjs`, not
  from the autopilot. The new checks apply there.
