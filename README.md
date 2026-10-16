# Black Box

A flight recorder for AI shopping agents. When an agent buys something and the purchase is
disputed, Black Box replays a tamper-evident record of what the agent saw and decided, and
deterministic code (not an AI) returns one verdict: **USER**, **AGENT**, **MERCHANT** or
**NEEDS A HUMAN**. PayPal then carries the outcome out through the Disputes API.

> Work in progress for the PayPal AI Hackathon. Everything runs against the PayPal **sandbox**.

**Try it without keys:** [4kinc.github.io/black-box](https://4kinc.github.io/black-box/) is a read-only replay of every
recorded case and the case bench, rebuilt from `fixtures/` by GitHub Actions on every push (`npm run site`).

## How it works

1. **Signed shop.** Merchant pages are signed with HTTP Message Signatures (RFC 9421 profile,
   Ed25519, RFC 9530 `Content-Digest`); the key is published at `/.well-known/jwks.json`.
2. **Recorder.** The agent's fetches, the exact text the model received, its decision and the
   purchase are sealed into one record. The record hash goes into the PayPal order's
   `custom_id`, which cannot be changed after capture.
3. **Verdict engine.** Six rules over twelve boolean facts; exactly one rule must fire
   (property-tested over all 4,096 combinations). A MERCHANT verdict needs proof that text the
   merchant signed was hidden from humans, named the purchased item and reached the model.
4. **Executor.** Reads a PayPal dispute, loads the record by `custom_id`, decides, and runs
   `accept-claim`, `make-offer` or `provide-evidence`.
5. **Passkey mandate.** The user approves the mandate with a passkey enrolled for their PayPal
   payer ID; the WebAuthn signature covers sha256(canonical mandate). At dispute time, the passkey
   must be one enrolled by the payer PayPal reports. Orders before `PASSKEY_REQUIRED_FROM` are legacy.
6. **AI flagger.** Claude reads the pages the agent read and quotes text aimed at automated buyers.
   Only quotes found word for word count, and the flag can only lead to NEEDS A HUMAN. It catches
   hiding tricks the extractor does not know (bench F01/F02: `opacity:0`).
7. **Autopilot.** A dispute webhook (verified with PayPal) or the dispute watcher triggers the
   executor with no one at the keyboard. It acts at most once per dispute, only when PayPal offers
   the planned action, and only for orders that carry a Black Box record.

## Design decisions

- **Rule 4 has two triggers.** A case goes to a person when the agent read hidden text that code
  cannot pin on the merchant (inside third-party-signed content, or depending on unsigned files or
  scripts), or when the AI flagger raises its flag. Otherwise a lie planted by a third party would
  be blamed on the agent (bench R06).
- **The mandate must be passkey-approved** (`mandateSigned`, a record check). Without it, whoever
  runs the agent could rewrite the budget. Orders PayPal created before `PASSKEY_REQUIRED_FROM`
  predate passkeys and are judged without it (bench A07-A10).
- **A flag counts only for the item bought.** The flagger's quotes raise the flag only if a quote
  names the purchased item (SKU or exact name), the same test the merchant conditions use.
  Manipulation aimed at other products does not make an honest purchase suspect (bench F05).

## Run it

Node 24, no dependencies.

```sh
npm test                                     # 120 tests
npm run bench                                # 29-case bench: every verdict and rule, the AI flagger, attacks on the record
npm run mandate                              # :4050 enrol a passkey, approve a mandate; then agent/run.mjs --mandate <hash>
cp killtest/.env.example killtest/.env       # sandbox client ID/secret
npm run shop                                 # demo shop :4010, review platform :4011
node agent/run.mjs --model claude-haiku-4-5-20251001 --shelf RJ-PREMIUM-BLUE-M   # needs ANTHROPIC_API_KEY in .env
node executor/resolve.mjs <dispute_id>       # dry run; add --execute to act
AUTO_EXECUTE=on npm run watch                # poll PayPal and resolve new disputes automatically (no public URL needed)
npm run webhook -- --register https://…/paypal/webhook   # register a public URL for dispute webhooks
AUTO_EXECUTE=on npm run webhook              # receive webhooks; every event is verified with PayPal first
npm run replay                               # replay UI on :4030: verdict, hidden text vs model input, facts, PayPal outcome
```

`SHOP_INJECTIONS=off npm run shop` serves the same pages without the hidden text (control).

## Layout

| Dir | What |
|---|---|
| `engine/` | verdict rules, mandate check, hidden-text extractor, case evaluation, PayPal action plan |
| `lib/` | signatures, canonical JSON, PayPal client |
| `shop/` | demo merchant and third-party review platform |
| `recorder/` | sealed shopping records |
| `agent/` | shopping agent (Anthropic API or a local OpenAI-compatible model) |
| `executor/` | dispute → record → verdict → PayPal action |
| `bench/` | case bench: recorded runs and record attacks, each with its expected verdict, rule and PayPal action |
| `mandate/` | passkey enrolment and mandate approval (WebAuthn, node:crypto only) |
| `flagger/` | AI injection flagger, grounded by exact quotes |
| `site/` | static export of the replay and bench for GitHub Pages (relative links, CSP in meta tags) |
| `replay/` | replay UI: every recorded purchase, judged and explained (no scripts; recorded pages sandboxed); `/bench` shows the case bench |
| `killtest/` | sandbox feasibility checks for the Disputes API |
| `fixtures/recorded/` | real runs where a model was fooled by hidden text, incl. the live sandbox refund |

## Limits

The signature code implements only the RFC 9421 subset this project needs; it is not a general
implementation. Passkey enrolment trusts the enrolment screen (no attestation check), and the
enrolment registry is local. The demo shop deliberately contains hidden pricing lies to test agents.

## Design

The UI is a flight recorder and its incident report: B612 (the typeface Airbus drew for cockpit
displays) and Barlow Condensed, both SIL Open Font License, self-hosted in `replay/fonts/` with
their licences. No scripts on any replay page; motion is CSS only and off under reduced motion.

## License

MIT
