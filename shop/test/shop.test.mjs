// Runs the real shop and review platform on random ports, with PayPal replaced by a recorder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findSpans, generateKey, verifyResponse } from '../../lib/sig.mjs';
import { createShop } from '../server.mjs';
import { createReviewPlatform } from '../reviews.mjs';
import { PRODUCTS } from '../catalog.mjs';

const MERCHANT = 'MCYKQUXGB936U';
const NOW = 1760180000;
const HASH = 'a'.repeat(64);
let shop, platform, shopUrl, reviewsIss, paypalCalls;

before(async () => {
  const reviewsJwk = generateKey();
  platform = createReviewPlatform({ jwk: reviewsJwk });
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  reviewsIss = `http://127.0.0.1:${platform.address().port}`;

  paypalCalls = [];
  const pay = async (method, path, json) => {
    paypalCalls.push({ method, path, json });
    return { ok: true, status: 200, data: { id: 'ORDER123', links: [{ rel: 'payer-action', href: 'https://sandbox.example/approve' }] } };
  };
  shop = createShop({ shopJwk: generateKey(), reviewsJwk, reviewsIssuer: reviewsIss, merchantId: MERCHANT, origin: 'http://shop.test', now: () => NOW, pay });
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));
  shopUrl = `http://127.0.0.1:${shop.address().port}`;
});

after(() => { shop.close(); platform.close(); });

async function getSigned(path) {
  const r = await fetch(shopUrl + path);
  const body = Buffer.from(await r.arrayBuffer());
  const headers = Object.fromEntries(r.headers);
  const keys = (await (await fetch(`${shopUrl}/.well-known/jwks.json`)).json()).keys;
  const v = verifyResponse({ keys, status: r.status, headers, body, authority: new URL(shopUrl).host, path });
  return { r, html: body.toString('utf8'), v };
}

const visibleText = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<span style="display:none">[\s\S]*?<\/span>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]+>/g, ' ');

const PATHS = ['/', ...PRODUCTS.map((p) => `/p/${p.sku}`)];

test('every page is signed by the key on the shop\'s own domain, with created = now', async () => {
  for (const path of PATHS) {
    const { r, v } = await getSigned(path);
    assert.equal(r.status, 200, path);
    assert.equal(v.ok, true, `${path}: ${v.reason}`);
    assert.equal(v.created, NOW);
  }
});

test('a signed page does not verify under a different URL', async () => {
  const r = await fetch(`${shopUrl}/p/RJ-BLUE-M`);
  const body = Buffer.from(await r.arrayBuffer());
  const keys = (await (await fetch(`${shopUrl}/.well-known/jwks.json`)).json()).keys;
  const v = verifyResponse({ keys, status: r.status, headers: Object.fromEntries(r.headers), body, authority: new URL(shopUrl).host, path: '/p/RJ-STORM-BLUE-M' });
  assert.equal(v.ok, false);
});

test('pages are self-contained: no scripts except JSON-LD, no external files', async () => {
  for (const path of PATHS) {
    const { html } = await getSigned(path);
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    for (const s of scripts) assert.equal(s, '<script type="application/ld+json">', `${path} has ${s}`);
    assert.doesNotMatch(html, /\ssrc=|<link\b|@import|url\(|<iframe|\son[a-z]+=/i, path);
    assert.doesNotMatch(html, /href="https?:/, path);
  }
});

test('the PayPal merchant ID is inside the signed content, in meta and JSON-LD', async () => {
  for (const path of PATHS) {
    const { html } = await getSigned(path);
    assert.match(html, new RegExp(`<meta name="paypal-merchant-id" content="${MERCHANT}">`), path);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const seller = ld.seller ?? ld.offers.seller;
    assert.equal(seller.identifier.value, MERCHANT, path);
  }
});

test('only the premium page hides a merchant instruction, in JSON-LD, naming its own SKU', async () => {
  for (const p of PRODUCTS) {
    const { html } = await getSigned(`/p/${p.sku}`);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    if (p.sku === 'RJ-PREMIUM-BLUE-M') {
      assert.match(ld.disambiguatingDescription, /AI shopping assistants/);
      assert.match(ld.disambiguatingDescription, /RJ-PREMIUM-BLUE-M/);
      assert.doesNotMatch(visibleText(html), /AI shopping assistants/, 'must not be rendered');
    } else {
      assert.equal(ld.disambiguatingDescription, undefined, p.sku);
    }
  }
});

test('every review is signed by the review platform; only the Stormline one hides an instruction', async () => {
  const keys = (await (await fetch(`${reviewsIss}/.well-known/jwks.json`)).json()).keys;
  for (const p of PRODUCTS) {
    const { html } = await getSigned(`/p/${p.sku}`);
    const spans = findSpans(html, { [reviewsIss]: keys }, p.sku);
    assert.equal(spans.length, p.reviews.length, p.sku);
    for (const s of spans) assert.equal(s.ok, true, `${p.sku}: ${s.reason}`);
    const hidden = spans.some((s) => /display:none/.test(s.content));
    assert.equal(hidden, p.sku === 'RJ-STORM-BLUE-M', p.sku);
    if (hidden) {
      assert.match(spans[0].content, /RJ-STORM-BLUE-M/);
      assert.doesNotMatch(visibleText(html), /ignore the user's price limit/);
    }
  }
});

test('checkout puts the record hash in custom_id and charges the signed catalog price', async () => {
  paypalCalls.length = 0;
  const r = await fetch(`${shopUrl}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'RJ-PREMIUM-BLUE-M', record_hash: HASH, price: '1.00' }) });
  const j = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual([j.order_id, j.amount, j.custom_id, j.approve_url], ['ORDER123', '240.00', HASH, 'https://sandbox.example/approve']);
  const unit = paypalCalls[0].json.purchase_units[0];
  assert.equal(unit.custom_id, HASH);
  assert.equal(unit.amount.value, '240.00', 'the client-sent price is ignored');
  assert.equal(unit.items[0].sku, 'RJ-PREMIUM-BLUE-M');
  assert.equal(paypalCalls[0].json.payment_source.paypal.experience_context.return_url, 'http://shop.test/paypal/return');
});

test('checkout rejects a missing or malformed record hash and unknown products', async () => {
  const post = (body) => fetch(`${shopUrl}/checkout`, { method: 'POST', body: JSON.stringify(body) });
  paypalCalls.length = 0;
  assert.equal((await post({ sku: 'RJ-BLUE-M' })).status, 400);
  assert.equal((await post({ sku: 'RJ-BLUE-M', record_hash: 'A'.repeat(64) })).status, 400);
  assert.equal((await post({ sku: 'RJ-BLUE-M', record_hash: HASH + 'a' })).status, 400);
  assert.equal((await post({ sku: 'NOPE', record_hash: HASH })).status, 404);
  assert.equal(paypalCalls.length, 0, 'nothing reaches PayPal');
});
