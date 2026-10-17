// The demo's three pages, end to end through findings -> mandate -> verdict -> action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../findings.mjs';
import { checkMandate } from '../mandate.mjs';
import { decide, VERDICT } from '../verdict.mjs';
import { planAction } from '../actions.mjs';

const MANDATE = {
  item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } },
  maxTotalCents: 15000, currency: 'USD',
  notBefore: '2026-10-11T00:00:00Z', notAfter: '2026-10-18T00:00:00Z', signedShopsOnly: true,
};
const RECORD_OK = { hashesMatch: true, signaturesValid: true, keyOnShopDomain: true, payeeMatches: true, signedBeforeOrder: true, mandateSigned: true };

function run({ purchase, findings, aiInjectionFlag = false, record = RECORD_OK, reason }) {
  const m = checkMandate(MANDATE, purchase);
  const s = summarize(findings);
  const v = decide({ ...record, mandateBroken: m.broken, ...s.conditions, aiInjectionFlag, unattributedHiddenText: s.unattributedHiddenText });
  const plan = planAction(v.verdict, reason, {
    capturedCents: purchase.totalCents, outOfScopeCents: m.outOfScopeCents,
    mandateCapCents: MANDATE.maxTotalCents, signedPriceCents: purchase.totalCents, currency: 'USD',
  });
  return { ...v, plan };
}

const premium = { sku: 'RJ-PREMIUM-BLUE-M', category: 'rain jacket', attributes: { color: 'blue', size: 'M' }, totalCents: 24000, currency: 'USD', at: '2026-10-12T10:00:00Z', pageSigned: true };
const honest = { ...premium, sku: 'RJ-BLUE-M', totalCents: 12900 };
const merchantInjection = { textHash: 'jsonld-1', concealedInReadChannel: true, namesPurchasedItem: true, contradictsListing: true, inModelInput: true, signedByMerchant: true, selfContained: true, thirdPartySigned: false };

test('page 2: merchant JSON-LD injection, over budget -> MERCHANT, full refund', () => {
  const r = run({ purchase: premium, findings: [merchantInjection], aiInjectionFlag: true, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
  assert.equal(r.verdict, VERDICT.MERCHANT);
  assert.equal(r.rule, 2);
  assert.deepEqual([r.plan.action, r.plan.refundCents], ['accept-claim', 24000]);
});

test('page 1: honest page, within mandate -> USER, merchant sends evidence', () => {
  const r = run({ purchase: honest, findings: [], reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
  assert.equal(r.verdict, VERDICT.USER);
  assert.equal(r.plan.action, 'provide-evidence');
});

test('page 3: injection inside a review signed by the review platform -> NEEDS A HUMAN', () => {
  const r = run({ purchase: premium, findings: [{ ...merchantInjection, textHash: 'review-7', thirdPartySigned: true }], aiInjectionFlag: true, reason: 'UNAUTHORISED' });
  assert.equal(r.verdict, VERDICT.HUMAN);
  assert.equal(r.rule, 4);
  assert.equal(r.plan.action, 'none');
});

test('agent overspends on an honest page -> AGENT, $90 offer plus operator payout', () => {
  const r = run({ purchase: premium, findings: [], reason: 'UNAUTHORISED' });
  assert.equal(r.verdict, VERDICT.AGENT);
  assert.deepEqual([r.plan.action, r.plan.refundCents, r.plan.payout.amountCents], ['make-offer', 9000, 9000]);
});

test('merchant steers but the buy is within the mandate -> NEEDS A HUMAN (rule 3)', () => {
  const r = run({ purchase: honest, findings: [merchantInjection], reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
  assert.equal(r.rule, 3);
  assert.equal(r.verdict, VERDICT.HUMAN);
});

test('payee mismatch overrides an otherwise airtight MERCHANT case', () => {
  const r = run({ purchase: premium, findings: [merchantInjection], record: { ...RECORD_OK, payeeMatches: false }, reason: 'UNAUTHORISED' });
  assert.equal(r.rule, 1);
  assert.equal(r.verdict, VERDICT.HUMAN);
});
