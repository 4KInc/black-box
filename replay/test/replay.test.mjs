import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paypalFromLog } from '../cases.mjs';
import { highlight } from '../page.mjs';
import { createReplay } from '../server.mjs';

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

test('the recorded page is served sandboxed, and unknown cases are 404', async () => {
  const r = await fetch(`${base}/case/${LIVE}/page`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal((await fetch(`${base}/case/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/case/../../etc/passwd`)).status, 404);
});

test('a fixture with third-party hidden text is NEEDS A HUMAN', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /NEEDS A HUMAN<\/span> <span class="k">rule 4/);
});
