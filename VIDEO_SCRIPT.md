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
| Judges (P09, P06, P04 side by side, with PayPal's IDs and a re-run button) | Site `/judge/` |
| Study | Site `/study/` |
| Lab (opened from the judges' page) | Hosted `/lab/run?case=P09&t=edit-page` |

---

## 0:00 – 0:15 · Hook

**On screen:** the site's front page, from the top: the headline rises line by line and the
recorder beside it plays P09 back (the hidden note, $240 bought on a $150 budget, **MERCHANT**,
$240 refunded from the shop).

**Voice-over:**
> My AI agent paid two hundred and forty dollars on a hundred-and-fifty-dollar budget. Who pays:
> me, the shop, or the app running the AI?

## 0:15 – 0:35 · What a person sees, what the agent read

**On screen:** P09, section 2 "What the shopping agent saw": the customer's view at $240.00 next to
the AI's view with the highlighted JSON-LD note "... bringing the final total to $119.00", then
the agent's stated reason. Click **"+ Compare the full page with exactly what the AI was given"**
to open the signed page beside the exact model input.

**Voice-over:**
> A person sees two hundred and forty dollars. The agent also reads a note hidden in the page's
> data, for AI shoppers only: your total is one nineteen. It believed it. Black Box sealed both:
> every signed page, byte for byte, and the exact text the model received.

## 0:35 – 0:50 · Does it happen?

**On screen:** Study page. Hover the **"Not a ranking"** chip so its caveat shows, then pan once
across the setup 1 grid.

**Voice-over:**
> We tested fifteen models in two setups. Models from five providers were fooled by at least one
> hidden lie, and without the lie, those same purchases stayed within budget.

## 0:50 – 1:40 · Live, end to end

Film one fresh run on the hosted demo. Sign in to `/mandate/` and `/operator` before recording, so
the password prompt is not on camera. Pay through the PayPal link here: the saved wallet is the
next beat.

| Time | On screen | Voice-over |
|---|---|---|
| 0:50 | `/mandate/`: approve "blue rain jacket, size M, at most $150" and touch Touch ID | "The buyer sets the limit and signs it with a passkey. Nobody can raise it later." |
| 0:58 | `/operator`: Claude Haiku 4.5, the buyer's request "Keep it under $150", **Send the agent shopping**. The timeline streams: pages read and signed, the decision, the seal, the order | "A real agent shops. Black Box records what it reads and seals the record into the PayPal payment." |
| 1:08 | **Pay with PayPal as the buyer**: the sandbox buyer pays $240.00 | "The buyer pays two forty." |
| 1:13 | sandbox.paypal.com as the buyer: Activity → the payment → Report a problem → item not as described | "And disputes it, like any purchase." |
| 1:20 | Hosted Recordings: the run at the top, tagged **Live run**; open it: the plate at the top shows a blinking red **● Live run** cell, then **MERCHANT · rule 2** and the hidden note highlighted | "PayPal's webhook wakes Black Box. No one at the keyboard. Code checks sixteen facts: the shop's own signed page hid a lie about this jacket, the agent read it, the budget was broken. Rule two: the shop pays." |
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

**On screen (2:00):** the judges' page (`/judge/`): the three cards side by side, red **The shop
pays**, amber **The shopping app pays**, blue **The sale stands**. Move to card B: **AGENT · rule
5**, then its PayPal tape: "PayPal refunds the buyer $90.00" and "Payouts: the shopping app repays
the shop $90.00 · batch ZLR5F7QM5LBQ4 SUCCESS".

**Voice-over:**
> When nothing misled the agent, the app running it is at fault. The buyer gets the ninety dollars
> over budget back, and the app repays the shop through PayPal Payouts.

**On screen (2:13):** card C: **USER · rule 6**, "Black Box sends provide-evidence · HTTP 200",
"PayPal has the checked note and the record; no money moved". Then up to card A's **Bound to the
payment** block: the record SHA-256 and "PayPal order custom_id ✓ the same".

**Voice-over:**
> And when the agent did what it was told, the sale stands: Black Box sends PayPal the evidence.
> Every case carries PayPal's own IDs, and a fingerprint that matches the payment.

## 2:25 – 2:40 · Why trust it

**On screen:** on card A of the judges' page, click **Change one letter of the page →**. The hosted
lab opens on P09 with that change made, and the banner reads: "Unchanged: MERCHANT · rule 2 …
Now: NEEDS A HUMAN · rule 1", with the failed checks (hashesMatch, signaturesValid,
signedBeforeOrder).

**Voice-over:**
> Code decides; an AI can only ask for a person. Change one letter of the record and the
> fingerprint breaks: no automatic refund, a person decides.

## 2:40 – 2:50 · Close

**On screen:** the site's front page, scrolled to "How it works": the three panels play in turn
(the budget fills and Touch ID stamps, the pages drop into the PayPal payment, the outcome cycles
through "The shop pays", "The shopping app pays", "The sale stands"). Caption with the judges' page,
`4kinc.github.io/black-box/judge`, and the demo, `black-box-342881585799.us-central1.run.app/demo`.

**Voice-over:**
> Black Box is for PayPal, shops, and the apps that run AI shoppers. Every agent purchase should
> leave a black box. See all three outcomes yourself, and re-run the engine, at the link below.

---

## Shot list (in filming order)

1. **Site front page**, from the top: the headline and the recorder playing back P09.
2. **Site, P09** (`/bench/P09/`): section 2 (both views and the agent's reason), then open
   "Compare the full page with exactly what the AI was given".
3. **Site, Study** (`/study/`): hover "Not a ranking", then one slow pan across the setup 1 grid.
4. **Live run** on the hosted demo:
   1. `/mandate/` with Touch ID.
   2. `/operator`: Haiku 4.5, the buyer's request, the streamed timeline and the result.
   3. The PayPal link: the sandbox buyer pays $240.00.
   4. sandbox.paypal.com: the dispute form, "item not as described".
   5. Hosted Recordings: the new **Live run** card, then its case page (the red **● Live run**
      cell in the plate, the verdict, the hidden note).
   6. The case's PayPal panel with the refund.
   7. The buyer's sandbox Activity showing the refund.
5. *(fallback only)* **Site, P09**: the PayPal panel with the refund.
6. **Site, P08** (`/bench/P08/`): verdict, the case story, the PayPal panel.
7. **Site, judges' page** (`/judge/`): the three cards together; card B's PayPal tape with the $90
   refund and the payout; card C's evidence lines; card A's record hash and "custom_id ✓ the same".
8. **Hosted lab**, from card A's **Change one letter of the page →**: the banner and the failed
   checks.
9. **Site front page**, "How it works": one full cycle of the three panels (9 seconds), for the
    close.

**Tips**
- Film at 1440 px wide or more, so the two views sit side by side.
- The live run is all hosted: nothing to start on your machine.
- The front page's animations play once on load (the headline and the recorder) and loop in "How
  it works"; reload the page to film the opening again.
- Never show `.env`, `operator/.env` or `killtest/.env` on screen.
