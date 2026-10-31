import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../findings.mjs';
import { checkMandate } from '../mandate.mjs';
import { planAction, toValue } from '../actions.mjs';
import { decide, VERDICT } from '../verdict.mjs';

// ---------- findings ----------

const hidden = (over = {}) => ({
  textHash: 'h1', concealedInReadChannel: true, namesPurchasedItem: true, contradictsListing: true, inModelInput: true,
  signedByMerchant: true, selfContained: true, thirdPartySigned: false, ...over,
});

test('findings: a merchant-signed hidden text meeting all five conditions', () => {
  const s = summarize([hidden()]);
  assert.deepEqual(s.conditions, { concealedInReadChannel: true, namesPurchasedItem: true, contradictsListing: true, inModelInput: true, merchantOwned: true });
  assert.equal(s.decisiveText, 'h1');
  assert.equal(s.unattributedHiddenText, false);
});

test('findings: conditions split across two texts do not add up to five', () => {
  const a = hidden({ textHash: 'a', inModelInput: false });      // names the SKU, never read
  const b = hidden({ textHash: 'b', namesPurchasedItem: false }); // read, does not name the SKU
  const s = summarize([a, b]);
  assert.equal(Object.values(s.conditions).every(Boolean), false);
});

test('findings: a third-party signature makes the text not the merchant\'s', () => {
  const s = summarize([hidden({ thirdPartySigned: true })]);
  assert.equal(s.conditions.merchantOwned, false);
  assert.equal(s.unattributedHiddenText, true);
});

test('findings: concealment that depends on an unsigned file or script is unattributed', () => {
  const s = summarize([hidden({ selfContained: false })]);
  assert.equal(s.conditions.merchantOwned, false);
  assert.equal(s.unattributedHiddenText, true);
});

test('findings: hidden text the agent never read is not a signal', () => {
  const s = summarize([hidden({ thirdPartySigned: true, inModelInput: false })]);
  assert.equal(s.unattributedHiddenText, false);
});

test('findings: accurate hidden product data is not a contradiction', () => {
  const s = summarize([hidden({ contradictsListing: false })]);
  assert.equal(s.conditions.contradictsListing, false);
  assert.equal(s.conditions.merchantOwned, true);
  assert.equal(s.unattributedHiddenText, false);
});

test('findings: no hidden text at all', () => {
  const s = summarize([]);
  assert.equal(Object.values(s.conditions).some(Boolean), false);
  assert.equal(s.unattributedHiddenText, false);
});

test('(e) findings: agent-directed merchant text that does not contradict is unclassified', () => {
  assert.equal(summarize([hidden({ contradictsListing: false, addressesAgents: true })]).unclassifiedAgentText, true);
  // Accurate product data, not addressed to agents (R12, the honest-price cases): no signal.
  assert.equal(summarize([hidden({ contradictsListing: false, addressesAgents: false })]).unclassifiedAgentText, false);
  // A contradicting text is classified: it is a MERCHANT condition, not this signal.
  assert.equal(summarize([hidden({ addressesAgents: true })]).unclassifiedAgentText, false);
  // Not the merchant's, not about this item, or never read: not this signal.
  for (const over of [{ thirdPartySigned: true }, { namesPurchasedItem: false }, { inModelInput: false }]) {
    assert.equal(summarize([hidden({ contradictsListing: false, addressesAgents: true, ...over })]).unclassifiedAgentText, false, JSON.stringify(over));
  }
});

test('(e) unclassified agent text sends a broken mandate to a person, never to the agent', () => {
  const facts = { hashesMatch: true, signaturesValid: true, keyOnShopDomain: true, payeeMatches: true, signedBeforeOrder: true, mandateSigned: true,
    mandateBroken: true, concealedInReadChannel: true, namesPurchasedItem: true, contradictsListing: false, inModelInput: true, merchantOwned: true,
    aiInjectionFlag: false, unattributedHiddenText: false, unclassifiedAgentText: false };
  assert.equal(decide(facts).verdict, VERDICT.AGENT);
  assert.deepEqual([decide({ ...facts, unclassifiedAgentText: true }).verdict, decide({ ...facts, unclassifiedAgentText: true }).rule], [VERDICT.HUMAN, 4]);
});

// ---------- mandate ----------

const MANDATE = {
  item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } },
  maxTotalCents: 15000, currency: 'USD',
  notBefore: '2026-10-11T00:00:00Z', notAfter: '2026-10-18T00:00:00Z', signedShopsOnly: true,
};
const buy = (over = {}) => ({
  sku: 'RJ-BLUE-M', category: 'Rain Jacket', attributes: { color: 'Blue', size: 'M' },
  totalCents: 12900, currency: 'USD', at: '2026-10-12T10:00:00Z', pageSigned: true, ...over,
});

test('mandate: within scope', () => {
  assert.deepEqual(checkMandate(MANDATE, buy()), { broken: false, violations: [], outOfScopeCents: 0 });
});

test('mandate: the demo case, a $240 jacket against a $150 cap, puts $90 out of scope', () => {
  const r = checkMandate(MANDATE, buy({ sku: 'RJ-PREMIUM-BLUE-M', totalCents: 24000 }));
  assert.equal(r.broken, true);
  assert.deepEqual(r.violations.map((v) => v.code), ['OVER_CAP']);
  assert.equal(r.outOfScopeCents, 9000);
});

test('mandate: the wrong item puts the whole payment out of scope', () => {
  for (const over of [
    { attributes: { color: 'red', size: 'M' } },
    { attributes: { color: 'blue' } },
    { category: 'umbrella' },
    { currency: 'EUR' },
    { at: '2026-10-20T00:00:00Z' },
    { pageSigned: false },
  ]) {
    const r = checkMandate(MANDATE, buy({ ...over, totalCents: 16000 }));
    assert.equal(r.broken, true, JSON.stringify(over));
    assert.equal(r.outOfScopeCents, 16000, JSON.stringify(over));
  }
});

test('mandate: exactly at the cap is within scope', () => {
  assert.equal(checkMandate(MANDATE, buy({ totalCents: 15000 })).broken, false);
});

test('mandate: a bad timestamp throws instead of passing', () => {
  assert.throws(() => checkMandate(MANDATE, buy({ at: 'yesterday' })), TypeError);
});

// ---------- actions ----------

const CTX = { capturedCents: 24000, outOfScopeCents: 9000, mandateCapCents: 15000, signedPriceCents: 24000, currency: 'USD' };

test('actions: amounts are formatted for PayPal without floating point', () => {
  assert.equal(toValue(9000), '90.00');
  assert.equal(toValue(5), '0.05');
  assert.equal(toValue(1999), '19.99');
  assert.throws(() => toValue(10.5), RangeError);
  assert.throws(() => toValue(-1), RangeError);
});

test('actions: the verdict-by-reason table', () => {
  const plan = (v, r, c = CTX) => planAction(v, r, c);
  const UA = 'UNAUTHORISED', NAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', IA = 'INCORRECT_AMOUNT';

  assert.equal(plan(VERDICT.USER, UA).action, 'provide-evidence');
  assert.equal(plan(VERDICT.USER, NAD).action, 'provide-evidence');
  assert.equal(plan(VERDICT.USER, IA).action, 'provide-evidence');

  assert.deepEqual(
    { a: plan(VERDICT.AGENT, UA).action, r: plan(VERDICT.AGENT, UA).refundCents, p: plan(VERDICT.AGENT, UA).payout.amountCents },
    { a: 'make-offer', r: 9000, p: 9000 });
  assert.equal(plan(VERDICT.AGENT, NAD).action, 'none');
  assert.equal(plan(VERDICT.AGENT, IA).action, 'accept-claim-partial');
  assert.equal(plan(VERDICT.AGENT, IA).refundCents, 9000);

  assert.equal(plan(VERDICT.MERCHANT, UA).action, 'accept-claim');
  assert.equal(plan(VERDICT.MERCHANT, NAD).action, 'accept-claim');
  assert.equal(plan(VERDICT.MERCHANT, NAD).refundCents, 24000);

  for (const r of [UA, NAD, IA]) assert.equal(plan(VERDICT.HUMAN, r).action, 'none');
});

test('actions: MERCHANT on an incorrect-amount dispute refunds at least the amount over the cap', () => {
  const IA = 'INCORRECT_AMOUNT';
  const plan = (c) => planAction(VERDICT.MERCHANT, IA, { ...CTX, ...c });
  // Captured exactly the signed $240, above the $150 cap: the $90 over the cap.
  assert.deepEqual([plan({}).action, plan({}).refundCents], ['accept-claim-partial', 9000]);
  // Captured $240 against a signed $180: the larger of $60 over the price and $90 over the cap.
  assert.equal(plan({ signedPriceCents: 18000 }).refundCents, 9000);
  // Captured $240 against a signed $100: $140 over the price beats $90 over the cap.
  assert.equal(plan({ signedPriceCents: 10000 }).refundCents, 14000);
  // Over the price by the whole capture: a full refund.
  assert.deepEqual([plan({ signedPriceCents: 0 }).action, plan({ signedPriceCents: 0 }).refundCents], ['accept-claim', 24000]);
  // Captured within the cap and equal to the signed price: nothing to refund, so a person decides.
  assert.equal(plan({ capturedCents: 12900, signedPriceCents: 12900 }).action, 'none');
  // An honest merchant never owes less than this: AGENT refunds the same $90 here.
  assert.equal(planAction(VERDICT.AGENT, IA, CTX).refundCents, plan({}).refundCents);
});

test('actions: out-of-scope reasons never trigger an action, whatever the verdict', () => {
  for (const r of ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'DUPLICATE_TRANSACTION', 'CREDIT_NOT_PROCESSED', 'OTHER']) {
    for (const v of Object.values(VERDICT)) assert.equal(planAction(v, r, CTX).action, 'none', `${v} ${r}`);
  }
});

test('actions: an AGENT verdict with nothing out of scope escalates instead of refunding zero', () => {
  assert.equal(planAction(VERDICT.AGENT, 'UNAUTHORISED', { ...CTX, outOfScopeCents: 0 }).action, 'none');
});
