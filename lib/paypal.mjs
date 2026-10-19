// Minimal PayPal REST client (sandbox). Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from env.
// createPayPal() makes a client for other credentials, e.g. the agent operator's (Payouts).
export const API = process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com';

export function createPayPal(creds = () => ({ id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET })) {
  let cached = null;

  async function accessToken() {
    if (cached && cached.expires > Date.now()) return cached.value;
    const { id, secret } = typeof creds === 'function' ? creds() : creds;
    if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
    const r = await fetch(`${API}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`PayPal OAuth failed (${r.status}): ${j.error_description ?? j.error}`);
    cached = { value: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.value;
  }

  async function paypal(method, path, json) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
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
