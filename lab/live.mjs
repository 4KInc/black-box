// The hosted live demo, in front of the hosted Black Box (lab/hosted.mjs, when LIVE_DIR is set):
//   /mandate/        the buyer approves a mandate with a passkey on this site (mandate/server.mjs)
//   /operator        the agent operator sends the agent shopping at the hosted shop
//   /paypal/webhook  PayPal's dispute events, verified with PayPal, into the autopilot
// Everything else is the replay, which shows each run made here as a live run, with what PayPal
// did once the autopilot has acted. The mandate and operator pages need the operator password
// (HTTP Basic, any user name): they spend model credit and create PayPal orders.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { runAgent as defaultRunAgent } from '../agent/agent.mjs';
import { anthropic, hostedFor } from '../agent/llm.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { canonicalize } from '../lib/canonical.mjs';
import { enrolmentFrom } from '../mandate/server.mjs';
import { layout } from '../replay/page.mjs';
import { saveRecord } from '../recorder/recorder.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const money = (c) => `$${(c / 100).toFixed(2)}`;
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

// The Claude models from the study, plus any other provider's whose key this server holds.
const CLAUDE = [
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fooled 10/10 in the study)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (resisted every lie)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (resisted every lie)'],
];
const OTHERS = [['gpt-4o-mini-2024-07-18', 'GPT-4o mini'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'], ['grok-4.20-0309-non-reasoning', 'Grok 4.20 (non-reasoning)']];
export const agentModels = (env = process.env) => [...CLAUDE, ...OTHERS.filter(([m]) => env[hostedFor(m)?.key])];
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

// The approved mandates on this server, newest first.
export function mandates(root) {
  const dir = join(root, 'records', 'mandates');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .map((m) => ({ ...m, hash: sha256hex(canonicalize(m.mandate)), at: Date.parse(m.mandate.notBefore) || 0 }))
    .sort((a, b) => b.at - a.at);
}

export function readback(m) {
  const a = m.item?.attributes ?? {};
  return `${[a.color, m.item?.category].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}, at most ${money(m.maxTotalCents)}`;
}

const option = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

export function operatorPage(root, { env = process.env, shopUrl } = {}) {
  const list = mandates(root);
  const form = list.length
    ? `<form class="panel lab" method="post" action="/operator/run">
<label>Mandate the buyer approved with their passkey<select name="mandate">${list.map((m, i) => option(m.hash, `${readback(m.mandate)} · ${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`, i === 0)).join('')}</select></label>
<label>Agent model<select name="model">${agentModels(env).map(([m, text], i) => option(m, text, i === 0)).join('')}</select></label>
<label>What it may look at<select name="shelf">${SHELVES.map(([v, text], i) => option(v, text, i === 0)).join('')}</select></label>
<button type="submit">Send the agent shopping</button></form>`
    : '<p class="panel">No mandate yet. <a href="/mandate/">Approve one with a passkey</a> first.</p>';
  return layout('Black Box · operator', `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div>
<h1>Send the agent <em>shopping.</em></h1></div>
<div><p>A real AI agent shops at <a href="${esc(shopUrl)}">${esc(new URL(shopUrl).host)}</a> within the mandate below. Black Box records every page it reads and what it decides, and seals the record into the PayPal order.</p>
<p><a href="/mandate/">Approve a new mandate</a></p></div></section>
<section class="sec">${form}</section>`);
}

function resultPage({ choice, declined, sealed, order, preview, model }) {
  if (declined) {
    return layout('Black Box · operator', `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div><h1>It bought <em>nothing.</em></h1></div>
<div><p><b>${esc(model)}</b>: ${esc(choice.reason)}</p><p>No order, so there is nothing to record. <a href="/operator">Send it again</a></p></div></section>`);
  }
  const r = sealed.record;
  return layout('Black Box · operator', `<section class="hero"><div><div class="eyebrow"><b>●</b> Agent operator · live</div>
<h1>It bought <em>${esc(r.purchase.sku)}.</em></h1></div>
<div><p><b>${esc(model)}</b>: “${esc(choice.reason)}”</p>
<p>${money(r.purchase.price_cents)} on a ${money(r.mandate.maxTotalCents)} budget. Record <span class="mono">${esc(sealed.hash.slice(0, 16))}…</span> is sealed into PayPal order <span class="mono">${esc(order.order_id)}</span>.</p>
<p>If disputed as “not as described”: <b>${esc(preview.verdict.verdict === 'NEEDS_A_HUMAN' ? 'NEEDS A HUMAN' : preview.verdict.verdict)}</b> (rule ${preview.verdict.rule}).</p></div></section>
<section class="sec"><div class="panel lab"><p><a class="go" href="${esc(order.approve_url)}">Pay with PayPal as the buyer →</a></p>
<p><a href="/case/${esc(sealed.hash)}">Open the recording in Black Box</a> · <a href="/operator">Send it again</a></p></div></section>`);
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
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error('form too large'); }
  return new URLSearchParams(raw);
}

// replay, mandate, webhook: http.Servers whose request handlers this front end dispatches to.
// runAgent and llm are replaceable for tests; payeeMerchantId is only used for the preview.
export function createLive({
  root, replay, mandate, webhook = null, operatorKey, origin, shopUrl, env = process.env,
  runAgent = defaultRunAgent, llm = anthropic, payeeMerchantId = 'MCYKQUXGB936U',
}) {
  const origins = new Set([origin]);
  return createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (status, html, extra = {}) => { res.writeHead(status, { ...HEADERS, ...extra }); res.end(html); };
    const locked = () => send(401, 'The operator password is required.', { 'www-authenticate': 'Basic realm="Black Box operator", charset="UTF-8"' });
    try {
      if (url.pathname === '/paypal/webhook') {
        if (!webhook) return send(404, 'No webhook on this server.');
        return webhook.emit('request', req, res);
      }
      const operator = url.pathname === '/operator' || url.pathname === '/operator/run';
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
      if (url.pathname === '/operator' && req.method === 'GET') return send(200, operatorPage(root, { env, shopUrl }));
      if (url.pathname === '/operator/run' && req.method === 'POST') {
        if (!origins.has(req.headers.origin)) return send(403, 'Cross-site request refused.');
        const form = await readForm(req);
        const approved = mandates(root).find((m) => m.hash === form.get('mandate'));
        const model = agentModels(env).find(([m]) => m === form.get('model'))?.[0];
        const shelf = SHELVES.find(([v]) => v === form.get('shelf'));
        if (!approved || !model || !shelf) return send(400, 'Pick a mandate, a model and a shelf from the form.');
        const out = await runAgent({ shopUrl, mandate: approved.mandate, mandateAuth: approved.mandate_auth, model, llm, shelf: shelf[0] ? [shelf[0]] : null });
        if (out.declined) return send(200, resultPage({ ...out, model }));
        saveRecord(join(root, 'records'), out.sealed);
        const preview = evaluateCase({
          record: out.sealed.record,
          order: { customId: out.sealed.hash, payeeMerchantId, createdAt: new Date().toISOString(), capturedCents: out.sealed.record.purchase.price_cents, payerId: approved.payer_id },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          enrolment: enrolmentFrom(root),
        });
        return send(200, resultPage({ ...out, preview, model }));
      }
      if (operator) return send(405, 'Method not allowed.');
      return replay.emit('request', req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(500, `The run failed: ${esc(e.message)}`);
    }
  });
}
