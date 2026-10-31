// The bench's signing key is public (committed for tests). Nothing that serves pages or keys may
// publish it, and no judge may trust it outside the bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH_KEY_ID, isBenchKey, loadBenchKey } from '../keys.mjs';
import { buildCase, CASES, ENROLMENT } from '../cases.mjs';
import { judge } from '../../replay/cases.mjs';
import { createReplay } from '../../replay/server.mjs';
import { createShop } from '../../shop/server.mjs';
import { createReviewPlatform } from '../../shop/reviews.mjs';
import { startDemo } from '../../shop/testing.mjs';
import { generateKey } from '../../lib/sig.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const kids = async (url) => {
  const r = await fetch(url);
  return r.ok ? ((await r.json()).keys ?? []).map((k) => k.kid) : [];
};
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

test('the bench key file holds the bench key and says it is test-only', () => {
  assert.equal(isBenchKey(loadBenchKey()), true);
  assert.match(readFileSync(join(ROOT, 'bench', 'keys', 'TEST-ONLY-bench-signing-key.jwk.json'), 'utf8'), /TEST ONLY/);
});

test('the shop and the review platform never publish the bench key id', async () => {
  const demo = await startDemo();
  try {
    assert.ok(!(await kids(`${demo.shopUrl}/.well-known/jwks.json`)).includes(BENCH_KEY_ID));
    assert.ok(!(await kids(`${demo.reviewsIss}/.well-known/jwks.json`)).includes(BENCH_KEY_ID));
  } finally { demo.close(); }
});

test('the shop and the review platform refuse to start with the bench key', () => {
  const k = loadBenchKey();
  const shop = { reviewsJwk: generateKey(), reviewsIssuer: 'http://reviews.test', merchantId: 'M', origin: 'http://shop.test' };
  assert.throws(() => createShop({ ...shop, shopJwk: k }), /TEST-ONLY bench key/);
  assert.throws(() => createShop({ ...shop, shopJwk: generateKey(), reviewsJwk: k }), /TEST-ONLY bench key/);
  assert.throws(() => createReviewPlatform({ jwk: k }), /TEST-ONLY bench key/);
});

test('the local shop keys, if any, are not the bench key', () => {
  const dir = join(ROOT, 'shop', '.keys');
  for (const f of existsSync(dir) ? readdirSync(dir) : []) assert.equal(isBenchKey(JSON.parse(readFileSync(join(dir, f), 'utf8'))), false, f);
});

test('the hosted replay and lab serve no key set with the bench key id', async () => {
  const server = createReplay({ root: ROOT });
  const base = await listen(server);
  try {
    assert.ok(!(await kids(`${base}/.well-known/jwks.json`)).includes(BENCH_KEY_ID));
  } finally { server.close(); }
});

test('a record carrying the bench key fails keyOnShopDomain unless the bench vouches for it', () => {
  const load = (name) => JSON.parse(readFileSync(join(ROOT, 'fixtures', 'recorded', name), 'utf8'));
  const enrolled = load(ENROLMENT);
  const enrolment = (payerId) => (payerId === enrolled.payer_id ? enrolled.credentials : []);
  const c = buildCase(CASES.find((d) => d.id === 'E01'), load);
  const live = judge(c, { enrolment });
  assert.equal(live.facts.keyOnShopDomain, false);
  assert.deepEqual([live.verdict.verdict, live.verdict.rule], ['NEEDS_A_HUMAN', 1]);
  assert.ok(live.integrityProblems.some((p) => /TEST-ONLY bench key/.test(p)));
  const bench = judge(c, { enrolment, trustBenchKey: true });
  assert.deepEqual([bench.facts.keyOnShopDomain, bench.verdict.verdict], [true, 'MERCHANT']);
});
