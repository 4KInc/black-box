// Signing and verification for Black Box. Ed25519 only, no dependencies.
//
// 1. Response signatures: the subset of RFC 9421 (HTTP Message Signatures) that Black Box uses,
//    with RFC 9530 Content-Digest. Every shop response is signed over its status, content type,
//    body digest, and the authority and path of the request that fetched it, so a signed page
//    cannot be replayed under another URL or with another body.
// 2. Third-party span signatures: a review platform signs one span of the page, marked with
//    HTML comments. This is how content is shown NOT to be the merchant's.
//
// The verifier is deliberately strict: it only accepts signatures covering exactly PROFILE.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// ---------- keys ----------

export function generateKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'jwk' });
}

// RFC 7638 JWK thumbprint, used as the keyid.
export function thumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64u(createHash('sha256').update(canonical).digest());
}

export function publicJwk(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: thumbprint(jwk), alg: 'EdDSA', use: 'sig' };
}

export function jwks(...privateJwks) {
  return { keys: privateJwks.map(publicJwk) };
}

const privKey = (jwk) => createPrivateKey({ key: jwk, format: 'jwk' });
const pubKey = (jwk) => createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });

// ---------- RFC 9530 Content-Digest ----------

export function contentDigest(body) {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

// ---------- RFC 9421 response signatures ----------

export const LABEL = 'sig1';
export const TAG = 'blackbox-shop';
export const PROFILE = ['"@status"', '"content-type"', '"content-digest"', '"@authority";req', '"@path";req'];

function componentValues({ status, contentType, digest, authority, path }) {
  return [String(status), contentType, digest, authority.toLowerCase(), path];
}

function signatureParams({ created, keyid }) {
  return `(${PROFILE.join(' ')});created=${created};keyid="${keyid}";alg="ed25519";tag="${TAG}"`;
}

function signatureBase(values, params) {
  const lines = PROFILE.map((c, i) => `${c}: ${values[i]}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

// Returns the headers to add to the response.
export function signResponse({ jwk, status, contentType, body, authority, path, created = Math.floor(Date.now() / 1000) }) {
  const digest = contentDigest(body);
  const params = signatureParams({ created, keyid: thumbprint(jwk) });
  const base = signatureBase(componentValues({ status, contentType, digest, authority, path }), params);
  const sig = sign(null, Buffer.from(base), privKey(jwk)).toString('base64');
  return {
    'content-digest': digest,
    'signature-input': `${LABEL}=${params}`,
    signature: `${LABEL}=:${sig}:`,
  };
}

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// keys: an array of public JWKs (the JWKS published on the shop's own domain).
export function verifyResponse({ keys, status, headers, body, authority, path }) {
  const h = (n) => headers[n] ?? headers[n.toLowerCase()];
  const input = h('signature-input');
  const signature = h('signature');
  if (!input || !signature) return fail('unsigned');

  const m = input.match(/^sig1=\(([^)]*)\);created=(\d+);keyid="([^"]+)";alg="ed25519";tag="([^"]+)"$/);
  if (!m) return fail('signature-input not in the Black Box profile');
  const [, covered, createdStr, keyid, tag] = m;
  if (covered !== PROFILE.join(' ')) return fail('signature does not cover the required components');
  if (tag !== TAG) return fail('wrong tag');

  const s = signature.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  if (!s) return fail('malformed signature header');

  if (h('content-digest') !== contentDigest(body)) return fail('body does not match content-digest');

  const key = keys.find((k) => k.kid === keyid);
  if (!key) return fail('keyid not in the published key set', { keyid });

  const created = Number(createdStr);
  const params = signatureParams({ created, keyid });
  const base = signatureBase(componentValues({ status, contentType: h('content-type'), digest: h('content-digest'), authority, path }), params);
  const ok = verify(null, Buffer.from(base), pubKey(key), Buffer.from(s[1], 'base64'));
  return ok ? { ok: true, keyid, created } : fail('signature does not verify', { keyid, created });
}

// ---------- third-party span signatures ----------
//
// <!--tp-begin {"id":"r1","iss":"http://reviews.local","keyid":"...","created":1760000000,"subject":"SKU","sig":"..."}-->
// ...signed content, byte for byte...
// <!--tp-end r1-->

const spanPayload = ({ iss, keyid, created, subject, content }) =>
  ['blackbox-tp-v1', iss, keyid, created, subject, sha256hex(content)].join('\n');

export function signSpan({ jwk, iss, subject, content, created }) {
  const meta = { id: null, iss, keyid: thumbprint(jwk), created, subject };
  const sig = b64u(sign(null, Buffer.from(spanPayload({ ...meta, content })), privKey(jwk)));
  return { ...meta, sig };
}

export function wrapSpan(id, signed, content) {
  return `<!--tp-begin ${JSON.stringify({ ...signed, id })}-->${content}<!--tp-end ${id}-->`;
}

// Finds every third-party span in a page. keysByIssuer: { [iss]: [public JWK] }.
// Character offsets are into the page string, so the concealment extractor can test coverage.
export function findSpans(html, keysByIssuer, expectedSubject) {
  const spans = [];
  const re = /<!--tp-begin (\{.*?\})-->/g;
  let m;
  while ((m = re.exec(html))) {
    let meta;
    try { meta = JSON.parse(m[1]); } catch { spans.push({ ok: false, reason: 'unreadable span header', start: m.index }); continue; }
    const start = m.index + m[0].length;
    const endTag = `<!--tp-end ${meta.id}-->`;
    const end = html.indexOf(endTag, start);
    if (end < 0) { spans.push({ id: meta.id, ok: false, reason: 'span never closed', start }); continue; }
    const content = html.slice(start, end);
    const base = { id: meta.id, iss: meta.iss, start, end, content };
    const key = (keysByIssuer[meta.iss] ?? []).find((k) => k.kid === meta.keyid);
    if (!key) { spans.push({ ...base, ok: false, reason: 'issuer key not found' }); continue; }
    if (expectedSubject && meta.subject !== expectedSubject) { spans.push({ ...base, ok: false, reason: 'span signed for a different product' }); continue; }
    const ok = verify(null, Buffer.from(spanPayload({ ...meta, content })), pubKey(key), Buffer.from(meta.sig, 'base64url'));
    spans.push(ok ? { ...base, ok: true, created: meta.created, subject: meta.subject } : { ...base, ok: false, reason: 'span signature does not verify' });
  }
  return spans;
}
