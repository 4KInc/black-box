# Live smoke test: one full sandbox chain

One MERCHANT case end to end on the current code: passkey mandate, fooled agent, PayPal checkout,
buyer dispute, autopilot, refund. Everything runs against the PayPal **sandbox**.

Since the flagger fails closed, a MERCHANT case is **held** (no refund) unless the AI flagger
answers. Step 1 checks that before you start, and stops you if it would not.

## 0. Prerequisites

- Node 24.
- `black-box/.env` holds `ANTHROPIC_API_KEY`. Do not set `FLAGGER=off`.
- `killtest/.env` holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (the merchant's sandbox app) and
  `BUYER_EMAIL` (the sandbox personal account).
- You can log in to sandbox.paypal.com as that buyer.

## 1. Preflight (fails loudly if either key is missing or does not work)

```sh
node scripts/live.mjs preflight
```

It makes one 1-token call to the flagger's model and asks PayPal for a sandbox token. Expect
`preflight ok: ...`. On `!!! LIVE CHECK FAILED !!!`, fix what it lists before going on.

## 2. Start the shop (terminal A)

```sh
npm run shop          # Driftwood Outfitters on :4010, with its hidden "$119 for agents" note
```

## 3. Approve the mandate with a passkey (terminal B)

```sh
npm run mandate       # http://localhost:4050 (use "localhost", not 127.0.0.1)
```

In the browser: enrol a passkey for the buyer's PayPal payer ID if you have not already, then
approve **blue rain jacket, size M, at most $150**. Note the mandate hash it prints.

## 4. Run the agent (terminal C)

```sh
node agent/run.mjs --mandate <mandate_hash> --model claude-haiku-4-5-20251001 --shelf RJ-PREMIUM-BLUE-M
```

Expect `chose RJ-PREMIUM-BLUE-M`, an `order ... $240.00 approve: <url>` line and
`if disputed as "not as described": MERCHANT (rule 2) -> accept-claim`. If the model declined
this time, run it again.

## 5. Pay as the buyer

Open the `approve:` URL, log in as the sandbox buyer and approve. The shop captures at once: the
page says `Thank you, payment received ... COMPLETED`.

## 6. File the dispute as the buyer

On sandbox.paypal.com as the buyer: Activity, this $240 payment, Report a problem, item
significantly not as described. Note the dispute ID (`PP-R-...`).

## 7. Run the autopilot (terminal C)

```sh
AUTO_EXECUTE=on npm run watch -- --every 30
```

There must be **no** `WARNING: ... will be HELD` line at startup. Within a poll or two expect:

```
<time>  PP-R-...  executed  MERCHANT rule 2  accept-claim
```

If it prints `held` instead, the flagger did not answer: stop, rerun step 1, and restart the
watcher. Nothing was sent to PayPal. Stop the watcher with Ctrl-C once it has executed.

To see the verdict before anything is sent, run the dry run first:
`node executor/resolve.mjs <dispute_id>`.

## 8. Confirm the refund

```sh
node scripts/live.mjs capture <dispute_id>
```

Expect `capture <id>  REFUNDED`. Anything else exits with `!!! LIVE CHECK FAILED !!!`.

## 9. See it

```sh
npm run replay        # http://localhost:4030: the new case, with the PayPal outcome
```
