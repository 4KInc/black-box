// Minimal PayPal REST client (sandbox). Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from env.
export const API = process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com';

let cached = null;

async function token() {
  if (cached && cached.expires > Date.now()) return cached.value;
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
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

export async function paypal(method, path, json) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, debugId: r.headers.get('paypal-debug-id'), data };
}
