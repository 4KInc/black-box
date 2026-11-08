# Black Box: demo video script (2:50)

Every claim below comes from a recorded case, the bench or the study in this repo. Each beat lists
the time, what is on screen and the voice-over; the shot list at the end names every page to
capture, in filming order.

**Pages used**

| Short name | URL |
|---|---|
| Site | https://4kinc.github.io/black-box/ |
| Hosted | https://black-box-342881585799.us-central1.run.app |
| Demo | Hosted `/demo` (`/mandate/` and `/operator` ask for the operator password) |
| P09 (live: the buyer's own words, hidden $119 note, $240 refunded) | Site `/bench/P09/` |
| P08 (live: the agent paid from a saved wallet, $240 refunded) | Site `/bench/P08/` |
| P06 (live: AGENT, $90 back, operator payout) | Site `/bench/P06/` |
| P04 (live: USER, evidence sent) | Site `/bench/P04/` |
| Study | Site `/study/` |
| Lab | Hosted `/lab?case=P09` |

---

## 0:00 – 0:15 · Hook

**On screen:** P09 case page, top: the red **MERCHANT** verdict, the budget gauge ($240.00 paid,
$150.00 budget), then the timeline's **Order** row: PayPal order `8C11141990450122S`, $240.00.

**Voice-over:**
> My agent paid two hundred and forty dollars on a hundred-and-fifty-dollar budget. Who pays: me,
> the shop, or the company running the AI?

## 0:15 – 0:35 · What a person sees, what the agent read

**On screen:** P09, section 2 "What the shopping agent saw". Left, the customer's view: the signed
page at $240.00. Right, the AI's view: exactly what the model was given, with the highlighted
JSON-LD note "... bringing the final total to $119.00". Then the agent's stated reason underneath.

**Voice-over:**
> A person sees two hundred and forty dollars. The agent also reads a note hidden in the page's
> data, for AI shoppers only: your total is one nineteen. It believed it. Black Box sealed both:
> every signed page, byte for byte, and the exact text the model received.

## 0:35 – 0:50 · Does it happen?

**On screen:** Study page, setup 1 table; pan once across it. Caption: "Not a ranking."

**Voice-over:**
> We tested fifteen models in two setups. Models from five providers were fooled by at least one
> hidden lie, and without the lie, those same purchases stayed within budget.

## 0:50 – 1:40 · Live, end to end

Film one fresh run on the hosted demo. Sign in to `/mandate/` and `/operator` before recording, so
the password prompt is not on camera. Pay through the PayPal link here: the saved wallet is the
next beat.

| Time | On screen | Voice-over |
|---|---|---|
| 0:50 | `/mandate/`: approve "blue rain jacket, size M, at most $150" and touch Touch ID | "The buyer sets the limit and signs it with a passkey. Nobody can loosen it later." |
| 0:58 | `/operator`: Claude Haiku 4.5, the buyer's request "Keep it under $150", **Send the agent shopping**. The timeline streams: pages read and signed, the decision, the seal, the order | "A real agent shops. Black Box records what it reads and seals the record into the PayPal order." |
| 1:08 | **Pay with PayPal as the buyer**: the sandbox buyer pays $240.00 | "The buyer pays two forty." |
| 1:13 | sandbox.paypal.com as the buyer: Activity → the payment → Report a problem → item not as described | "And disputes it, like any purchase." |
| 1:20 | Hosted Recordings: the run at the top, tagged **Live run**; open it: **MERCHANT · rule 2**, the hidden note highlighted | "PayPal's webhook wakes Black Box. No one at the keyboard. Code checks sixteen facts: the shop's own signed page hid a lie about this jacket, the agent read it, the budget was broken. Rule two: the shop pays." |
| 1:32 | The case's PayPal panel: `accept-claim` REFUND, HTTP 200, the refund ID; then the buyer's sandbox Activity showing the refund | "Black Box accepts the claim, and the buyer has the money back, in PayPal's own activity page." |

Cut the 3 to 12 minutes the sandbox takes to report the dispute. If the sandbox misbehaves on the
day, film P09 instead: the same chain, settled live on 7 November 2026 (PP-R-XXC-10197051).

## 1:40 – 2:00 · The agent paid by itself

**On screen:** P08 case page: **MERCHANT**, the case story ("the buyer had saved their PayPal
wallet once, so the agent could pay without an approval screen"), and the PayPal panel with the
$240.00 refund.

**Voice-over:**
> Real agents don't stop at a checkout screen. Here the buyer had saved their PayPal wallet once,
> and the agent paid by itself. The buyer disputed a charge they never saw, and Black Box still
> refunded them from the shop.

## 2:00 – 2:25 · Fair to both sides

**On screen (2:00):** P06: **AGENT**; the PayPal panel shows $90.00 back to the buyer and the
payout line "operator → merchant · batch ZLR5F7QM5LBQ4 SUCCESS".

**Voice-over:**
> When nothing misled the agent, it's the agent's fault. The buyer gets the ninety dollars over
> budget back, and the operator repays the merchant through PayPal Payouts.

**On screen (2:13):** P04: **USER**, then the evidence section with the note sent to PayPal.

**Voice-over:**
> And when the agent did what it was told, the sale stands: Black Box sends PayPal the evidence.

## 2:25 – 2:40 · Why trust it

**On screen:** Lab with P09. Tick "Merchant: edit one letter of the stored product page", **Run the
engine**. The banner: "Unchanged: MERCHANT · rule 2 … Now: NEEDS A HUMAN · rule 1", with the failed
checks.

**Voice-over:**
> Code decides; an AI can only ask for a person. Flip one byte of the record and the fingerprint
> breaks: no automatic refund, a person decides.

## 2:40 – 2:50 · Close

**On screen:** the site's front page, the recorder playing back P09; caption with the demo URL,
`black-box-342881585799.us-central1.run.app/demo`.

**Voice-over:**
> Every agent purchase should leave a black box. Try it yourself: the link is below.

---

## Shot list (in filming order)

1. **Site, P09** (`/bench/P09/`): top (verdict, gauge), the timeline's Order row, section 2 (both
   views and the agent's reason).
2. **Site, Study** (`/study/`): setup 1 table, one slow pan.
3. **Live run** on the hosted demo:
   1. `/mandate/` with Touch ID.
   2. `/operator`: Haiku 4.5, the buyer's request, the streamed timeline and the result.
   3. The PayPal link: the sandbox buyer pays $240.00.
   4. sandbox.paypal.com: the dispute form, "item not as described".
   5. Hosted Recordings: the new **Live run** card, then its case page (verdict, hidden note).
   6. The case's PayPal panel with the refund.
   7. The buyer's sandbox Activity showing the refund.
4. *(fallback only)* **Site, P09**: the PayPal panel with the refund.
5. **Site, P08** (`/bench/P08/`): verdict, the case story, the PayPal panel.
6. **Site, P06** (`/bench/P06/`): verdict and the PayPal panel with the payout line.
7. **Site, P04** (`/bench/P04/`): verdict and the evidence section.
8. **Hosted lab** (`/lab?case=P09`): "edit one letter" ticked, Run, the banner and the checks.
9. **Site front page**: the recorder playing back P09, for the close.

**Tips**
- Film at 1440 px wide or more, so the two views sit side by side.
- The live run is all hosted: nothing to start on your machine.
- Never show `.env`, `operator/.env` or `killtest/.env` on screen.
