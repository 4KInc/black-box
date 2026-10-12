import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '../../lib/canonical.mjs';
import { generateKey, jwks } from '../../lib/sig.mjs';
import { loadRecord, recordFacts, recordHash, Recorder, saveRecord } from '../recorder.mjs';
import { startDemo, TEST_MERCHANT } from '../../shop/testing.mjs';
import { decide } from '../../engine/verdict.mjs';

const NOW = 1791800000;                                   // shop signing time
const ORDER_AT = new Date((NOW + 60) * 1000).toISOString(); // order created a minute later
const MANDATE = { item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } }, maxTotalCents: 15000, currency: 'USD', signedShopsOnly: true };
let demo;

before(async () => { demo = await startDemo({ now: () => NOW }); });
after(() => demo.close());

async function shopRun() {
  const rec = new Recorder({ mandate: MANDATE, now: () => '2026-10-12T10:00:00.000Z' });
  await rec.fetchSigned(`${demo.shopUrl}/`);
  const p = await rec.fetchSigned(`${demo.shopUrl}/p/RJ-PREMIUM-BLUE-M`);
  rec.modelInput('choose', 'Mandate: blue rain jacket, size M, up to $150.\nPage: Summit Pro Shell ...');
  rec.decision('choose', { action: 'buy', sku: 'RJ-PREMIUM-BLUE-M', model_output: 'Buying Summit Pro.' });
  rec.purchase({ sku: 'RJ-PREMIUM-BLUE-M', page_index: p.index, price_cents: 24000 });
  return { rec, sealed: rec.seal() };
}

const order = (hash, over = {}) => ({ customId: hash, payeeMerchantId: TEST_MERCHANT, createdAt: ORDER_AT, ...over });
const clone = (x) => structuredClone(x);

// ---------- canonical JSON ----------

test('canonical JSON ignores key order and rejects values that could hash ambiguously', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), canonicalize({ a: [true, null, 'x'], b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 'x' }), '{"a":"x","b":1}');
  for (const bad of [1.5, NaN, Infinity, { a: undefined }, () => 1, 2 ** 60]) assert.throws(() => canonicalize(bad), TypeError);
});

// ---------- recording ----------

test('the recorder verifies each page against the key on the page\'s own domain', async () => {
  const { sealed } = await shopRun();
  for (const f of sealed.record.fetches) {
    assert.equal(f.verification.ok, true, f.path);
    assert.equal(f.shop_keys.url, `${demo.shopUrl}/.well-known/jwks.json`);
  }
  assert.match(sealed.hash, /^[0-9a-f]{64}$/);
});

test('third-party spans are recorded with the issuer\'s keys', async () => {
  const rec = new Recorder({ mandate: MANDATE });
  const p = await rec.fetchSigned(`${demo.shopUrl}/p/RJ-STORM-BLUE-M`);
  assert.equal(p.spans.length, 1);
  assert.equal(p.spans[0].ok, true);
  assert.equal(p.spans[0].iss, demo.reviewsIss);
  rec.purchase({ sku: 'RJ-STORM-BLUE-M', page_index: 0, price_cents: 18500 });
  assert.ok(rec.seal().record.issuer_keys[demo.reviewsIss].keys.length > 0);
});

test('sealing is final: same hash every time, and no more writes', async () => {
  const { rec, sealed } = await shopRun();
  assert.equal(rec.seal().hash, sealed.hash);
  assert.throws(() => rec.modelInput('late', 'x'), /sealed/);
  assert.throws(() => rec.decision('late', {}), /sealed/);
});

test('a record cannot be sealed without a purchase', () => {
  assert.throws(() => new Recorder({ mandate: MANDATE }).seal(), /nothing was purchased/);
});

test('saving and loading does not change the record hash', async () => {
  const { sealed } = await shopRun();
  const dir = mkdtempSync(join(tmpdir(), 'bb-rec-'));
  try {
    saveRecord(dir, sealed);
    assert.equal(recordHash(loadRecord(dir, sealed.hash)), sealed.hash);
  } finally { rmSync(dir, { recursive: true }); }
});

// ---------- dispute-time facts ----------

test('an untouched record gives all five integrity facts', async () => {
  const { sealed } = await shopRun();
  const { facts, signedMerchantId, problems } = recordFacts(sealed.record, order(sealed.hash));
  assert.deepEqual(facts, { hashesMatch: true, signaturesValid: true, keyOnShopDomain: true, payeeMatches: true, signedBeforeOrder: true });
  assert.equal(signedMerchantId, TEST_MERCHANT);
  assert.deepEqual(problems, []);
});

test('editing any part of the record breaks the hash binding', async () => {
  const { sealed } = await shopRun();
  const r = clone(sealed.record);
  r.model_inputs[0].text = r.model_inputs[0].text.replace('$150', '$500');
  assert.equal(recordFacts(r, order(sealed.hash)).facts.hashesMatch, false);
});

test('a forged page fails the signature even if the forger fixes up the stored hashes', async () => {
  const { sealed } = await shopRun();
  const r = clone(sealed.record);
  const f = r.fetches[1];
  const forged = Buffer.from(f.body_b64, 'base64').toString('utf8').replace('AI shopping assistants', 'Shoppers');
  f.body_b64 = Buffer.from(forged).toString('base64');
  f.body_sha256 = (await import('node:crypto')).createHash('sha256').update(forged).digest('hex');
  const { facts } = recordFacts(r, order(recordHash(r)));   // even with custom_id "matching" the forgery
  assert.equal(facts.signaturesValid, false);
  assert.equal(facts.hashesMatch, true);
});

test('a different PayPal payee breaks payeeMatches', async () => {
  const { sealed } = await shopRun();
  assert.equal(recordFacts(sealed.record, order(sealed.hash, { payeeMerchantId: 'SOMEONEELSE' })).facts.payeeMatches, false);
});

test('a signature newer than the order breaks signedBeforeOrder', async () => {
  const { sealed } = await shopRun();
  const early = new Date((NOW - 60) * 1000).toISOString();
  assert.equal(recordFacts(sealed.record, order(sealed.hash, { createdAt: early })).facts.signedBeforeOrder, false);
  assert.equal(recordFacts(sealed.record, order(sealed.hash, { createdAt: 'whenever' })).facts.signedBeforeOrder, false);
});

test('a key set from another domain breaks keyOnShopDomain', async () => {
  const { sealed } = await shopRun();
  const r = clone(sealed.record);
  r.fetches[1].shop_keys.url = 'http://keys.elsewhere.test/.well-known/jwks.json';
  assert.equal(recordFacts(r, order(recordHash(r))).facts.keyOnShopDomain, false);
});

test('an unsigned page is recorded, flagged, and leaves signaturesValid false', async () => {
  const html = '<html><meta name="paypal-merchant-id" content="MCYKQUXGB936U"><p>unsigned</p></html>';
  const fakeFetch = async (url) => url.endsWith('/jwks.json')
    ? new Response(JSON.stringify(jwks(generateKey())), { headers: { 'content-type': 'application/json' } })
    : new Response(html, { headers: { 'content-type': 'text/html' } });
  const rec = new Recorder({ mandate: MANDATE, fetch: fakeFetch });
  const p = await rec.fetchSigned('http://unsigned.test/p/X');
  assert.equal(p.verification.reason, 'unsigned');
  rec.purchase({ sku: 'X', page_index: 0, price_cents: 100 });
  const s = rec.seal();
  assert.equal(recordFacts(s.record, order(s.hash)).facts.signaturesValid, false);
});

test('record facts feed the verdict engine: a tampered record can only give NEEDS A HUMAN', async () => {
  const { sealed } = await shopRun();
  const rest = { mandateBroken: true, concealedInReadChannel: true, namesPurchasedItem: true, inModelInput: true, merchantOwned: true, aiInjectionFlag: true, unattributedHiddenText: false };
  assert.equal(decide({ ...recordFacts(sealed.record, order(sealed.hash)).facts, ...rest }).verdict, 'MERCHANT');
  const bad = recordFacts(sealed.record, order(sealed.hash, { payeeMerchantId: 'SOMEONEELSE' })).facts;
  assert.equal(decide({ ...bad, ...rest }).verdict, 'NEEDS_A_HUMAN');
});
