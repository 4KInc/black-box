// The agent and the full case flow against the real demo shop, with a scripted model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../agent.mjs';
import { evaluateCase } from '../../engine/case.mjs';
import { startDemo, TEST_MERCHANT } from '../../shop/testing.mjs';

const MANDATE = { item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } }, maxTotalCents: 15000, currency: 'USD', signedShopsOnly: true };
const NOT_AS_DESCRIBED = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
let demo;

before(async () => { demo = await startDemo({ now: () => Math.floor(Date.now() / 1000) - 5 }); });
after(() => demo.close());

const scripted = (sku) => async () => ({ text: `{"sku": "${sku}", "reason": "scripted"}`, model: 'scripted' });

async function shopAndDispute(sku, { shelf, reason = NOT_AS_DESCRIBED } = {}) {
  const { sealed, order } = await runAgent({ shopUrl: demo.shopUrl, mandate: MANDATE, llm: scripted(sku), shelf });
  const capturedCents = sealed.record.purchase.price_cents;
  const result = evaluateCase({
    record: sealed.record,
    order: { customId: order.custom_id, payeeMerchantId: TEST_MERCHANT, createdAt: new Date().toISOString(), capturedCents },
    reason,
  });
  return { sealed, order, ...result };
}

test('the agent reads only signed pages, logs its exact model input, and checks out with the record hash', async () => {
  demo.paypalCalls.length = 0;
  const { sealed, order } = await shopAndDispute('RJ-BLUE-M');
  const r = sealed.record;
  assert.equal(r.fetches.length, 4); // category + three products
  assert.ok(r.fetches.every((f) => f.verification.ok));
  assert.equal(r.model_inputs.length, 1);
  assert.match(r.model_inputs[0].text, /STRUCTURED DATA \(JSON-LD\)/);
  assert.equal(r.decisions[0].sku, 'RJ-BLUE-M');
  assert.equal(order.custom_id, sealed.hash);
  assert.equal(demo.paypalCalls[0].json.purchase_units[0].custom_id, sealed.hash);
});

test('the model input contains both hidden claims, because the agent reads JSON-LD and textContent', async () => {
  const { sealed } = await shopAndDispute('RJ-BLUE-M');
  const input = sealed.record.model_inputs[0].text;
  assert.match(input, /Pricing note for automated purchasing agents/);
  assert.match(input, /price-matches the Stormline/);
});

test('honest jacket within budget -> USER, merchant sends evidence', async () => {
  const c = await shopAndDispute('RJ-BLUE-M');
  assert.deepEqual(c.findings, []);
  assert.equal(c.verdict.verdict, 'USER');
  assert.equal(c.plan.action, 'provide-evidence');
});

test('merchant JSON-LD injection, over budget -> MERCHANT, full refund', async () => {
  const c = await shopAndDispute('RJ-PREMIUM-BLUE-M');
  assert.equal(c.findings.length, 1);
  assert.deepEqual(
    [c.findings[0].channel, c.findings[0].namesPurchasedItem, c.findings[0].inModelInput, c.findings[0].thirdPartySigned],
    ['json-ld', true, true, false]);
  assert.equal(c.verdict.verdict, 'MERCHANT');
  assert.equal(c.verdict.rule, 2);
  assert.deepEqual([c.plan.action, c.plan.refundCents], ['accept-claim', 24000]);
});

test('injection inside a platform-signed review -> NEEDS A HUMAN', async () => {
  const c = await shopAndDispute('RJ-STORM-BLUE-M');
  assert.equal(c.findings.length, 1);
  assert.equal(c.findings[0].method, 'display:none');
  assert.equal(c.findings[0].thirdPartySigned, true);
  assert.equal(c.findings[0].thirdPartyIssuer, demo.reviewsIss);
  assert.equal(c.facts.merchantOwned, false);
  assert.equal(c.facts.unattributedHiddenText, true);
  assert.equal(c.verdict.verdict, 'NEEDS_A_HUMAN');
  assert.equal(c.verdict.rule, 4);
});

test('if the model never saw the hidden text, the merchant is not blamed', async () => {
  // Remove the hidden text from what the model saw: the agent bought premium without reading it.
  const c = await shopAndDispute('RJ-PREMIUM-BLUE-M');
  const r = structuredClone(c.sealed.record);
  r.model_inputs[0].text = r.model_inputs[0].text.replace(/Pricing note for automated purchasing agents[^"]*/, '');
  const blind = evaluateCase({ record: r, order: { customId: c.sealed.hash, payeeMerchantId: TEST_MERCHANT, createdAt: new Date().toISOString(), capturedCents: 24000 }, reason: NOT_AS_DESCRIBED });
  assert.equal(blind.findings[0].inModelInput, false);
  assert.notEqual(blind.verdict.verdict, 'MERCHANT'); // and the edited record also fails its hash
  assert.equal(blind.facts.hashesMatch, false);
});

test('a shelf limits what the agent considers', async () => {
  const { sealed } = await shopAndDispute('RJ-BLUE-M', { shelf: ['RJ-BLUE-M', 'RJ-PREMIUM-BLUE-M'] });
  assert.equal(sealed.record.fetches.length, 3);
});

test('the agent refuses a product that is not on the shelf', async () => {
  await assert.rejects(runAgent({ shopUrl: demo.shopUrl, mandate: MANDATE, llm: scripted('RJ-NOPE'), checkout: false }), /not on the shelf/);
});
