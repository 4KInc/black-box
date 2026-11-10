// Where the money stands, apart from the verdict: derived from the PayPal side of a case (an
// execution log, or a committed live fixture), shown on the case page and in the explorer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settlement } from '../settlement.mjs';
import { paypalFromLog } from '../cases.mjs';
import { casePage } from '../page.mjs';
import { runBench } from '../../bench/bench.mjs';
import { CASES } from '../../bench/cases.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const live = (name) => JSON.parse(readFileSync(join(REPO, 'fixtures', 'recorded', `${name}.paypal.json`), 'utf8'));

// Every committed live dispute, with the settlement it shows.
const LIVE = [
  ['P05', 'live-agent-left-for-human', 'AGENT', 'open', null, null, 'Not settled: nothing sent to PayPal'],
  ['P06', 'live-agent-partial-refund', 'AGENT', 'settled', 'done', 'done', 'Fully settled: $90.00 refunded to the buyer (sandbox); $90.00 repaid to the shop by the shopping app (sandbox)'],
  ['R11', 'live-autopilot-merchant-refund', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
  ['P03', 'live-fullchain-passkey', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
  ['P07', 'live-gpt4omini-merchant-refund', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
  ['P09', 'live-haiku-request-merchant-refund', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
  ['R03', 'live-haiku45-merchant-refund', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
  ['P04', 'live-user-evidence', 'USER', 'settled', null, null, 'Evidence sent, no money moves: PayPal decides the dispute'],
  ['P08', 'live-wallet-merchant-refund', 'MERCHANT', 'settled', 'done', null, 'Fully settled: $240.00 refunded to the buyer (sandbox)'],
];

test('every live fixture: its settlement, with sandbox amounts labelled as such', () => {
  for (const [id, name, verdict, state, buyer, merchant, text] of LIVE) {
    assert.deepEqual(settlement(live(name), verdict), { state, buyer, merchant, text }, id);
    if (buyer) assert.match(text, /\(sandbox\)/, id);
  }
  // Every live fixture is covered.
  assert.deepEqual(LIVE.map(([id]) => id).sort(), CASES.filter((d) => d.paypal).map((d) => d.id).sort());
});

test('every live case page shows its settlement, and its verdict, rule and PayPal outcome are as before', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-settle-'));
  try {
    cpSync(join(REPO, 'fixtures'), join(root, 'fixtures'), { recursive: true });
    const enrolment = JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', 'passkey-enrolment.json'), 'utf8'));
    mkdirSync(join(root, 'records', 'passkeys'), { recursive: true });
    writeFileSync(join(root, 'records', 'passkeys', `${enrolment.payer_id}.json`), JSON.stringify(enrolment));
    const results = runBench(root);
    // The PayPal panel's headline: the amount back to the buyer, or that evidence was sent.
    const OUTCOME = { P04: 'Evidence sent', P05: null, P06: '$90.00' };
    for (const [id, , verdict, , , , text] of LIVE) {
      const r = results.find((x) => x.def.id === id);
      assert.equal(r.pass, true, id);
      assert.equal(r.got.verdict, verdict, id);
      const html = casePage({ ...r.c, benchResult: r }, r.j);
      assert.ok(html.includes(`<span>Settlement</span><b class="settle `), id);
      assert.ok(html.includes(text.replaceAll("'", '&#39;')), id);
      const outcome = id in OUTCOME ? OUTCOME[id] : '$240.00';
      if (outcome) assert.match(html, new RegExp(`<div class="amt">${outcome.replace(/[$.]/g, '\\$&')}<small>`), id);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A minimal execution log, as the executor writes it.
const dispute = { step: 'get dispute', status: 200, response: { dispute_id: 'PP-D-S', reason: 'INCORRECT_AMOUNT', create_time: '2026-11-01T00:00:00Z', disputed_transactions: [{ custom: 'h', seller: { merchant_id: 'M1' }, gross_amount: { value: '240.00', currency_code: 'USD' } }] } };
const attempt = { step: 'attempt', actionId: 'PP-D-S:accept-claim', kind: 'accept-claim', action: 'accept-claim REFUND', payloadHash: 'x', at: '2026-11-01T00:01:00Z' };
const accepted = { step: 'accept-claim REFUND', actionId: 'PP-D-S:accept-claim', payloadHash: 'x', status: 200, at: '2026-11-01T00:01:01Z', request: { refund_amount: { value: '90.00', currency_code: 'USD' } } };
const credited = { step: 'get dispute (after)', status: 200, response: { status: 'UNDER_REVIEW', money_movements: [{ affected_party: 'BUYER', type: 'CREDIT', reason: 'DISPUTE_SETTLEMENT', amount: { value: '90.00', currency_code: 'USD' } }] } };
const payoutTry = { step: 'payout-attempt', actionId: 'PP-D-S:payout:1', payloadHash: 'p', at: '2026-11-01T00:02:00Z' };
const payoutSent = { step: 'payout', actionId: 'PP-D-S:payout:1', payloadHash: 'p', status: 201, at: '2026-11-01T00:02:01Z', response: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } }, request: { items: [{ receiver: 'M1', amount: { value: '90.00', currency: 'USD' } }] } };
const batch = (item) => ({ step: 'get payout', status: 200, at: '2026-11-01T00:03:00Z', response: { batch_header: { payout_batch_id: 'B1', batch_status: item === 'SUCCESS' ? 'SUCCESS' : 'PENDING' }, items: [{ payout_item_id: 'I1', transaction_status: item }] } });
const of = (entries, verdict = 'AGENT') => settlement(paypalFromLog(entries), verdict);

test('from the execution log: refund pending, then done; the repayment pending, failed, then done', () => {
  assert.equal(of([dispute]).state, 'open');
  assert.deepEqual([of([dispute, attempt, accepted]).state, of([dispute, attempt, accepted]).buyer], ['refund-pending', 'pending']);
  const refunded = [dispute, attempt, accepted, credited];
  assert.equal(of(refunded, 'MERCHANT').state, 'settled');
  assert.deepEqual([of(refunded).state, of(refunded).merchant], ['repayment-pending', 'pending']);
  assert.deepEqual([of([...refunded, payoutTry, payoutSent]).state, of([...refunded, payoutTry, payoutSent, batch('PENDING')]).state], ['repayment-pending', 'repayment-pending']);
  const failed = of([...refunded, payoutTry, payoutSent, batch('FAILED')]);
  assert.deepEqual([failed.state, failed.merchant], ['repayment-failed', 'failed']);
  assert.match(failed.text, /failed, nothing was paid/);
  const done = of([...refunded, payoutTry, payoutSent, batch('SUCCESS')]);
  assert.deepEqual([done.state, done.buyer, done.merchant], ['settled', 'done', 'done']);
  assert.match(done.text, /\$90\.00 repaid to the shop by the shopping app \(sandbox\)/);
});

test('from the execution log: an action or payout whose outcome is unknown says so', () => {
  assert.equal(of([dispute, attempt], 'MERCHANT').state, 'unknown');
  assert.equal(of([dispute, attempt, { ...accepted, status: 503 }], 'MERCHANT').state, 'unknown');
  assert.equal(of([dispute, attempt, { step: 'reconciled', actionId: attempt.actionId, kind: 'accept-claim', result: 'succeeded' }, credited], 'MERCHANT').state, 'settled');
  assert.equal(of([dispute, attempt, accepted, credited, payoutTry]).state, 'unknown');
  assert.match(of([dispute, attempt]).text, /Outcome unknown/);
});

test('a simulated bench dispute has no settlement', () => {
  assert.equal(settlement({ disputeId: 'BENCH-R01-NAD' }, 'USER'), null);
  assert.equal(settlement(null, 'USER'), null);
});
