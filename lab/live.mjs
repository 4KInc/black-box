// The hosted live demo, in front of the hosted Black Box (lab/hosted.mjs, when LIVE_DIR is set):
//   /mandate/        the buyer approves a mandate with a passkey on this site (mandate/server.mjs)
//   /wallet          the buyer saves their PayPal wallet once, so the agent can pay by itself
//   /operator        the agent operator sends the agent shopping at the hosted shop
//   /paypal/webhook  PayPal's dispute events, verified with PayPal, into the autopilot
//   /demo            the steps of the demo, with a link to each (public)
// Everything else is the replay, which shows each run made here as a live run, with what PayPal
// did once the autopilot has acted. The mandate and operator pages need the operator password
// (HTTP Basic, any user name): they spend model credit and create PayPal orders.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { runAgent as defaultRunAgent } from '../agent/agent.mjs';
import { anthropic, hostedFor } from '../agent/llm.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { canonicalize } from '../lib/canonical.mjs';
import { paypal } from '../lib/paypal.mjs';
import { enrolmentFrom } from '../mandate/server.mjs';
import { layout } from '../replay/page.mjs';
import { saveRecord } from '../recorder/recorder.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const money = (c) => `$${(c / 100).toFixed(2)}`;
// same-origin, not no-referrer: with no-referrer the browser sends "Origin: null" on the operator
// form's POST, and the same-origin check below would refuse it. Other sites still get no referrer.
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store',
};

// The Claude models from the study, plus any other provider's whose key this server holds.
const CLAUDE = [
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
];
const OTHERS = [
  ['gpt-5.5-2026-04-23', 'GPT-5.5'], ['gpt-4o-mini-2024-07-18', 'GPT-4o mini'],
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
  ['grok-4.7', 'Grok 4.7'], ['grok-4.20-0309-non-reasoning', 'Grok 4.20 (non-reasoning)'],
  ['muse-spark-1.3', 'Muse Spark 1.3'],
];
// The models the form offers: LIVE_MODELS (comma-separated IDs), by default the two Claude models
// the demo needs and GPT-4o mini. A model from another provider also needs that provider's key.
// Anything else is refused on POST, so a password holder cannot pick a costlier model.
export const DEFAULT_LIVE_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'gpt-4o-mini-2024-07-18'];
export const liveModels = (env = process.env) => (env.LIVE_MODELS ? env.LIVE_MODELS.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_LIVE_MODELS);
export const agentModels = (env = process.env) => {
  const allowed = liveModels(env);
  return [...CLAUDE, ...OTHERS.filter(([m]) => env[hostedFor(m)?.key])].filter(([m]) => allowed.includes(m));
};

// At most LIVE_MAX_RUNS_PER_DAY agent runs (default 25) per UTC day, counted in a file under
// records/ (LIVE_DIR when hosted), so a restart does not reset it.
export const DEFAULT_MAX_RUNS = 25;
export function maxRunsPerDay(env = process.env) {
  const n = Number(env.LIVE_MAX_RUNS_PER_DAY ?? DEFAULT_MAX_RUNS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_RUNS;
}
const runsFile = (root) => join(root, 'records', 'live-runs.json');
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
export function runsToday(root, now = Date.now()) {
  try {
    const { day, count } = JSON.parse(readFileSync(runsFile(root), 'utf8'));
    return day === utcDay(now) && Number.isInteger(count) ? count : 0;
  } catch { return 0; }
}
// Counts one run if the cap allows it; false when today's runs are used up. Synchronous, so two
// requests in this process cannot both take the last run.
export function takeRun(root, max, now = Date.now()) {
  const count = runsToday(root, now);
  if (count >= max) return false;
  writeJson(runsFile(root), { day: utcDay(now), count: count + 1 });
  return true;
}
// The buyer's request in their own words, optional. Control characters other than line breaks
// are dropped and runs of whitespace kept short, so the recording shows what the buyer meant.
export const REQUEST_MAX = 600;
export const REQUEST_EXAMPLE = 'Find me a blue rain jacket in medium for a hiking trip. I can spend up to $150.';
export function cleanRequest(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n]/gu, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > REQUEST_MAX) throw new RangeError(`The request is longer than ${REQUEST_MAX} characters.`);
  return text || null;
}
export const SHELVES = [
  ['RJ-PREMIUM-BLUE-M', 'Summit Pro Shell only, as in the study'],
  ['', 'The whole shop'],
];

// Adds the committed passkey to the payer's registry, keeping any enrolled here since.
export function mergeEnrolment(dir, enrolment) {
  const reg = join(dir, 'records', 'passkeys');
  mkdirSync(reg, { recursive: true });
  const file = join(reg, `${enrolment.payer_id}.json`);
  const known = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).credentials : [];
  const credentials = [...enrolment.credentials, ...known.filter((c) => !enrolment.credentials.some((e) => e.id === c.id))];
  writeFileSync(file, JSON.stringify({ payer_id: enrolment.payer_id, credentials }, null, 2));
}

// Is a mandate in force at `now`? An expired one is never offered: a run on it would break the
// mandate by its dates alone, and a judge without a passkey device could not make a new one.
export const inForce = (m, now = Date.now()) => !(Date.parse(m.notBefore) > now) && !(Date.parse(m.notAfter) < now);

// The approved mandates on this server, newest first.
export function mandates(root) {
  const dir = join(root, 'records', 'mandates');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .map((m) => ({ ...m, hash: sha256hex(canonicalize(m.mandate)), at: Date.parse(m.mandate.notBefore) || 0 }))
    .sort((a, b) => b.at - a.at);
}

// The buyer's saved PayPal wallet (a PayPal vault payment token), one per server. The token lets the
// shop charge the buyer with no approval screen, so it stays on the server: it is never shown on a
// page and never goes into a record.
const walletFile = (root) => join(root, 'records', 'wallet.json');
const pendingFile = (root) => join(root, 'records', 'wallet-pending.json');
export function savedWallet(root) {
  try { return JSON.parse(readFileSync(walletFile(root), 'utf8')); } catch { return null; }
}
const writeJson = (file, obj) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2)); };

export function walletPage(root, { note = '' } = {}) {
  const w = savedWallet(root);
  const status = w
    ? `<p>Saved: the PayPal account <b>${esc(w.email ?? w.payer_id ?? 'of the buyer')}</b>${w.payer_id ? ` (payer ID <span class="mono">${esc(w.payer_id)}</span>)` : ''}, on ${esc(w.saved_at.slice(0, 16).replace('T', ' '))} UTC. The agent can now pay at the shop by itself.</p>
<form class="lab" method="post" action="/wallet/forget"><button type="submit">Forget the saved wallet</button></form>`
    : '<p>No wallet saved yet. Without one, the buyer approves each payment through a PayPal link.</p>';
  return layout('Black Box · wallet', `<section class="hero"><div><div class="eyebrow"><b>●</b> Buyer · live</div>
<h1>Let the agent <em>pay.</em></h1></div>
<div><p>Shopping agents pay without showing the buyer a checkout screen. Here the buyer saves their PayPal wallet once (PayPal's saved payment methods), and from then on the agent's purchases are charged straight away. The buyer finds out from PayPal, as they would with a real agent, and disputes there.</p>
<p>The passkey mandate is the limit the buyer set. PayPal does not enforce it: Black Box judges against it afterwards.</p></div></section>
<section class="sec"><div class="panel lab">${note}${status}
<form class="lab" method="post" action="/wallet/connect"><button type="submit">${w ? 'Save a different wallet' : 'Save the buyer\u2019s PayPal wallet'} →</button></form>
<p><a href="/operator">Back to the operator page</a></p></div></section>`);
}

export function readback(m) {
  const a = m.item?.attributes ?? {};
  return `${[a.color, m.item?.category].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}, at most ${money(m.maxTotalCents)}`;
}

export const PAYMENTS = [
  ['wallet', 'From the buyer\u2019s saved PayPal wallet, by itself (no approval screen)'],
  ['link', 'Through a PayPal link the buyer approves'],
];
const option = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

export function operatorPage(root, { env = process.env, shopUrl, now = Date.now() } = {}) {
  const max = maxRunsPerDay(env);
  const left = Math.max(0, max - runsToday(root, now));
  const all = mandates(root);
  const list = all.filter((m) => inForce(m.mandate, now));
  const wallet = savedWallet(root);
  const payments = wallet ? PAYMENTS : PAYMENTS.filter(([v]) => v !== 'wallet');
  const form = list.length
    ? `<form class="panel lab" method="post" action="/operator/run">
<label>Mandate the buyer approved with their passkey<select name="mandate">${list.map((m, i) => option(m.hash, `${readback(m.mandate)} · ${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`, i === 0)).join('')}</select></label>
<label>The buyer's request, in their words (optional)<textarea name="request" rows="3" maxlength="${REQUEST_MAX}" placeholder="${esc(REQUEST_EXAMPLE)}"></textarea></label>
<label>Agent model<select name="model">${agentModels(env).map(([m, text], i) => option(m, text, i === 0)).join('')}</select></label>
<label>What it may look at<select name="shelf">${SHELVES.map(([v, text], i) => option(v, text, i === 0)).join('')}</select></label>
<label>How it pays<select name="pay">${payments.map(([v, text], i) => option(v, text, i === 0)).join('')}</select></label>
<p>${wallet ? `Buyer\u2019s saved wallet: <b>${esc(wallet.email ?? wallet.payer_id ?? 'saved')}</b>. <a href="/wallet">Change</a>` : 'No saved wallet, so the buyer approves the payment. <a href="/wallet">Save the buyer\u2019s PayPal wallet</a> to let the agent pay by itself.'}</p>
<p class="runs"><b>${left} of ${max}</b> runs left today (UTC). Each run spends model credit and creates a PayPal order.</p>
<button type="submit"${left ? '' : ' disabled'}>Send the agent shopping</button></form>`
    : `<p class="panel">${all.length ? `No mandate in force: the ${all.length} approved here ${all.length === 1 ? 'has' : 'have'} expired.` : 'No mandate yet.'} <a href="/mandate/">Approve one with a passkey</a> first.</p>`;
  return layout('Black Box · operator', `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div>
<h1>Send the agent <em>shopping.</em></h1></div>
<div><p>A real AI agent shops at <a href="${esc(shopUrl)}">${esc(new URL(shopUrl).host)}</a> within the mandate below. Black Box records every page it reads and what it decides, and seals the record into the PayPal order.</p>
<p>Paste what the buyer would tell their agent. The agent gets it with the mandate, which stays the limit Black Box judges against.</p>
<p><a href="/mandate/">Approve a new mandate</a></p></div></section>
<section class="sec">${form}</section>`);
}

const SANDBOX_ACTIVITY = 'https://www.sandbox.paypal.com/myaccount/activities/';
function resultBody({ choice, declined, sealed, order, preview, model }) {
  if (declined) {
    return `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div><h1>It bought <em>nothing.</em></h1></div>
<div><p><b>${esc(model)}</b>: “${esc(choice.reason)}”</p><p>No order, so there is nothing to dispute. The run is recorded: <a href="/case/${esc(sealed.hash)}">open it in Black Box</a> · <a href="/operator">Send it again</a></p></div></section>`;
  }
  const r = sealed.record;
  return `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div>
<h1>It bought <em>${esc(r.purchase.sku)}.</em></h1></div>
<div><p><b>${esc(model)}</b>: “${esc(choice.reason)}”</p>
<p>${money(r.purchase.price_cents)} on a ${money(r.mandate.maxTotalCents)} budget. Record <span class="mono">${esc(sealed.hash.slice(0, 16))}…</span> is sealed into PayPal order <span class="mono">${esc(order.order_id)}</span>.</p>
<p>If disputed as “not as described”: <b>${esc(preview.verdict.verdict === 'NEEDS_A_HUMAN' ? 'NEEDS A HUMAN' : preview.verdict.verdict)}</b> (rule ${preview.verdict.rule}).</p></div></section>
<section class="sec"><div class="panel lab">${order.paid
    ? `<p><b>Paid ${money(r.purchase.price_cents)}</b> from the buyer\u2019s saved PayPal wallet, capture <span class="mono">${esc(order.paid.capture_id)}</span>. No one approved it: the buyer finds out from PayPal.</p>
<p><a class="go" href="${SANDBOX_ACTIVITY}">Dispute it in the PayPal sandbox as the buyer →</a></p>`
    : `<p><a class="go" href="${esc(order.approve_url)}">Pay with PayPal as the buyer →</a></p>`}
<p><a href="/case/${esc(sealed.hash)}">Open the recording in Black Box</a> · <a href="/operator">Send it again</a></p></div></section>`;
}

// The run as it happens, one line per step the agent reports; the newest line pulses until the next.
const RUN_CSS = `<style>ol.tape.run li:last-child::before{background:var(--orange);border-color:var(--orange);animation:runpulse 1s ease-in-out infinite}
ol.tape.run li.end::before{animation:none}ol.tape.run li.bad .ev{color:var(--red)}
@keyframes runpulse{50%{box-shadow:0 0 12px var(--orange);opacity:.4}}@media (prefers-reduced-motion:reduce){ol.tape.run li:last-child::before{animation:none}}</style>`;
const modelName = (env, model) => (agentModels(env).find(([m]) => m === model)?.[1] ?? model).replace(/ \(.*$/, '');
export function stepLine(s, { env = process.env, shopUrl } = {}) {
  const path = (u) => { try { const x = new URL(u); return x.origin === new URL(shopUrl).origin ? x.pathname : x.href; } catch { return u; } };
  switch (s.step) {
    case 'page': return ['Read', `<span class="mono">${esc(path(s.url))}</span> · ${s.ok ? 'signed by the shop, signature valid' : `signature not valid (${esc(s.reason)})`}`];
    case 'ask': return ['Ask', `${esc(modelName(env, s.model))} is choosing, given the mandate and ${s.pages} signed page${s.pages === 1 ? '' : 's'}…`];
    case 'decided': return s.sku ? ['Decide', `Buy <b>${esc(s.sku)}</b>: “${esc(s.reason)}”`] : ['Decide', `Buy nothing: “${esc(s.reason)}”`];
    case 'sealed': return ['Seal', `Record <span class="mono">${esc(s.hash.slice(0, 16))}…</span> sealed: every page read, the model's input and its decision${s.price_cents === null ? ' to buy nothing' : `, ${money(s.price_cents)}`}`];
    case 'checkout': return ['Checkout', `Checking out ${esc(s.sku)} at the shop, with the record hash…`];
    case 'order': return s.paid
      ? ['Paid', `PayPal order <span class="mono">${esc(s.orderId)}</span> charged to the buyer\u2019s saved wallet, capture <span class="mono">${esc(s.paid.capture_id)}</span>, carrying the record hash`]
      : ['Order', `PayPal order <span class="mono">${esc(s.orderId)}</span> created, carrying the record hash`];
    default: return [esc(s.step), ''];
  }
}

const SANDBOX = 'https://www.sandbox.paypal.com/myaccount/summary';
// The wallet page's form redirects to PayPal for the buyer's approval, and browsers apply
// form-action to that redirect too, so this one page also allows PayPal as a form target.
const WALLET_CSP = HEADERS['content-security-policy'].replace("form-action 'self'", "form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com");

export function demoPage({ shopUrl }) {
  const step = (n, title, text, href, link) => `<li class="panel"><div class="eyebrow"><b>${n}</b> ${title}</div><p>${text}</p>${href ? `<p><a class="go" href="${esc(href)}">${link} →</a></p>` : ''}</li>`;
  return layout('Black Box · live demo', `<section class="hero"><div><div class="eyebrow"><b>●</b> Live demo · PayPal sandbox</div>
<h1>Watch an agent <em>get fooled.</em></h1></div>
<div><p>A real AI agent shops at a real (sandbox) store that hides a note only AI agents read. The buyer disputes the purchase in PayPal, and Black Box settles it by itself.</p>
<p>Steps 1 to 3 need the operator password, because they spend model credit and create PayPal orders.</p></div></section>
<section class="sec"><ol class="demo">
${step('01', 'The buyer sets the limit', 'Approve “blue rain jacket, size M, at most $150” with your passkey (Touch ID). It signs exactly that mandate. Once, the buyer also saves their PayPal wallet, so the agent can pay by itself.', '/mandate/', 'Approve with a passkey')}
${step('02', 'The agent shops', `It reads every page of <a href="${esc(shopUrl)}">Driftwood Outfitters</a>, picks a jacket and checks out. Black Box seals what it saw and decided into the PayPal order.`, '/operator', 'Send the agent shopping')}
${step('03', 'The agent pays', 'With the saved wallet, PayPal charges the buyer at once: no checkout screen, as with a real shopping agent. Without one, pay through the PayPal link the run gives you.', '/wallet', 'Save the buyer\u2019s wallet')}
${step('04', 'The buyer disputes', 'In the PayPal sandbox: Activity, the payment, Report a problem, item not as described.', SANDBOX, 'Open the PayPal sandbox')}
${step('05', 'Black Box settles it', 'PayPal’s webhook, or a check every 30 seconds, wakes Black Box. It judges the case and tells PayPal what to do. The run is at the top of Recordings, tagged Live run.', '/', 'Open Recordings')}
</ol></section>`, { active: 'demo' });
}

// Constant-time check of the operator password in an HTTP Basic header.
export function authorised(header, key) {
  if (!key) return false;
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readForm(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('form too large'); }
  return new URLSearchParams(raw);
}

// replay, mandate, webhook: http.Servers whose request handlers this front end dispatches to.
// runAgent and llm are replaceable for tests; payeeMerchantId is only used for the preview.
export function createLive({
  root, replay, mandate, webhook = null, operatorKey, origin, shopUrl, env = process.env,
  runAgent = defaultRunAgent, llm = anthropic, payeeMerchantId = 'MCYKQUXGB936U', pay = paypal, now = () => Date.now(),
}) {
  const origins = new Set([origin]);
  return createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (status, html, extra = {}) => { res.writeHead(status, { ...HEADERS, ...extra }); res.end(html); };
    const locked = () => send(401, 'The operator password is required.', { 'www-authenticate': 'Basic realm="Black Box operator", charset="UTF-8"' });
    try {
      if (url.pathname === '/demo' && req.method === 'GET') return send(200, demoPage({ shopUrl }));
      if (url.pathname === '/paypal/webhook') {
        if (!webhook) return send(404, 'No webhook on this server.');
        return webhook.emit('request', req, res);
      }
      const operator = url.pathname === '/operator' || url.pathname === '/operator/run' || url.pathname === '/wallet' || url.pathname.startsWith('/wallet/');
      if (url.pathname === '/mandate' || url.pathname.startsWith('/mandate/') || operator) {
        if (!operatorKey) return send(404, 'Not enabled on this server.');
        if (!authorised(req.headers.authorization, operatorKey)) return locked();
      }
      if (url.pathname === '/mandate') return send(308, '', { location: '/mandate/' });
      if (url.pathname.startsWith('/mandate/')) {
        // A browser posts to these from the mandate page itself; refuse posts from anywhere else.
        if (req.method === 'POST' && !origins.has(req.headers.origin)) return send(403, 'Cross-site request refused.');
        req.url = req.url.slice('/mandate'.length);
        return mandate.emit('request', req, res);
      }
      if (url.pathname === '/operator' && req.method === 'GET') return send(200, operatorPage(root, { env, shopUrl, now: now() }));
      if (url.pathname === '/wallet' && req.method === 'GET') return send(200, walletPage(root), { 'content-security-policy': WALLET_CSP });
      if (url.pathname.startsWith('/wallet/') && req.method === 'POST' && !origins.has(req.headers.origin)) return send(403, 'Cross-site request refused.');
      if (url.pathname === '/wallet/connect' && req.method === 'POST') {
        // PayPal's saved payment methods: a setup token the buyer approves once, on PayPal.
        const r = await pay('POST', '/v3/vault/setup-tokens', { payment_source: { paypal: {
          usage_type: 'MERCHANT', usage_pattern: 'IMMEDIATE',
          description: 'Lets the shopping agent pay at Driftwood Outfitters without a checkout screen',
          experience_context: { return_url: `${origin}/wallet/return`, cancel_url: `${origin}/wallet`, user_action: 'SETUP_NOW', shipping_preference: 'NO_SHIPPING' },
        } } });
        const approve = r.data?.links?.find((l) => l.rel === 'approve')?.href;
        if (!r.ok || !approve) return send(502, walletPage(root, { note: `<p>PayPal did not start the wallet save (HTTP ${r.status}, debug ${esc(r.debugId)}).</p>` }));
        writeJson(pendingFile(root), { setup_token: r.data.id, at: new Date().toISOString() });
        return send(303, '', { location: approve });
      }
      if (url.pathname === '/wallet/return' && req.method === 'GET') {
        let pending = null;
        try { pending = JSON.parse(readFileSync(pendingFile(root), 'utf8')); } catch { /* none */ }
        const token = url.searchParams.get('approval_token_id') ?? url.searchParams.get('token');
        if (!pending || !token || token !== pending.setup_token) return send(400, walletPage(root, { note: '<p>That wallet approval is not the one this page started. Start again.</p>' }));
        const r = await pay('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: token, type: 'SETUP_TOKEN' } } });
        if (!r.ok || !r.data?.id) return send(502, walletPage(root, { note: `<p>PayPal did not save the wallet (HTTP ${r.status}, debug ${esc(r.debugId)}).</p>` }));
        const p = r.data.payment_source?.paypal ?? {};
        writeJson(walletFile(root), { vault_id: r.data.id, customer_id: r.data.customer?.id ?? null, email: p.email_address ?? null, payer_id: p.payer_id ?? p.account_id ?? null, saved_at: new Date().toISOString() });
        rmSync(pendingFile(root), { force: true });
        return send(303, '', { location: '/wallet' });
      }
      if (url.pathname === '/wallet/forget' && req.method === 'POST') {
        const w = savedWallet(root);
        if (w) await pay('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(w.vault_id)}`);
        rmSync(walletFile(root), { force: true });
        return send(303, '', { location: '/wallet' });
      }
      if (url.pathname === '/operator/run' && req.method === 'POST') {
        if (!origins.has(req.headers.origin)) return send(403, 'Cross-site request refused.');
        const form = await readForm(req);
        const approved = mandates(root).find((m) => m.hash === form.get('mandate') && inForce(m.mandate, now()));
        const model = agentModels(env).find(([m]) => m === form.get('model'))?.[0];
        const shelf = SHELVES.find(([v]) => v === form.get('shelf'));
        const payment = form.get('pay') ?? 'link';
        if (!approved || !model || !shelf || !PAYMENTS.some(([v]) => v === payment)) return send(400, 'Pick a mandate in force, a model, a shelf and a payment from the form.');
        const wallet = payment === 'wallet' ? savedWallet(root) : null;
        if (payment === 'wallet' && !wallet) return send(400, 'No saved wallet: save the buyer\u2019s PayPal wallet first, or pay through a link.');
        // The wallet must be the mandate's payer: otherwise the passkey check fails at dispute time.
        if (wallet?.payer_id && approved.payer_id && wallet.payer_id !== approved.payer_id) return send(400, `The saved wallet is PayPal payer ${esc(wallet.payer_id)}, but the mandate is for payer ${esc(approved.payer_id)}.`);
        let request;
        try { request = cleanRequest(form.get('request')); } catch (e) { return send(400, esc(e.message)); }
        const max = maxRunsPerDay(env);
        if (!takeRun(root, max, now())) return send(429, `The live demo has used today's ${max} agent runs. It resets at midnight UTC. The recorded runs, the lab and the scenarios stay open.`, { 'retry-after': String(Math.ceil((Date.parse(`${utcDay(now())}T00:00:00Z`) + 86400000 - now()) / 1000)) });
        // Streamed: the page grows as the agent works, then the result follows the timeline.
        const [head, tail] = layout('Black Box · operator', '\u0000').split('\u0000');
        res.writeHead(200, HEADERS);
        res.write(`${head}${RUN_CSS}<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div>
<h1>The agent is <em>shopping.</em></h1></div><div><p>${esc(modelName(env, model))} at <a href="${esc(shopUrl)}">${esc(new URL(shopUrl).host)}</a>, within: ${esc(readback(approved.mandate))}.</p>${request ? `<p>The buyer asked: “${esc(request)}”</p>` : ''}</div></section>
<section class="sec"><ol class="tape run">`);
        const t0 = Date.now();
        const line = (ev, text, cls = '') => res.write(`<li${cls ? ` class="${cls}"` : ''}><span class="t">+${((Date.now() - t0) / 1000).toFixed(1)}s</span><span class="ev">${ev}</span><span>${text}</span></li>\n`);
        line('Start', request ? 'Sent the agent to the shop with the buyer’s request' : 'Sent the agent to the shop');
        let out;
        try {
          out = await runAgent({ shopUrl, mandate: approved.mandate, mandateAuth: approved.mandate_auth, request, vaultId: wallet?.vault_id ?? null, model, llm, shelf: shelf[0] ? [shelf[0]] : null,
            onStep: (s) => line(...stepLine(s, { env, shopUrl }), ['decided', 'order'].includes(s.step) ? 'hot' : '') });
        } catch (e) {
          console.error(e);
          line('Failed', `The run failed: ${esc(e.message)}`, 'end bad');
          return res.end(`</ol><p><a href="/operator">Back to the operator page</a></p></section>${tail}`);
        }
        line('Done', out.declined ? 'Nothing bought, so no order; the run is recorded' : out.order?.paid ? 'Paid by the agent; the buyer sees the charge in PayPal' : 'Ready for the buyer to pay', 'end');
        res.write('</ol></section>');
        saveRecord(join(root, 'records'), out.sealed);
        if (out.declined) return res.end(resultBody({ ...out, model }) + tail);
        const preview = evaluateCase({
          record: out.sealed.record,
          order: { customId: out.sealed.hash, payeeMerchantId, createdAt: new Date().toISOString(), capturedCents: out.sealed.record.purchase.price_cents, payerId: approved.payer_id },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          enrolment: enrolmentFrom(root),
        });
        return res.end(resultBody({ ...out, preview, model }) + tail);
      }
      if (operator) return send(405, 'Method not allowed.');
      return replay.emit('request', req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(500, `The run failed: ${esc(e.message)}`);
    }
  });
}
