# Black Box

A flight recorder for AI shopping agents. When an agent buys something and the purchase is
disputed, Black Box replays a tamper-evident record of what the agent saw and decided, and
deterministic code (not an AI) returns one verdict: **USER**, **AGENT**, **MERCHANT** or
**NEEDS A HUMAN**. PayPal then carries the outcome out through the Disputes API.

> Work in progress for the PayPal AI Hackathon. Everything runs against the PayPal **sandbox**.

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

## Run it

Node 24, no dependencies.

```sh
npm test                                     # 81 tests
cp killtest/.env.example killtest/.env       # sandbox client ID/secret
npm run shop                                 # demo shop :4010, review platform :4011
node agent/run.mjs --model claude-haiku-4-5-20251001 --shelf RJ-PREMIUM-BLUE-M   # needs ANTHROPIC_API_KEY in .env
node executor/resolve.mjs <dispute_id>       # dry run; add --execute to act
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
| `killtest/` | sandbox feasibility checks for the Disputes API |
| `fixtures/recorded/` | real runs where a model was fooled by hidden text |

## Limits

The signature code implements only the RFC 9421 subset this project needs; it is not a general
implementation. The demo shop deliberately contains hidden pricing lies to test agents.

## License

MIT
