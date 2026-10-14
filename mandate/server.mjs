// The mandate screen: the user states what the agent may buy and approves it with a passkey.
//   npm run mandate   -> http://localhost:4050
// First visit: enrol a passkey for your PayPal payer ID (stored in records/passkeys/).
// Then: approve a mandate; it is saved to records/mandates/<mandate hash>.json, ready for
//   node agent/run.mjs --mandate <mandate hash>
// The passkey signs sha256(canonical mandate), so the approval covers exactly what was shown.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { canonicalize } from '../lib/canonical.mjs';
import { loadEnv } from '../lib/env.mjs';
import { b64u, verifyMandateAssertion } from '../lib/webauthn.mjs';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.MANDATE_PORT ?? 4050);
const RP_ID = 'localhost';
const PAYER_ID = /^[A-Z0-9]{8,20}$/;
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// ---------- enrolment registry: PayPal payer ID -> passkeys ----------

const passkeyDir = (root) => join(root, 'records', 'passkeys');
export function enrolledCredentials(root, payerId) {
  if (!PAYER_ID.test(payerId ?? '')) return [];
  const p = join(passkeyDir(root), `${payerId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).credentials : [];
}
export const enrolledKeysFrom = (root) => (payerId) => enrolledCredentials(root, payerId).map((c) => c.public_key_spki);

function enrol(root, payerId, cred) {
  mkdirSync(passkeyDir(root), { recursive: true });
  const credentials = enrolledCredentials(root, payerId).filter((c) => c.id !== cred.id);
  credentials.push(cred);
  writeFileSync(join(passkeyDir(root), `${payerId}.json`), JSON.stringify({ payer_id: payerId, credentials }, null, 2));
}

// ---------- the mandate ----------

export function buildMandate({ category, color, size, maxDollars, days }) {
  const cents = Math.round(Number(maxDollars) * 100);
  if (!category || !Number.isInteger(cents) || cents <= 0) throw new RangeError('category and a positive budget are required');
  const now = new Date();
  return {
    item: { category: String(category).trim().toLowerCase(), attributes: { color: String(color).trim().toLowerCase(), size: String(size).trim().toUpperCase() } },
    maxTotalCents: cents, currency: 'USD', signedShopsOnly: true,
    notBefore: now.toISOString(), notAfter: new Date(now.getTime() + Number(days || 7) * 86400_000).toISOString(),
    nonce: b64u.enc(randomBytes(12)),
  };
}

// ---------- server ----------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve a mandate</title><style>
:root{--ink:#16202b;--muted:#5d6b7b;--line:#dfe4ea;--bg:#f4f6f9;--card:#fff;--accent:#1d4ed8;--ok:#13795b;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--ink:#e6ebf1;--muted:#9aa7b6;--line:#2b3542;--bg:#0f141a;--card:#161d25;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:620px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.k{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}button{margin-top:14px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.5;cursor:default}.plain{font-size:18px;font-weight:600}#out{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px}
.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><main>
<h1>Approve what your agent may buy</h1><div class="k">Black Box records this mandate. Your passkey signs exactly what you see here.</div>
<div class="card"><label for="payer">Your PayPal payer ID</label><input id="payer" autocomplete="off">
<div class="k" id="enrolled">Checking for an enrolled passkey…</div><button id="enrol" hidden>Enrol a passkey for this payer ID</button></div>
<div class="card"><label for="category">Item</label><input id="category" value="rain jacket">
<div class="row"><div><label for="color">Colour</label><input id="color" value="blue"></div><div><label for="size">Size</label><input id="size" value="M"></div>
<div><label for="max">Budget (USD)</label><input id="max" value="150" inputmode="decimal"></div></div>
<label for="days">Valid for (days)</label><input id="days" value="7" inputmode="numeric">
<p class="plain" id="plain"></p><button id="approve" disabled>Approve with passkey</button></div>
<div class="card"><div id="out" class="k">Nothing approved yet.</div></div>
</main><script src="/app.js"></script></body></html>`;

const APP_JS = `
const $ = (id) => document.getElementById(id);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), (c) => c.charCodeAt(0));
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const fields = () => ({ category: $('category').value, color: $('color').value, size: $('size').value, maxDollars: $('max').value, days: $('days').value });
const say = (text, cls = 'k') => { $('out').className = cls; $('out').textContent = text; };
let creds = [];

function plain() {
  const f = fields();
  $('plain').textContent = 'Buy one ' + f.color + ' ' + f.category + ', size ' + f.size + ', for at most $' + Number(f.maxDollars).toFixed(2) + ', from shops that sign their pages, within ' + f.days + ' days.';
}
async function refresh() {
  const payer = $('payer').value.trim();
  const r = await fetch('/enrolled?payer=' + encodeURIComponent(payer)).then((r) => r.json());
  creds = r.credentials;
  $('enrolled').textContent = creds.length ? creds.length + ' passkey(s) enrolled for this payer ID.' : 'No passkey enrolled for this payer ID yet.';
  $('enrol').hidden = creds.length > 0;
  $('approve').disabled = creds.length === 0;
}
$('enrol').onclick = async () => {
  try {
    const payer = $('payer').value.trim();
    const o = await post('/enrol/options', { payerId: payer });
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64u(o.challenge), rp: { id: o.rpId, name: 'Black Box' },
      user: { id: unb64u(o.userId), name: payer, displayName: 'PayPal payer ' + payer },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, attestation: 'none',
    } });
    await post('/enrol', { payerId: payer, id: cred.id, alg: cred.response.getPublicKeyAlgorithm(), publicKeySpki: b64u(cred.response.getPublicKey()), clientDataJSON: b64u(cred.response.clientDataJSON) });
    say('Passkey enrolled.', 'ok'); refresh();
  } catch (e) { say('Enrolment failed: ' + e.message, 'bad'); }
};
$('approve').onclick = async () => {
  try {
    const o = await post('/approve/options', { payerId: $('payer').value.trim(), ...fields() });
    const a = await navigator.credentials.get({ publicKey: {
      challenge: unb64u(o.challenge), rpId: o.rpId, userVerification: 'required',
      allowCredentials: creds.map((c) => ({ type: 'public-key', id: unb64u(c.id) })),
    } });
    const r = await post('/approve', { pending: o.pending, credentialId: a.id, authenticatorData: b64u(a.response.authenticatorData), clientDataJSON: b64u(a.response.clientDataJSON), signature: b64u(a.response.signature) });
    say('Approved. Mandate ' + r.mandateHash + '\\n\\nRun the agent with it:\\n  node agent/run.mjs --mandate ' + r.mandateHash, 'ok');
  } catch (e) { say('Approval failed: ' + e.message, 'bad'); }
};
for (const id of ['category','color','size','max','days']) $(id).oninput = plain;
$('payer').onchange = refresh;
fetch('/defaults').then((r) => r.json()).then((d) => { $('payer').value = d.payerId; plain(); refresh(); });
`;

export function createMandateServer({ root = ROOT, defaultPayerId = '' } = {}) {
  const pendingEnrol = new Map();   // challenge -> payerId
  const pendingApprove = new Map(); // token -> { payerId, mandate }

  const HEADERS = {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  };
  return createServer((req, res) => {
    const send = (status, type, body) => { res.writeHead(status, { ...HEADERS, 'content-type': type }); res.end(body); };
    const json = (status, obj) => send(status, 'application/json', JSON.stringify(obj));
    const url = new URL(req.url, 'http://localhost');
    const origin = `http://${RP_ID}:${req.socket.localPort}`;

    if (req.method === 'GET') {
      if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
      if (url.pathname === '/app.js') return send(200, 'text/javascript; charset=utf-8', APP_JS);
      if (url.pathname === '/defaults') return json(200, { payerId: defaultPayerId });
      if (url.pathname === '/enrolled') return json(200, { credentials: enrolledCredentials(root, url.searchParams.get('payer')).map(({ id, alg, enrolled_at }) => ({ id, alg, enrolled_at })) });
      return json(404, { error: 'not found' });
    }
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: 'not JSON' }); }
      try {
        if (url.pathname === '/enrol/options') {
          if (!PAYER_ID.test(body.payerId ?? '')) throw new Error('enter your PayPal payer ID (letters and digits)');
          const challenge = b64u.enc(randomBytes(32));
          pendingEnrol.set(challenge, body.payerId);
          return json(200, { challenge, rpId: RP_ID, userId: b64u.enc(Buffer.from(body.payerId)) });
        }
        if (url.pathname === '/enrol') {
          const cd = JSON.parse(b64u.dec(body.clientDataJSON).toString('utf8'));
          if (cd.type !== 'webauthn.create' || cd.origin !== origin) throw new Error('not a registration from this page');
          if (pendingEnrol.get(cd.challenge) !== body.payerId) throw new Error('unknown or expired enrolment');
          pendingEnrol.delete(cd.challenge);
          if (!body.publicKeySpki || ![-7, -8, -257].includes(body.alg)) throw new Error('unsupported passkey');
          enrol(root, body.payerId, { id: String(body.id), public_key_spki: String(body.publicKeySpki), alg: body.alg, enrolled_at: new Date().toISOString() });
          return json(200, { ok: true });
        }
        if (url.pathname === '/approve/options') {
          if (!enrolledCredentials(root, body.payerId).length) throw new Error('enrol a passkey first');
          const mandate = buildMandate(body);
          const pending = b64u.enc(randomBytes(16));
          pendingApprove.set(pending, { payerId: body.payerId, mandate });
          const challenge = b64u.enc(createHash('sha256').update(canonicalize(mandate)).digest());
          return json(200, { pending, challenge, rpId: RP_ID, mandate });
        }
        if (url.pathname === '/approve') {
          const p = pendingApprove.get(body.pending);
          if (!p) throw new Error('unknown or expired approval');
          pendingApprove.delete(body.pending);
          const cred = enrolledCredentials(root, p.payerId).find((c) => c.id === body.credentialId);
          if (!cred) throw new Error('that passkey is not enrolled for this payer ID');
          const auth = {
            rp_id: RP_ID, credential_id: cred.id, public_key_spki: cred.public_key_spki, alg: cred.alg,
            authenticator_data: body.authenticatorData, client_data_json: body.clientDataJSON, signature: body.signature,
          };
          const v = verifyMandateAssertion(p.mandate, auth);
          if (!v.ok) throw new Error(v.reason);
          const mandateHash = sha256hex(canonicalize(p.mandate));
          const dir = join(root, 'records', 'mandates');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${mandateHash}.json`), JSON.stringify({ payer_id: p.payerId, mandate: p.mandate, mandate_auth: auth }, null, 2));
          return json(200, { mandateHash });
        }
        return json(404, { error: 'not found' });
      } catch (e) {
        return json(400, { error: e.message });
      }
    });
  });
}

if (import.meta.main) {
  loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));
  createMandateServer({ defaultPayerId: process.env.BUYER_PAYER_ID ?? '' }).listen(PORT, '127.0.0.1', () =>
    console.log(`mandate  http://localhost:${PORT}   (passkeys need "localhost", not 127.0.0.1, in the address bar)`));
}
