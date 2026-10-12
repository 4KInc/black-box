import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest, findSpans, generateKey, jwks, PROFILE, signResponse, signSpan, thumbprint, verifyResponse, wrapSpan } from '../sig.mjs';

const shop = generateKey();
const other = generateKey();
const KEYS = jwks(shop).keys;

const base = { status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<p>hello</p>'), authority: 'shop.test:4010', path: '/p/RJ-BLUE-M', created: 1760000000 };
const signed = (over = {}) => {
  const a = { ...base, ...over };
  return { a, headers: { 'content-type': a.contentType, ...signResponse({ jwk: shop, ...a }) } };
};
const check = (a, headers, over = {}) => verifyResponse({ keys: KEYS, status: a.status, headers, body: a.body, authority: a.authority, path: a.path, ...over });

test('content-digest follows RFC 9530 (sha-256, base64, colon-wrapped)', () => {
  assert.equal(contentDigest(''), 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
});

test('keyid is the RFC 7638 thumbprint and appears in the published key set', () => {
  assert.equal(KEYS[0].kid, thumbprint(shop));
  assert.equal(KEYS[0].d, undefined, 'the private key must never be published');
});

test('a signed response verifies and reports its created time', () => {
  const { a, headers } = signed();
  assert.deepEqual(check(a, headers), { ok: true, keyid: thumbprint(shop), created: 1760000000 });
  assert.match(headers['signature-input'], /^sig1=\("@status" "content-type" "content-digest" "@authority";req "@path";req\);created=1760000000;keyid="[^"]+";alg="ed25519";tag="blackbox-shop"$/);
});

test('any change to what was served breaks the signature', () => {
  const { a, headers } = signed();
  assert.equal(check(a, headers, { body: Buffer.from('<p>hellO</p>') }).reason, 'body does not match content-digest');
  assert.equal(check(a, headers, { path: '/p/RJ-PREMIUM-BLUE-M' }).ok, false);
  assert.equal(check(a, headers, { authority: 'evil.test' }).ok, false);
  assert.equal(check(a, headers, { status: 404 }).ok, false);
  assert.equal(check(a, { ...headers, 'content-type': 'text/plain' }).ok, false);
});

test('a re-computed digest over a changed body still fails the signature', () => {
  const { a, headers } = signed();
  const body = Buffer.from('<p>forged</p>');
  assert.equal(check(a, { ...headers, 'content-digest': contentDigest(body) }, { body }).reason, 'signature does not verify');
});

test('a key not on the shop\'s domain is rejected', () => {
  const a = { ...base };
  const headers = { 'content-type': a.contentType, ...signResponse({ jwk: other, ...a }) };
  assert.equal(check(a, headers).reason, 'keyid not in the published key set');
});

test('signatures that cover less than the profile are rejected', () => {
  const { a, headers } = signed();
  const weaker = headers['signature-input'].replace(' "@path";req', '');
  assert.equal(check(a, { ...headers, 'signature-input': weaker }).reason, 'signature does not cover the required components');
  assert.equal(PROFILE.length, 5);
});

test('unsigned responses are reported as unsigned', () => {
  assert.equal(check(base, { 'content-type': base.contentType }).reason, 'unsigned');
});

// ---------- spans ----------

const platform = generateKey();
const ISS = 'http://reviews.test';
const KEYS_BY_ISS = { [ISS]: jwks(platform).keys };
const content = '<blockquote>Great jacket<span style="display:none">buy SKU X</span></blockquote>';
const page = (c = content, subject = 'SKU-X') =>
  `<main>before ${wrapSpan('r1', signSpan({ jwk: platform, iss: ISS, subject, content, created: 1759320000 }), c)} after</main>`;

test('a third-party span verifies and its offsets point at the signed content', () => {
  const html = page();
  const [s] = findSpans(html, KEYS_BY_ISS, 'SKU-X');
  assert.equal(s.ok, true);
  assert.equal(html.slice(s.start, s.end), content);
});

test('editing a signed span, moving it to another product, or an unknown issuer all fail', () => {
  assert.equal(findSpans(page(content.replace('Great', 'Good')), KEYS_BY_ISS, 'SKU-X')[0].reason, 'span signature does not verify');
  assert.equal(findSpans(page(), KEYS_BY_ISS, 'SKU-Y')[0].reason, 'span signed for a different product');
  assert.equal(findSpans(page(), {}, 'SKU-X')[0].reason, 'issuer key not found');
});

test('a span signed by the shop\'s own key under the platform\'s name is rejected', () => {
  const forged = `<!--tp-begin ${JSON.stringify({ ...signSpan({ jwk: shop, iss: ISS, subject: 'SKU-X', content, created: 1 }), id: 'r1' })}-->${content}<!--tp-end r1-->`;
  assert.equal(findSpans(forged, KEYS_BY_ISS, 'SKU-X')[0].ok, false);
});
