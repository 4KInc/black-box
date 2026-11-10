// Minimal PayPal REST client (sandbox). Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from env.
// createPayPal() makes a client for other credentials, e.g. the agent operator's (Payouts).
export const API = process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com';

// Every PayPal call gives up after this long; the multipart evidence upload after UPLOAD_TIMEOUT_MS.
// A timeout is an unknown outcome, not a refusal: the executor logs the attempt without a known
// result, and the next run settles it from the dispute PayPal reports (executor/core.mjs). The
// executor's stale-lock threshold is kept well above both, so no lock is taken over while a call
// may still be in flight.
export const PAYPAL_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;

// opts: { timeoutMs, fetch } for tests.
export function createPayPal(creds = () => ({ id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET }), { timeoutMs = PAYPAL_TIMEOUT_MS, fetch = globalThis.fetch } = {}) {
  let cached = null;

  async function accessToken() {
    if (cached && cached.expires > Date.now()) return cached.value;
    const { id, secret } = typeof creds === 'function' ? creds() : creds;
    if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
    const r = await fetch(`${API}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`PayPal OAuth failed (${r.status}): ${j.error_description ?? j.error}`);
    cached = { value: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.value;
  }

  // requestId: PayPal-Request-Id, which makes a call idempotent (PayPal requires it to charge a saved wallet).
  async function paypal(method, path, json, { requestId = null } = {}) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, debugId: r.headers.get('paypal-debug-id'), data };
  }

  return { accessToken, paypal };
}

// The merchant's client, from env (read when first used, so loadEnv can run after import).
const merchant = createPayPal();
export const accessToken = merchant.accessToken;
export const paypal = merchant.paypal;
