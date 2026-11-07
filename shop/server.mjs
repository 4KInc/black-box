// The demo shop's HTTP server. Every HTML response is signed (RFC 9421) with the shop's key.
// Checkout creates the PayPal order itself and puts the agent's record hash in custom_id,
// using the signed price from the catalog, never a price sent by the client. With vaultPay, an
// agent may pay with the buyer's saved PayPal wallet (vault_id): PayPal charges it at once, with
// no approval screen, as an agent with a connected wallet would pay.
import { createServer } from 'node:http';
import { isBenchKey } from '../bench/keys.mjs';
import { jwks, signResponse } from '../lib/sig.mjs';
import { paypal } from '../lib/paypal.mjs';
import { CATALOGS, LEGIT_PRICE_DATA } from './catalog.mjs';
import { categoryPage, messagePage, productPage } from './pages.mjs';
import { signedReview } from './reviews.mjs';

const HTML = 'text/html; charset=utf-8';
const RECORD_HASH = /^[0-9a-f]{64}$/;
const VAULT_ID = /^[A-Za-z0-9-]{1,64}$/;

// injections: false serves the same pages with the hidden texts removed (the control condition).
// catalog: which shop to be (CATALOGS key); Driftwood Outfitters unless told otherwise.
// variants: true also serves the variant pages under /v/<name>/ (see VARIANTS below).
export function createShop({ shopJwk, reviewsJwk, reviewsIssuer, merchantId, origin, now = () => Math.floor(Date.now() / 1000), pay = paypal, injections = true, extraData = null, catalog: catalogKey = 'outdoor', variants = false, vaultPay = false }) {
  const catalog = CATALOGS[catalogKey];
  if (!catalog) throw new Error(`unknown catalog ${catalogKey}`);
  if (isBenchKey(shopJwk) || isBenchKey(reviewsJwk)) throw new Error('refusing the TEST-ONLY bench key: its private half is public');
  const SHOP_NAME = catalog.name;
  // One view of the catalog: the hidden texts on or off, and an optional accurate-but-different
  // price statement (catalog LEGIT_PRICE_DATA) on the Summit Pro Shell. productData: false also
  // drops the accurate product data that is never rendered, so the page hides nothing at all.
  function view({ injections, extraData, productData = true }) {
    const shown = injections ? catalog.products : catalog.products.map(({ hiddenJsonLd, hiddenNote, ...p }) => ({ ...p, reviews: p.reviews.map(({ hidden, ...r }) => r) }));
    const base = productData ? shown : shown.map(({ productData, ...p }) => p);
    if (extraData && !LEGIT_PRICE_DATA[extraData]) throw new Error(`unknown SHOP_EXTRA_DATA ${extraData}`);
    const products = extraData
      ? base.map((p) => (p.sku === 'RJ-PREMIUM-BLUE-M' ? { ...p, productData: { ...p.productData, offerDetails: LEGIT_PRICE_DATA[extraData] } } : p))
      : base;
    // Reviews are signed once by the platform; the shop only embeds them.
    const reviewsBySku = Object.fromEntries(products.map((p) => [
      p.sku, p.reviews.map((review) => signedReview({ jwk: reviewsJwk, iss: reviewsIssuer, sku: p.sku, review })),
    ]));
    return { products, bySku: (sku) => products.find((p) => p.sku === sku), reviewsBySku, ctx: { merchantId, origin, catalog: { ...catalog, products } } };
  }
  const main = view({ injections, extraData });
  const { bySku, ctx } = main;
  // variants: also serve the control pages (hidden texts off) at /v/control/ and each
  // LEGIT_PRICE_DATA page at /v/<key>/, signed with the same key, so one hosted shop can stand in
  // for the shops run locally with SHOP_INJECTIONS=off and SHOP_EXTRA_DATA=<key>. /v/bare/ is the
  // control without the product data, as the control shop was before it carried the fabric.
  const VARIANTS = variants ? {
    control: view({ injections: false, extraData: null }),
    bare: view({ injections: false, extraData: null, productData: false }),
    ...Object.fromEntries(Object.keys(LEGIT_PRICE_DATA).map((k) => [k, view({ injections: false, extraData: k })])),
  } : {};
  const keySet = JSON.stringify(jwks(shopJwk));

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
    const vaulted = input.vault_id !== undefined && input.vault_id !== null;
    if (vaulted && !vaultPay) return sendJson(res, 403, { error: 'this shop does not take saved-wallet payments' });
    if (vaulted && !VAULT_ID.test(String(input.vault_id))) return sendJson(res, 400, { error: 'vault_id is not a PayPal payment token ID' });

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
      payment_source: { paypal: vaulted ? { vault_id: String(input.vault_id) } : { experience_context: {
        brand_name: SHOP_NAME, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: `${origin}/paypal/return`, cancel_url: `${origin}/paypal/cancel`,
      } } },
    // A saved wallet is charged at once, so PayPal needs a request ID: the record hash, so the
    // same record can never be charged twice.
    }, vaulted ? { requestId: `blackbox-${input.record_hash}` } : undefined);
    if (!r.ok) return sendJson(res, 502, { error: 'PayPal order failed', status: r.status, debug_id: r.debugId, details: r.data });
    const approve = r.data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
    const cap = r.data.purchase_units?.[0]?.payments?.captures?.[0];
    const paid = r.data.status === 'COMPLETED' && cap ? { capture_id: cap.id, capture_status: cap.status } : null;
    sendJson(res, 201, { order_id: r.data.id, status: r.data.status ?? null, approve_url: approve, paid, sku: product.sku, amount: value, custom_id: input.record_hash });
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
      const v = url.pathname.match(/^\/v\/([a-z-]+)(\/.*)$/);
      const shown = v ? VARIANTS[v[1]] : main;
      const path = v ? v[2] : url.pathname;
      if (req.method === 'GET' && shown) {
        if (path === '/') return sendSigned(req, res, 200, categoryPage({ ...shown.ctx, base: v ? `/v/${v[1]}` : '' }));
        const m = path.match(/^\/p\/([A-Z0-9-]+)$/);
        if (m) {
          const product = shown.bySku(m[1]);
          if (!product) return sendSigned(req, res, 404, messagePage({ ...ctx, title: 'Not found', text: 'No such product.' }));
          return sendSigned(req, res, 200, productPage({ ...shown.ctx, product, signedReviews: shown.reviewsBySku[product.sku] }));
        }
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
