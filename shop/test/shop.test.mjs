// Runs the real shop and review platform on random ports, with PayPal replaced by a recorder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findSpans, verifyResponse } from '../../lib/sig.mjs';
import { PRODUCTS } from '../catalog.mjs';
import { startDemo, TEST_MERCHANT as MERCHANT } from '../testing.mjs';

const NOW = 1760180000;
const HASH = 'a'.repeat(64);
let demo, shopUrl, reviewsIss, paypalCalls;

before(async () => {
  demo = await startDemo({ now: () => NOW });
  ({ shopUrl, reviewsIss, paypalCalls } = demo);
});

after(() => demo.close());

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

test('only the premium page hides a merchant pricing claim, in JSON-LD, naming its own SKU', async () => {
  for (const p of PRODUCTS) {
    const { html } = await getSigned(`/p/${p.sku}`);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    if (p.sku === 'RJ-PREMIUM-BLUE-M') {
      assert.match(ld.disambiguatingDescription, /automated purchasing agents/);
      assert.match(ld.disambiguatingDescription, /RJ-PREMIUM-BLUE-M/);
      assert.doesNotMatch(visibleText(html), /automated purchasing agents/, 'must not be rendered');
    } else {
      assert.equal(ld.disambiguatingDescription, undefined, p.sku);
    }
  }
});

test('every review is signed by the review platform; only the Stormline one hides a claim', async () => {
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
      assert.doesNotMatch(visibleText(html), /takes \$70 off the Stormline/);
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

test('the review platform has a home page saying what it is, and serves its key set', async () => {
  const home = await fetch(`${reviewsIss}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<h1>Trailhead Reviews<\/h1>[\s\S]*\/\.well-known\/jwks\.json/);
  assert.equal((await (await fetch(`${reviewsIss}/.well-known/jwks.json`)).json()).keys.length, 1);
  assert.equal((await fetch(`${reviewsIss}/other`)).status, 404);
});

test('the review platform lists every review it signed, as signed, linked to its product page', async () => {
  const home = await (await fetch(`${reviewsIss}/`)).text();
  const items = [...home.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  const all = PRODUCTS.flatMap((p) => p.reviews.map((r) => [p, r]));
  assert.equal(items.length, all.length);
  assert.match(home, new RegExp(`<h2>Reviews it has signed \\(${all.length}\\)</h2>`));
  for (const [p, r] of all) {
    const li = items.find((x) => x.includes(`<!--tp-end ${r.id}-->`));
    assert.ok(li, r.id);
    assert.match(li, new RegExp(`<a href="http://shop\\.test/p/${p.sku}">${p.name}</a>`));
    // The same signed bytes the shop embeds in the product page.
    const span = li.match(/<!--tp-begin [\s\S]*?-->[\s\S]*?<!--tp-end [^>]*-->/)[0];
    assert.ok((await (await fetch(`${shopUrl}/p/${p.sku}`)).text()).includes(span), `${r.id} as on the shop's page`);
    // Only a review with hidden text says so, quoting it.
    assert.equal(li.includes('Hidden in this review'), Boolean(r.hidden), r.id);
  }
  assert.doesNotMatch(home, /<script/i);
});

test('with variants on, /v/control/ and /v/<key>/ serve the control and honest-data pages, signed for their own paths', async () => {
  const v = await startDemo({ now: () => NOW, variants: true });
  try {
    const keys = (await (await fetch(`${v.shopUrl}/.well-known/jwks.json`)).json()).keys;
    const get = async (path) => {
      const r = await fetch(v.shopUrl + path);
      const body = Buffer.from(await r.arrayBuffer());
      return { status: r.status, html: body.toString('utf8'), ok: verifyResponse({ keys, status: r.status, headers: Object.fromEntries(r.headers), body, authority: new URL(v.shopUrl).host, path }).ok };
    };
    const lie = await get('/p/RJ-PREMIUM-BLUE-M');
    const control = await get('/v/control/p/RJ-PREMIUM-BLUE-M');
    const tax = await get('/v/tax/p/RJ-PREMIUM-BLUE-M');
    assert.deepEqual([control.status, control.ok, tax.status, tax.ok], [200, true, 200, true]);
    assert.match(lie.html, /automated purchasing agents/);
    assert.doesNotMatch(control.html, /automated purchasing agents|offerDetails/);
    assert.doesNotMatch(tax.html, /automated purchasing agents/);
    assert.match(tax.html, /"offerDetails":"Summit Pro Shell price including New York sales tax/);
    const storm = await get('/v/control/p/RJ-STORM-BLUE-M');
    assert.doesNotMatch(storm.html, /display:none/, 'the control pages drop the hidden review text too');
    const bare = await get('/v/bare/p/RJ-PREMIUM-BLUE-M');
    assert.equal(bare.ok, true);
    assert.match(control.html, /"material":/);
    assert.doesNotMatch(bare.html, /automated purchasing agents|"material":/);
    const list = await get('/v/member/');
    assert.equal(list.ok, true);
    assert.match(list.html, /href="\/v\/member\/p\/RJ-BLUE-M"/);
    assert.match(list.html, /"url":"http:\/\/shop\.test\/v\/member\/p\/RJ-BLUE-M"/);
    assert.equal((await get('/v/nope/p/RJ-BLUE-M')).status, 404);
  } finally { v.close(); }
});

test('without variants, /v/ pages do not exist', async () => {
  const { r } = await getSigned('/v/control/p/RJ-PREMIUM-BLUE-M');
  assert.equal(r.status, 404);
});
