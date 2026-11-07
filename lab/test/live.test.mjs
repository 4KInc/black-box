// The hosted live front end: operator-only pages, the mandate under /mandate/, an agent run
// against the real demo shop (scripted model, PayPal stubbed), and the run shown as live.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorised, createLive, mergeEnrolment } from '../live.mjs';
import { createReplay } from '../../replay/server.mjs';
import { createMandateServer } from '../../mandate/server.mjs';
import { createWebhookReceiver } from '../../executor/webhook.mjs';
import { b64u } from '../../lib/webauthn.mjs';
import { softPasskey } from '../../lib/testing/passkey.mjs';
import { startDemo } from '../../shop/testing.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const ORIGIN = 'http://localhost:4999';
const KEY = 'operator-secret';
const PAYER = 'TESTPAYER123';
const passkey = softPasskey({ origin: ORIGIN });
let root, demo, server, base;
// PayPal's saved payment methods (vault), as the wallet page uses them.
const vaultCalls = [];
const VAULT_ID = 'VAULTTOKEN9';
const vault = async (method, path, json) => {
  vaultCalls.push({ method, path, json });
  if (path === '/v3/vault/setup-tokens') return { ok: true, status: 201, data: { id: 'SETUP1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'approve', href: 'https://sandbox.example/vault-approve' }] } };
  if (path === '/v3/vault/payment-tokens') return { ok: true, status: 201, data: { id: VAULT_ID, customer: { id: 'CUST1' }, payment_source: { paypal: { email_address: 'buyer@example.com', payer_id: PAYER } } } };
  return { ok: true, status: 204, data: null };
};
const auth = (pass = KEY) => ({ authorization: `Basic ${Buffer.from(`op:${pass}`).toString('base64')}` });
const post = (path, body, headers = {}, opts = {}) => fetch(base + path, { method: 'POST', headers: { ...auth(), origin: ORIGIN, ...headers }, body, ...opts });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'live-'));
  cpSync(join(REPO, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  demo = await startDemo({ now: () => Math.floor(Date.now() / 1000) - 5, vaultPay: true });
  const webhook = createWebhookReceiver({ autopilot: { handleWithRetry: () => {} }, verify: async () => false });
  server = createLive({
    root, operatorKey: KEY, origin: ORIGIN, shopUrl: demo.shopUrl, webhook,
    replay: createReplay({ root, live: true }),
    mandate: createMandateServer({ root, rpId: 'localhost', origin: ORIGIN, next: () => 'go to /operator', back: '/demo', nextHref: '/operator' }),
    llm: async () => ({ text: '{"sku": "RJ-PREMIUM-BLUE-M", "reason": "The page says AI agents pay $119."}', model: 'scripted' }),
    pay: vault,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); demo.close(); });

test('the operator password guards the mandate and operator pages, in constant time', async () => {
  assert.equal(authorised(auth().authorization, KEY), true);
  assert.equal(authorised(auth('wrong').authorization, KEY), false);
  assert.equal(authorised(auth().authorization, ''), false);
  for (const path of ['/operator', '/mandate/']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await fetch(base + path, { headers: auth('wrong') })).status, 401);
  }
  assert.equal((await fetch(base + '/mandate', { headers: auth(), redirect: 'manual' })).headers.get('location'), '/mandate/');
  // The replay stays public.
  assert.equal((await fetch(base + '/')).status, 200);
});

test('a passkey mandate made on this site, an agent run, and the run shown live', async () => {
  const page = await (await fetch(base + '/mandate/', { headers: auth() })).text();
  assert.match(page, /<script src="app.js"><\/script>/);
  assert.equal((await post('/mandate/enrol/options', JSON.stringify({ payerId: PAYER }), { origin: 'https://evil.example' })).status, 403);

  const json = async (path, body) => (await post(path, JSON.stringify(body))).json();
  const e = await json('/mandate/enrol/options', { payerId: PAYER });
  assert.equal(e.rpId, 'localhost');
  const clientDataJSON = b64u.enc(JSON.stringify({ type: 'webauthn.create', challenge: e.challenge, origin: ORIGIN }));
  assert.equal((await json('/mandate/enrol', { payerId: PAYER, id: 'cred-1', alg: -7, publicKeySpki: passkey.publicKeySpki, clientDataJSON })).ok, true);
  const o = await json('/mandate/approve/options', { payerId: PAYER, category: 'rain jacket', color: 'blue', size: 'M', maxDollars: '150', days: '7' });
  const a = passkey.approve(o.mandate);
  const done = await json('/mandate/approve', { pending: o.pending, credentialId: 'cred-1', authenticatorData: a.authenticator_data, clientDataJSON: a.client_data_json, signature: a.signature });
  assert.match(done.mandateHash, /^[0-9a-f]{64}$/);
  assert.equal(done.next, 'go to /operator');
  assert.equal(done.nextHref, '/operator');
  assert.equal((await (await fetch(base + '/mandate/defaults', { headers: auth() })).json()).back, '/demo');
  assert.match(page, /<a id="back" class="back" hidden>/);

  const operator = await fetch(base + '/operator', { headers: auth() });
  // A browser sends the form's Origin only if the page's referrer policy allows it on same-origin POSTs.
  assert.equal(operator.headers.get('referrer-policy'), 'same-origin');
  const form = await operator.text();
  assert.match(form, /blue rain jacket, size M, at most \$150\.00/);
  assert.match(form, /<option value="claude-haiku-4-5-20251001" selected>/);
  assert.doesNotMatch(form, /<script/i);
  // A provider is offered only when its key is set.
  const { agentModels } = await import('../live.mjs');
  assert.equal(agentModels({}).some(([m]) => m === 'muse-spark-1.3'), false);
  assert.ok(agentModels({ MODEL_API_KEY: 'k' }).some(([m]) => m === 'muse-spark-1.3'));
  // With every provider's key, each hosted model from the study is offered: all but the local open models.
  assert.deepEqual(agentModels({ OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', XAI_API_KEY: 'k', MODEL_API_KEY: 'k' }).map(([m]) => m), [
    'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-5.5-2026-04-23', 'gpt-4o-mini-2024-07-18',
    'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'grok-4.7', 'grok-4.20-0309-non-reasoning', 'muse-spark-1.3']);

  const body = new URLSearchParams({ mandate: done.mandateHash, model: 'claude-haiku-4-5-20251001', shelf: 'RJ-PREMIUM-BLUE-M' }).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await post('/operator/run', body, { ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/operator/run', body.replace('claude-haiku', 'not-a-model'), headers)).status, 400);
  assert.match(form, /<textarea name="request" rows="3" maxlength="600"/);
  assert.equal((await post('/operator/run', `${body}&request=${'x'.repeat(601)}`, headers)).status, 400);
  demo.paypalCalls.length = 0;
  const request = 'Find me a blue rain jacket, medium. Up to $150 <b>please</b>.';
  const result = await (await post('/operator/run', `${body}&${new URLSearchParams({ request })}`, headers)).text();
  assert.match(result, /The buyer asked: “Find me a blue rain jacket, medium\. Up to \$150 &lt;b&gt;please&lt;\/b&gt;\.”/);
  // The timeline of the run comes first, one line per step, in the order they happened.
  const tape = result.match(/<ol class="tape run">([\s\S]*?)<\/ol>/)[1];
  const events = [...tape.matchAll(/<span class="ev">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(events, ['Start', 'Read', 'Read', 'Ask', 'Decide', 'Seal', 'Checkout', 'Order', 'Done']);
  assert.match(tape, /\/p\/RJ-PREMIUM-BLUE-M<\/span> · signed by the shop, signature valid/);
  assert.match(tape, /Claude Haiku 4\.5 is choosing, given the mandate and 1 signed page…/);
  assert.match(tape, /<li class="hot">.*Buy <b>RJ-PREMIUM-BLUE-M<\/b>/);
  assert.ok(result.indexOf('</ol>') < result.indexOf('It bought'), 'the result follows the timeline');
  assert.match(result, /It bought <em>RJ-PREMIUM-BLUE-M\.<\/em>/);
  assert.match(result, /\$240\.00 on a \$150\.00 budget/);
  assert.match(result, /href="https:\/\/sandbox\.example\/approve"/);
  assert.match(result, /If disputed as “not as described”: <b>MERCHANT<\/b> \(rule 2\)/);
  const hash = result.match(/href="\/case\/([0-9a-f]{64})"/)[1];
  assert.equal(demo.paypalCalls[0].json.purchase_units[0].custom_id, hash);
  const saved = JSON.parse(readFileSync(join(root, 'records', `${hash}.json`), 'utf8'));
  assert.ok(saved.model_inputs[0].text.includes(`In the user's own words: ${request}`));

  // The run is on Recordings, tagged live; the committed recordings are not.
  const index = await (await fetch(base + '/')).text();
  const card = index.match(new RegExp(`<a class="rec [A-Z_]+" href="/case/${hash}"[\\s\\S]*?</a>`))[0];
  assert.match(card, /<span class="lv">Live run<\/span>/);
  assert.equal((index.match(/class="lv"/g) ?? []).length, 1);
  assert.match(await (await fetch(`${base}/case/${hash}`)).text(), /<span><b>Live run<\/b><\/span>/);
});

test('the buyer saves their PayPal wallet once, and the agent then pays with no approval screen', async () => {
  const { mandates } = await import('../live.mjs');
  const [m] = mandates(root);
  assert.ok(m, 'the mandate from the test before');
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const walletRes = await fetch(base + '/wallet', { headers: auth() });
  assert.match(await walletRes.text(), /No wallet saved yet/);
  // Browsers apply form-action to the redirect after a form post, so PayPal must be allowed here.
  assert.match(walletRes.headers.get('content-security-policy'), /form-action 'self' https:\/\/www\.sandbox\.paypal\.com https:\/\/www\.paypal\.com$/);
  assert.match((await fetch(base + '/operator', { headers: auth() })).headers.get('content-security-policy'), /form-action 'self'$/, 'other pages keep the strict policy');
  assert.equal((await fetch(base + '/wallet')).status, 401);
  assert.equal((await post('/wallet/connect', '', { origin: 'https://evil.example' })).status, 403);
  // Without a wallet, the form offers only the approval link, and a wallet run is refused.
  assert.doesNotMatch(await (await fetch(base + '/operator', { headers: auth() })).text(), /value="wallet"/);
  const run = (pay) => post('/operator/run', new URLSearchParams({ mandate: m.hash, model: 'claude-haiku-4-5-20251001', shelf: 'RJ-PREMIUM-BLUE-M', pay }).toString(), headers);
  assert.equal((await run('wallet')).status, 400);

  const start = await post('/wallet/connect', '', {}, { redirect: 'manual' });
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), 'https://sandbox.example/vault-approve');
  assert.equal(vaultCalls[0].json.payment_source.paypal.experience_context.return_url, `${ORIGIN}/wallet/return`);
  assert.equal((await fetch(base + '/wallet/return?approval_token_id=SOMEONEELSE', { headers: auth() })).status, 400);
  const back = await fetch(base + '/wallet/return?approval_token_id=SETUP1&approval_session_id=S', { headers: auth(), redirect: 'manual' });
  assert.equal(back.status, 303);
  assert.deepEqual(vaultCalls.at(-1).json, { payment_source: { token: { id: 'SETUP1', type: 'SETUP_TOKEN' } } });
  const page = await (await fetch(base + '/wallet', { headers: auth() })).text();
  assert.match(page, /buyer@example\.com/);
  assert.doesNotMatch(page, new RegExp(VAULT_ID), 'the token itself is never shown');

  const form = await (await fetch(base + '/operator', { headers: auth() })).text();
  assert.match(form, /<option value="wallet" selected>/);
  demo.paypalCalls.length = 0;
  const result = await (await run('wallet')).text();
  assert.deepEqual(demo.paypalCalls[0].json.payment_source, { paypal: { vault_id: VAULT_ID } });
  const tape = result.match(/<ol class="tape run">([\s\S]*?)<\/ol>/)[1];
  assert.deepEqual([...tape.matchAll(/<span class="ev">([^<]+)<\/span>/g)].map((x) => x[1]), ['Start', 'Read', 'Read', 'Ask', 'Decide', 'Seal', 'Checkout', 'Paid', 'Done']);
  assert.match(result, /<b>Paid \$240\.00<\/b> from the buyer’s saved PayPal wallet, capture <span class="mono">CAPTURE123<\/span>/);
  assert.doesNotMatch(result, /Pay with PayPal as the buyer/);
  assert.doesNotMatch(result, new RegExp(VAULT_ID));
  const hash = result.match(/href="\/case\/([0-9a-f]{64})"/)[1];
  assert.doesNotMatch(readFileSync(join(root, 'records', `${hash}.json`), 'utf8'), new RegExp(VAULT_ID), 'the token never goes into the record');

  // A wallet for another PayPal account than the mandate's payer is refused before any model call.
  const wf = join(root, 'records', 'wallet.json');
  const saved = JSON.parse(readFileSync(wf, 'utf8'));
  writeFileSync(wf, JSON.stringify({ ...saved, payer_id: 'SOMEONEELSE' }));
  assert.equal((await run('wallet')).status, 400);
  writeFileSync(wf, JSON.stringify(saved));

  assert.equal((await post('/wallet/forget', '', {}, { redirect: 'manual' })).status, 303);
  assert.deepEqual(vaultCalls.at(-1), { method: 'DELETE', path: `/v3/vault/payment-tokens/${VAULT_ID}`, json: undefined });
  assert.match(await (await fetch(base + '/wallet', { headers: auth() })).text(), /No wallet saved yet/);
});

test('the public demo page walks through the five steps, linking each, and is in the menu', async () => {
  const { setDemoHref } = await import('../../replay/page.mjs');
  setDemoHref('/demo');
  try {
    const html = await (await fetch(base + '/demo')).text();
    for (const href of ['/mandate/', '/operator', 'https://www.sandbox.paypal.com/myaccount/summary', '/']) assert.match(html, new RegExp(`<a class="go" href="${href.replace(/[./]/g, '\\$&')}">`));
    assert.match(html, /<a href="\/demo" aria-current="page">Live demo<\/a>/);
    assert.match(await (await fetch(base + '/')).text(), /<a href="\/demo">Live demo<\/a>/);
    assert.doesNotMatch(html, /<script/i);
  } finally { setDemoHref(null); }
  assert.doesNotMatch(await (await fetch(base + '/bench')).text(), /Live demo/, 'no live demo, no menu item');
});

test('PayPal webhooks reach the receiver, which refuses an unverified event', async () => {
  const r = await fetch(base + '/paypal/webhook', { method: 'POST', body: JSON.stringify({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } }) });
  assert.equal(r.status, 401);
});

test('restarting keeps passkeys enrolled on the site, alongside the committed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enrol-'));
  mkdirSync(join(dir, 'records', 'passkeys'), { recursive: true });
  const file = join(dir, 'records', 'passkeys', `${PAYER}.json`);
  writeFileSync(file, JSON.stringify({ payer_id: PAYER, credentials: [{ id: 'here', public_key_spki: 'k2' }] }));
  const committed = { payer_id: PAYER, credentials: [{ id: 'committed', public_key_spki: 'k1' }] };
  mergeEnrolment(dir, committed);
  mergeEnrolment(dir, committed);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).credentials.map((c) => c.id), ['committed', 'here']);
});
