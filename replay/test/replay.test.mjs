import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paypalFromLog } from '../cases.mjs';
import { highlight } from '../page.mjs';
import { createReplay } from '../server.mjs';
import { recordHash } from '../../recorder/recorder.mjs';
import { runBench } from '../../bench/bench.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const LIVE = '61c79d751ce7311d6eeca9bcf83079ddeb7f7f354a13b4c2fcc29673f3fe8a8e';
let root, server, base;

before(async () => {
  // Only the committed fixtures, so the test does not depend on local runs in records/.
  root = mkdtempSync(join(tmpdir(), 'replay-'));
  cpSync(join(REPO, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  server = createReplay({ root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

test('the PayPal side keeps IDs, amounts and statuses, and drops buyer and seller identities', () => {
  const p = paypalFromLog([
    { step: 'get dispute', status: 200, response: { dispute_id: 'PP-D-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', create_time: '2026-10-13T06:40:03Z',
      disputed_transactions: [{ custom: 'abc', seller_transaction_id: 'CAP1', gross_amount: { value: '240.00', currency_code: 'USD' },
        buyer: { email: 'buyer@example.com', name: 'John Doe' }, seller: { email: 'seller@example.com', merchant_id: 'M1', name: 'Test Store' } }] } },
    { step: 'get order', status: 200, response: { id: 'O1', create_time: '2026-10-13T06:18:53Z', payer: { email_address: 'buyer@example.com' } } },
    { step: 'accept-claim REFUND', status: 200, at: '2026-10-13T06:46:50Z', response: {} },
    { step: 'get dispute (after)', status: 200, response: { status: 'UNDER_REVIEW',
      money_movements: [{ affected_party: 'BUYER', type: 'CREDIT', reason: 'DISPUTE_SETTLEMENT', amount: { value: '240.00', currency_code: 'USD' } }],
      refund_details: { transactions: [{ id: 'R1', gross_amount: { value: '240.00', currency_code: 'USD' } }] } } },
  ]);
  assert.equal(p.customId, 'abc');
  assert.equal(p.payeeMerchantId, 'M1');
  assert.equal(p.captured.cents, 24000);
  assert.equal(p.after.refundTransactions[0].id, 'R1');
  assert.doesNotMatch(JSON.stringify(p), /@|John|Test Store/);
});

test('highlight marks hidden text across whitespace differences and escapes everything', () => {
  const { html, count } = highlight('a <b>\n final   total to $119.00 </b>', ['final total to $119.00']);
  assert.equal(count, 1);
  assert.match(html, /<mark id="hidden">final   total to \$119\.00<\/mark>/);
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('the case list shows the live case as MERCHANT with the refund', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await r.text();
  assert.match(html, new RegExp(`/case/${LIVE}`));
  assert.match(html, /\$240\.00 refunded to the buyer/);
  // Filter chips, CSS only: each card carries what the chips filter on.
  assert.match(html, /<a class="rec MERCHANT" href="\/case\/[0-9a-f]+" data-v="MERCHANT" data-src="paypal" data-m="claude">/);
  assert.match(html, /main:has\(#fr-v-MERCHANT:checked\) \.rec:not\(\[data-v~="MERCHANT"\]\)\{display:none\}/);
  assert.match(html, /<label for="fr-src-paypal">PayPal dispute<small>\d+<\/small><\/label>/);
  // A purchase nobody disputed says so, and what would happen if it were.
  assert.match(html, /<span>Not disputed<\/span><span>If disputed as “not as described”: <b class="if">(a person decides|refund \$[\d.,]+|defend the sale)<\/b><\/span>/);
});

test('the live case page replays the verdict, the hidden text and what PayPal did, with no scripts', async () => {
  const html = await (await fetch(`${base}/case/${LIVE}`)).text();
  assert.match(html, /class="v">MERCHANT</);
  assert.match(html, /rule 2 of 6/);
  assert.match(html, /<mark id="hidden">[^<]*agent-channel credit/);
  assert.match(html, /7XA326891K201841N/);
  assert.match(html, /Over budget: paid \$240\.00, cap \$150\.00, \$90\.00 over/);
  assert.doesNotMatch(html, /<script/i);
});

test('a case explains itself in plain words, from the case\'s own facts', async () => {
  const html = await (await fetch(`${base}/case/${LIVE}`)).text();
  assert.equal((html.match(/<p class="plain">/g) ?? []).length, 4);
  assert.match(html, /<p class="story">The shop hid a note only the AI would read, saying the price was \$119\.00\. The AI spent \$240\.00 on a \$150\.00 budget\. The shop planted the lie, so the shop refunds the buyer\./);
  assert.match(html, /<li class="MERCHANT fired"><span class="n">2<\/span><span class="tag">MERCHANT<\/span><span>Over the limit, after the AI read the shop&#39;s own hidden lie about this item\.<\/span>/);
  assert.match(html, /\$240\.00 refunded/);
});

test('every check lamp has a plain-word tooltip', async () => {
  const html = await (await fetch(`${base}/case/${LIVE}`)).text();
  const tips = [...html.matchAll(/<div class="lampc [^"]*" tabindex="0" data-tip="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tips.length, 15);
  assert.equal(new Set(tips).size, 15);
  assert.ok(tips.some((t) => t.startsWith('Nobody edited this recording.')));
  assert.doesNotMatch(html, /class="lampc[^>]*title=/);
  // Each lamp is its own stacking context (its warm-up animation), so the one showing a tip is lifted.
  assert.match(html, /\.lampc:hover,\.lampc:focus\{z-index:6\}/);
});

test('fonts are served from the replay itself, and only known font files', async () => {
  const r = await fetch(`${base}/fonts/B612-400.woff2`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(`${base}/fonts/..%2F..%2Fpackage.json`)).status, 404);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /font-src 'self'/);
});

test('the recorded page is served sandboxed, and unknown cases are 404', async () => {
  const r = await fetch(`${base}/case/${LIVE}/page`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal((await fetch(`${base}/case/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/case/../../etc/passwd`)).status, 404);
});

test('a fixture with third-party hidden text is NEEDS A HUMAN', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<span class="vv">NEEDS A HUMAN<\/span><span class="rl">rule 4/);
});

test('an exported live payout shows on the AGENT case it repaid, and its verdict stays the same', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-payout-'));
  cpSync(join(REPO, 'fixtures'), join(dir, 'fixtures'), { recursive: true });
  const side = join(dir, 'fixtures', 'recorded', 'live-agent-partial-refund.paypal.json');
  const payout = { at: '2026-11-01T12:00:00Z', httpStatus: 201, debugId: 'd1', batchId: 'BATCH123', status: 'SUCCESS', itemId: 'ITEM1', itemStatus: 'SUCCESS',
    amount: { cents: 9000, currency: 'USD' }, from: 'agent-operator', to: 'MCYKQUXGB936U' };
  writeFileSync(side, JSON.stringify({ ...JSON.parse(readFileSync(side, 'utf8')), payout }));
  const hash = recordHash(JSON.parse(readFileSync(join(dir, 'fixtures', 'recorded', 'live-agent-partial-refund.record.json'), 'utf8')));
  const s = createReplay({ root: dir });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${s.address().port}/case/${hash}`)).text();
    assert.match(html, /operator → merchant · batch BATCH123 SUCCESS · item SUCCESS/);
    assert.match(html, /paid the merchant \$90\.00 back through PayPal Payouts/);
    const p06 = runBench(dir).find((r) => r.def.id === 'P06');
    assert.deepEqual([p06.pass, p06.got.verdict, p06.got.rule, p06.got.action, p06.got.refundCents], [true, 'AGENT', 5, 'accept-claim-partial', 9000]);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
