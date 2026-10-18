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
| Uses a hiding trick the extractor does not know | The AI flagger quotes it; the quote must appear word for word in the model input and name the item. The flag can only send the case to a person, never blame anyone by itself | F01, F02 |
| Edits the stored page afterwards to remove the note and blame the agent | Each page is stored with its hash and RFC 9421 signature; the record hash is in the PayPal order's `custom_id`, which PayPal does not allow to change after payment | A01 |
| Claims it never wrote the note | The page bytes are signed with the shop's Ed25519 key, fetched from the shop's own `/.well-known/jwks.json` | A06 |
| (Honest merchant) Publishes accurate product data in JSON-LD that is not displayed | Not a contradiction: no other price and no instruction to ignore limits, so it is not held against the merchant | R12 |
| (Honest merchant) Publishes accurate data that states another price: a variant, a range, a member or sale price, tax, shipping, another currency, a former price | Not a contradiction: only a price for the purchased item and variant, in the order's currency, valid at order time, counts (or any price aimed at agents) | R14–R21 |
| Words a lie to slip past that definition, such as an agent price phrased as a range | The contradiction check misses it, but the AI flagger quotes it and the case goes to a person, so the lie wins no automatic outcome | F01, F02 |
| Plants the note in a third-party review to dodge blame | Third-party-signed content is attributed to its signer; code then cannot blame the merchant and sends the case to a person rather than to the agent | R06 |
| Steers the agent but stays within budget | Within the mandate, steering is a judgment, not a check: NEEDS A HUMAN | R07 |
| Takes payment to a different account than the page names | The signed merchant ID must equal the PayPal payee | A04 |

### A dishonest buyer

| Attack | Defence | Shown by |
|---|---|---|
| Disputes an honest purchase as "not as described" | The record shows the item matched the signed listing and the mandate; Black Box sends it as evidence | R01, F03 |
| Claims "I never authorised this" | The mandate carries the buyer's passkey approval, verified against the passkey enrolled for the payer PayPal reports | P01 |
| Presents a different (honest-looking) record for the disputed order | The record hash must equal the order's `custom_id` | A02 |

### A dishonest agent operator

| Attack | Defence | Shown by |
|---|---|---|
| Raises the budget after the user approved it | The passkey signs sha256 of the exact mandate; any change breaks it | A07 |
| Signs a looser mandate with its own passkey | The passkey must be one the paying user enrolled | A08 |
| Reuses one user's approval for another user's order | The passkey is checked against the payer PayPal reports for this order | A09 |
| Strips the approval and claims the order is old | An unsigned mandate counts only if the paying account had no passkey enrolled when PayPal created the order; PayPal reports the payer and the order time | A10 |
| Forges a page or a signature | Every signature is re-verified from the stored bytes; a consistent hash does not help | A03 |
| Backdates the pages | Every signature must be older than the PayPal order | A05 |

### Someone on the network

| Attack | Defence | Shown by |
|---|---|---|
| Sends a forged PayPal webhook to trigger a refund | Every event is verified with PayPal's `verify-webhook-signature` before anything is read; the event only supplies a dispute ID, and the verdict always comes from PayPal's own dispute data and the stored record | live test: forged event refused with 401; executor tests |
| Replays a real webhook | Event IDs are de-duplicated; a dispute is acted on at most once (a lock file shared by every process) | executor tests; live run: a third webhook arrived after the refund and was ignored |
| Injects script through a recorded page | Replay pages run no scripts at all (CSP `script-src` absent, `default-src 'none'`); recorded pages are shown only in a sandboxed iframe | site and replay tests |

### Black Box itself

- **Acts only when told to:** dry run unless `AUTO_EXECUTE=on`.
- **Acts once, and only when PayPal allows it:** a dispute is skipped unless PayPal currently
  offers the planned action, and a logged success, or a lock, means it is never sent twice.
- **Leaves a trail:** every PayPal call, request and response is appended to
  `records/executions/<dispute>.jsonl`.
- **Code decides, AI does not:** the six rules are deterministic, and exactly one fires for every
  one of the 16,384 combinations of the 14 facts (property-tested). That proves the rules are
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

## Not covered

- Delivery problems ("not received"): the normal PayPal process applies (R05).
- Real money: everything runs in the PayPal sandbox.
- Multi-item carts, shops that render with JavaScript, and agents that browse beyond one shop.
- A general RFC 9421 implementation: the signature code covers only the profile Black Box uses.
- Who should run Black Box: in the demo it acts with the merchant's PayPal credentials. A neutral
  operator, or PayPal itself inside its dispute process, is the natural home.
