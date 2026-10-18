// The demo shop's HTTP server. Every HTML response is signed (RFC 9421) with the shop's key.
// Checkout creates the PayPal order itself and puts the agent's record hash in custom_id,
// using the signed price from the catalog, never a price sent by the client.
import { createServer } from 'node:http';
import { jwks, signResponse } from '../lib/sig.mjs';
import { paypal } from '../lib/paypal.mjs';
import { LEGIT_PRICE_DATA, PRODUCTS, SHOP_NAME } from './catalog.mjs';
import { categoryPage, messagePage, productPage } from './pages.mjs';
import { signedReview } from './reviews.mjs';

const HTML = 'text/html; charset=utf-8';
const RECORD_HASH = /^[0-9a-f]{64}$/;

// injections: false serves the same pages with the hidden texts removed (the control condition).
export function createShop({ shopJwk, reviewsJwk, reviewsIssuer, merchantId, origin, now = () => Math.floor(Date.now() / 1000), pay = paypal, injections = true, extraData = null }) {
  const base = injections ? PRODUCTS : PRODUCTS.map(({ hiddenJsonLd, hiddenNote, ...p }) => ({ ...p, reviews: p.reviews.map(({ hidden, ...r }) => r) }));
  // One accurate-but-different price statement (catalog LEGIT_PRICE_DATA) on the Summit Pro Shell.
  if (extraData && !LEGIT_PRICE_DATA[extraData]) throw new Error(`unknown SHOP_EXTRA_DATA ${extraData}`);
  const products = extraData
    ? base.map((p) => (p.sku === 'RJ-PREMIUM-BLUE-M' ? { ...p, productData: { ...p.productData, offerDetails: LEGIT_PRICE_DATA[extraData] } } : p))
    : base;
  const bySku = (sku) => products.find((p) => p.sku === sku);
  // Reviews are signed once by the platform; the shop only embeds them.
  const reviewsBySku = Object.fromEntries(products.map((p) => [
    p.sku, p.reviews.map((review) => signedReview({ jwk: reviewsJwk, iss: reviewsIssuer, sku: p.sku, review })),
  ]));
  const keySet = JSON.stringify(jwks(shopJwk));
  const ctx = { merchantId, origin };

  function sendSigned(req, res, status, html) {
    const body = Buffer.from(html);
    const headers = signResponse({
      jwk: shopJwk, status, contentType: HTML, body,
      authority: req.headers.host, path: req.url, created: now(),
    });
    res.writeHead(status, { 'content-type': HTML, 'content-length': body.length, 'cache-control': 'no-store', ...headers });
    res.end(body);
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  async function readJson(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
    return JSON.parse(raw || '{}');
  }

  async function checkout(req, res) {
    let input;
    try { input = await readJson(req); } catch { return sendJson(res, 400, { error: 'body must be JSON' }); }
    const product = bySku(input.sku);
    if (!product) return sendJson(res, 404, { error: `unknown sku ${input.sku}` });
    if (!RECORD_HASH.test(input.record_hash ?? '')) return sendJson(res, 400, { error: 'record_hash must be 64 lowercase hex characters' });

    const value = (product.priceCents / 100).toFixed(2);
    const r = await pay('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'default',
        custom_id: input.record_hash,
        description: `${product.name} (${product.sku})`,
        amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
        items: [{ name: product.name, sku: product.sku, quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'USD', value } }],
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: SHOP_NAME, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: `${origin}/paypal/return`, cancel_url: `${origin}/paypal/cancel`,
      } } },
    });
    if (!r.ok) return sendJson(res, 502, { error: 'PayPal order failed', status: r.status, debug_id: r.debugId, details: r.data });
    const approve = r.data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    sendJson(res, 201, { order_id: r.data.id, approve_url: approve, sku: product.sku, amount: value, custom_id: input.record_hash });
  }

  // The buyer lands here after approving; the merchant captures immediately.
  async function paypalReturn(req, res, url) {
    const id = url.searchParams.get('token');
    if (!id) return sendSigned(req, res, 400, messagePage({ ...ctx, title: 'Missing order', text: 'PayPal did not return an order ID.' }));
    const r = await pay('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {});
    const cap = r.data?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!r.ok || !cap) {
      return sendSigned(req, res, 502, messagePage({ ...ctx, title: 'Payment not captured', text: `PayPal returned ${r.status} (debug ${r.debugId}).` }));
    }
    sendSigned(req, res, 200, messagePage({ ...ctx, title: 'Thank you, payment received', text: `Order ${id}, capture ${cap.id}, ${cap.status}.` }));
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(keySet);
      }
      if (req.method === 'GET' && url.pathname === '/') return sendSigned(req, res, 200, categoryPage(ctx));
      const m = url.pathname.match(/^\/p\/([A-Z0-9-]+)$/);
      if (req.method === 'GET' && m) {
        const product = bySku(m[1]);
        if (!product) return sendSigned(req, res, 404, messagePage({ ...ctx, title: 'Not found', text: 'No such product.' }));
        return sendSigned(req, res, 200, productPage({ ...ctx, product, signedReviews: reviewsBySku[product.sku] }));
      }
      if (req.method === 'POST' && url.pathname === '/checkout') return await checkout(req, res);
      if (req.method === 'GET' && url.pathname === '/paypal/return') return await paypalReturn(req, res, url);
      if (req.method === 'GET' && url.pathname === '/paypal/cancel') return sendSigned(req, res, 200, messagePage({ ...ctx, title: 'Payment cancelled', text: 'No payment was taken.' }));
      sendSigned(req, res, 404, messagePage({ ...ctx, title: 'Not found', text: 'No such page.' }));
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
  });
}
