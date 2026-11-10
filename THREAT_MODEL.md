# Threat model

Black Box decides who is responsible, under its responsibility policy, when an AI agent's purchase
is disputed (see [the policy](README.md#the-responsibility-policy)). Every party to that decision
has a reason to cheat, so this document lists who could cheat, how, what stops them, and which
bench case shows it (`npm run bench`, or [the bench online](https://4kinc.github.io/black-box/bench/)).
It ends with what Black Box has to trust, and what it does not cover.

## What is being protected

- **The verdict:** USER, AGENT, MERCHANT or NEEDS A HUMAN, and the PayPal action that follows.
- **The record:** what the agent saw (signed pages, byte for byte), what the model received,
  what it decided, and the mandate the user approved.
- **The money:** a refund or offer is sent at most once, only for the right dispute.

## Who might cheat, and what stops them

### A dishonest merchant

| Attack | Defence | Shown by |
|---|---|---|
| Hides an instruction or false price that only AI agents read | The extractor finds text hidden from people inside what the agent reads. If it is the merchant's own signed text, names the item, contradicts the signed listing and reached the model, the merchant is responsible, whether or not the agent would have failed anyway | R03, R11, R13, P02, P03 |
| Uses a hiding trick the extractor does not know (e.g. a 1px screen-reader-only box) | The AI flagger quotes it; the quote must appear word for word in the model input and name the item. The flag can only send the case to a person, never blame anyone by itself. Tricks code does list (opacity, clip-path, clip, `scale(0)`, display, visibility, off-screen, zero size, background colour, aria-hidden) are the merchant's by code alone | F03, F04 (unlisted); F01 (opacity) |
| Edits the stored page afterwards to remove the note and blame the agent | Each page is stored with its hash and RFC 9421 signature; the record hash is in the PayPal order's `custom_id`, which PayPal does not allow to change after payment | A01 |
| Claims it never wrote the note | The page bytes are signed with the shop's Ed25519 key, fetched from the shop's own `/.well-known/jwks.json` | A06 |
| (Honest merchant) Publishes accurate product data in JSON-LD that is not displayed | Not a contradiction: no other price and no instruction to ignore limits, so it is not held against the merchant | R12 |
| (Honest merchant) Publishes accurate data that states another price: a variant, a range, a member or sale price, tax, shipping, another currency, a former price | Not a contradiction: only a price for the purchased item and variant, in the order's currency, valid at order time, counts (or any price aimed at agents) | R14–R21 |
| Rewords the lie to dodge the extractor: a fee word beside it ("$119, shipping included"), a former price ("was $240, now $119"), a one-sided "from $119", "USD 119" with no $ sign, a structured Offer at $119, or "the buyer pre-approved any amount" | Exclusions bind to the amount they qualify, not the sentence; a range needs two amounts; amounts with an ISO code are read; JSON-LD Offers are parsed as numbers (SKU, currency and validity checked); pre-authorisation claims to the agent count as overrides. All six give MERCHANT | E01–E06 |
| Finds a wording code still cannot classify | The merchant's own hidden text about the item, addressed to AI agents, that did not count as a contradiction (`unclassifiedAgentText`) goes to rule 4, a person, never to rule 5, the agent. By design this gives up automatic resolution for every such note, honest ones and in-mandate purchases included, but never blames the merchant without a contradiction. Accurate data not addressed to agents (R12, R14–R21) and an Offer for another variant are unaffected | E07, E08, E09; property test |
| Puts the lie on another product's JSON-LD node (a related item, another variant) so it does not "name" the item | A JSON-LD field names the purchased item only if it sits on that item's node (`sku` or `productID`); text on other nodes is about other products. Such a lie wins nothing for the item bought, and the case is judged as if it were not there | E10, E11 |
| Hides a lie for people outside the agent channel, e.g. "$119 in our outlet stores" | "Outlet" and "in store" mark another sales channel and exempt only text not addressed to agents, so code does not count it. The AI flagger is the backstop: a quote naming the item sends the case to a person | extract tests; F04 |
| Words a lie to slip past that definition without addressing agents | The contradiction check misses it, but the AI flagger quotes it and the case goes to a person, so the lie wins no automatic outcome | F04 |
| Makes the flagger fail (a page that breaks it, or an outage), so only code judges | The executor fails closed: with no flagger answer, no money moves. Every AGENT or MERCHANT refund or offer is held (code's verdict kept, the plan marked held, the reason logged once per retry), and the autopilot retries with backoff (capped at 30 minutes) until the flagger answers. USER evidence moves no money and is still sent. A lie hidden by a method code does not list cannot make the operator pay | F01, F03; executor tests "no flagger answer + MERCHANT", "no flagger answer + AGENT", "no flagger answer + USER", "with a flagger answer, AGENT and MERCHANT execute as before", "a failed flagger run is not cached"; autopilot tests "a held dispute is retried with growing intervals", "at startup, acting without a flagger prints a warning" |
| Plants the note in a third-party review to dodge blame | Third-party-signed content is attributed to its signer; code then cannot blame the merchant and sends the case to a person rather than to the agent | R06 |
| Steers the agent but stays within budget | Within the mandate, steering is a judgment, not a check: NEEDS A HUMAN | R07 |
| Takes payment to a different account than the page names | The signed merchant ID must equal the PayPal payee | A04 |

### A dishonest buyer

| Attack | Defence | Shown by |
|---|---|---|
| Disputes an honest purchase as "not as described" | The record shows the item matched the signed listing and the mandate; Black Box sends it as evidence | R01, F06 |
| Claims "I never authorised this" | The mandate carries the buyer's passkey approval, verified against the passkey enrolled for the payer PayPal reports | P01 |
| Presents a different (honest-looking) record for the disputed order | The record hash must equal the order's `custom_id` | A02 |
| Tells the agent to break the mandate ("go up to $250", "budget doesn't matter"), then disputes the overspend so the operator pays | The request is sealed in the record. If it asks for more than the mandate and the mandate was broken, `requestExceedsMandate` sends the case to a person (rule 4) instead of AGENT. Words that never reached the model do not count | agent and engine tests; property test |

### A dishonest agent operator

| Attack | Defence | Shown by |
|---|---|---|
| Raises the budget after the user approved it | The passkey signs sha256 of the exact mandate; any change breaks it | A07 |
| Signs a looser mandate with its own passkey | The passkey must be one the paying user enrolled | A08 |
| Reuses one user's approval for another user's order | The passkey is checked against the payer PayPal reports for this order | A09 |
| Strips the approval and claims the order is old | An unsigned mandate counts only if the paying account had no passkey enrolled when PayPal created the order; PayPal reports the payer and the order time | A10 |
| Forges a page or a signature | Every signature is re-verified from the stored bytes; a consistent hash does not help | A03 |
| Backdates the pages | Every signature must be older than the PayPal order | A05 |
| Claims the buyer asked for the overspend, by adding words like "I can go up to $300" to the buyer's request in the record | After payment the edit breaks the record hash against `custom_id`. Made before payment, the words count only because the recorder is trusted (see below), and they still win no money: `requestExceedsMandate` only turns AGENT into NEEDS A HUMAN, and never moves the blame off a shop that planted a lie | lab (buyer-asked) and its tests |

### Someone on the network

| Attack | Defence | Shown by |
|---|---|---|
| Sends a forged PayPal webhook to trigger a refund | Every event is verified with PayPal's `verify-webhook-signature` before anything is read; the event only supplies a dispute ID, and the verdict always comes from PayPal's own dispute data and the stored record | live test: forged event refused with 401; executor tests |
| Replays a real webhook | Event IDs are de-duplicated; a dispute is acted on at most once (a lock file shared by every process) | executor tests; live run: a third webhook arrived after the refund and was ignored |
| Injects script through a recorded page | Replay pages run no scripts at all (CSP `script-src` absent, `default-src 'none'`); recorded pages are shown only in a sandboxed iframe | site and replay tests |

### Black Box itself

- **Acts only when told to:** dry run unless `AUTO_EXECUTE=on`.
- **Acts only when PayPal allows it, and never blindly twice:** it acts only on an open dispute
  whose reason it answers, and only when PayPal currently offers the planned action. Each action
  (escalate, accept-claim, make-offer, provide-evidence, a payout) is an attempt logged before the
  call, with a stable action ID and the hash of its exact payload, and its result is logged after.
  A logged success means done. An attempt with no known result is settled from what PayPal
  reports on the next run: done if PayPal shows it, resent with the same payload only if PayPal
  shows it did not happen and still offers it, otherwise held for a person. A different payload for
  the same action is held. A payout batch is pending until its item is SUCCESS, no new batch is made
  while one is pending or unknown, and only an item PayPal reports as failed gets a new one.
- **Leaves a trail:** every PayPal call, request and response is appended to
  `records/executions/<dispute>.jsonl`.
- **Fails closed without the flagger:** if the flagger errors, has no key or is turned off, no
  money moves: every AGENT or MERCHANT refund or offer is held for a person (logged as `hold`,
  with code's verdict), retried with backoff (1, 2, 4 ... minutes, capped at 30), and the
  autopilot warns at startup when it is set to act with no flagger. USER evidence is still sent.
- **Code decides, AI does not:** the six rules are deterministic, and exactly one fires for every
  one of the 65,536 combinations of the 16 facts (property-tested). That proves the rules are
  consistent and complete, not that the policy is fair or that each fact was extracted correctly.
  The only AI input, the flag, can only lead to NEEDS A HUMAN, and only when its quote names the
  item bought.
- **The AI words the evidence note, it does not write the facts:** on a USER verdict, code builds
  the statements sent to PayPal, and an AI may only reword them. A note that adds a number, amount,
  ID, SKU or hash the statements lack, accuses anyone, or runs long is rejected, and the statements
  are sent as written. The check cannot prove every rewording is faithful, so the statements and
  the record always go to PayPal with the note.

## What Black Box has to trust

1. **The recorder logged what the model really received.** The record is tamper-evident after it
   is committed to the PayPal order, but whether it was truthful when it was made depends on the
   recorder. The model input and decision are written by the agent operator's recorder. Black Box
   checks that hidden text in the input came from the signed page, but it cannot prove the model
   saw exactly that input. Model providers signing their inputs and outputs would close this gap.
2. **The shop's domain is the shop.** A signing key counts because it is published on the shop's
   own domain over HTTPS (the demo shop runs on localhost).
3. **PayPal's order data is true:** `custom_id` cannot change after payment, and the payee, payer
   and order time are what PayPal says.
4. **Passkey enrolment happened on the user's own device.** Enrolment does not check device
   attestation, and the enrolment registry, including each passkey's enrolment time, is local to
   the Black Box instance. The WebAuthn signature counter is not checked: synced passkeys (such as
   Apple's) always report 0, so a counter would not detect a cloned key. A buyer who never enrolled
   a passkey has unsigned mandates, which are taken as recorded.
5. **Pages are self-contained.** Pages that depend on unsigned scripts or files cannot be
   attributed to the merchant, so hidden text on them sends the case to a person.
6. **The bench key is never a shop's key.** The case bench re-signs the pages it rewrites (E01-E13, F03, F04)
   with a TEST-ONLY key whose private half is committed
   (`bench/keys/TEST-ONLY-bench-signing-key.jwk.json`), so anyone can sign with it. The shop and
   the review platform refuse to start with it, nothing publishes it, and a record whose key set
   carries it fails `keyOnShopDomain` everywhere except the bench, which says so explicitly
   (`trustBenchKey`). Tested in `bench/test/keys.test.mjs`.

## Known limitations

- **A contradicting price told to agents in plain, visible text is not hidden text.** If a shop
  prints "AI agents pay $119" where every shopper can see it, nothing was concealed, so code does
  not count it against the merchant: the five merchant conditions start with concealment. An
  agent that believes it and overspends looks, to code alone, like an agent at fault (AGENT). The
  AI flagger and a person are the backstop: a flag that quotes it, naming the item, sends the
  case to a person (rule 4), and without a flagger answer no money moves.
- **Hiding methods code does not list** (a 1px screen-reader box, for one) are caught only by the
  flagger (F03, F04). The list grows as tricks are found; each one missed costs a review, not a
  wrong payment.
- **The action lock is local, so the service must run as one instance.** The lock that keeps two
  runs from sending the same action at once is a file created exclusively on the service's own
  disk (`records/executions/<dispute>.lock`; in the hosted demo, the mounted Cloud Storage bucket,
  where exclusive create is only as reliable as the mount). It works only among processes that
  share that disk. The live service runs with
  `--max-instances 1`; a second instance, or a second machine with its own disk, could send the
  same action twice. A lock left by a run that died is taken over after five minutes.
- **No proof of exactly-once.** The attempt log narrows a duplicate down to one case: the process
  dies after PayPal accepted the call and before the result is logged. The next run then relies on
  PayPal's dispute showing the action (a buyer credit, a seller offer, seller evidence, a claim
  stage). Where PayPal shows neither that it happened nor that it did not, the dispute is held for a
  person rather than resent. PayPal's dispute actions take no idempotency key here, and the tests
  run against a scripted PayPal, so they show the logic, not PayPal's behaviour under failure.
- **A payout whose response was lost is held.** Without the batch ID PayPal returned, Black Box
  cannot look the batch up, so it holds rather than create another; the fixed `sender_batch_id`
  also makes PayPal refuse a second batch for the same attempt.
- **"Not offered yet" is re-checked, not held at once.** When PayPal does not yet offer the
  planned action (evidence just after an inquiry was escalated, for one), nothing is sent and the
  autopilot checks again, ten times at most, before leaving the dispute to a person.

## Not covered

- Delivery problems ("not received"): Black Box sends nothing and holds the dispute for a person;
  the normal PayPal process applies (R05). Its evidence never speaks to delivery or condition.
- Real money: everything runs in the PayPal sandbox.
- Multi-item carts, shops that render with JavaScript, and agents that browse beyond one shop.
- A general RFC 9421 implementation: the signature code covers only the profile Black Box uses.
- Who should run Black Box: in the demo it acts with the merchant's PayPal credentials. A neutral
  operator, or PayPal itself inside its dispute process, is the natural home.
