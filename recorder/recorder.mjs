// The Black Box recorder. While the agent shops, it keeps:
//   - the mandate the user signed
//   - every page fetched, byte for byte, with its signature headers and the shop's published keys
//   - the keys of any third party that signed part of a page
//   - every model input, exactly as sent to the model, and every decision the agent made
//   - the purchase
// seal() freezes the record and returns its hash, which goes to checkout and into custom_id.
// At dispute time, recordFacts() re-checks everything from the stored record alone and returns
// the five record-integrity facts the verdict engine needs.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../lib/canonical.mjs';
import { findSpans, verifyResponse } from '../lib/sig.mjs';

export const RECORD_VERSION = 'blackbox-record-v1';
const sha = (data) => createHash('sha256').update(data).digest('hex');
export const recordHash = (record) => sha(canonicalize(record));

const SIG_HEADERS = ['content-type', 'content-digest', 'signature-input', 'signature'];
const TP_ISSUER = /<!--tp-begin (\{.*?\})-->/g;

function issuersIn(html) {
  const out = new Set();
  for (const m of html.matchAll(TP_ISSUER)) {
    try { const iss = JSON.parse(m[1]).iss; if (/^https?:\/\//.test(iss)) out.add(new URL(iss).origin); } catch { /* unreadable: ignored */ }
  }
  return [...out];
}

export class Recorder {
  #record;
  #sealed = null;
  #fetch;
  #now;
  #jwksCache = new Map();

  constructor({ mandate, fetch: f = fetch, now = () => new Date().toISOString() }) {
    this.#fetch = f;
    this.#now = now;
    this.#record = { version: RECORD_VERSION, mandate, mandate_hash: sha(canonicalize(mandate)), fetches: [], issuer_keys: {}, model_inputs: [], decisions: [], purchase: null };
  }

  #assertOpen() { if (this.#sealed) throw new Error('record is sealed'); }

  async #keySet(origin) {
    const url = `${origin}/.well-known/jwks.json`;
    if (!this.#jwksCache.has(url)) {
      const r = await this.#fetch(url);
      const keys = r.ok ? (await r.json()).keys ?? [] : [];
      this.#jwksCache.set(url, { url, keys });
    }
    return this.#jwksCache.get(url);
  }

  // Fetches a page, records it exactly, and verifies it against the key set on the page's own origin.
  async fetchSigned(url) {
    this.#assertOpen();
    const u = new URL(url);
    const r = await this.#fetch(u.href);
    const body = Buffer.from(await r.arrayBuffer());
    const headers = Object.fromEntries(SIG_HEADERS.map((h) => [h, r.headers.get(h)]).filter(([, v]) => v !== null));
    const shopKeys = await this.#keySet(u.origin);

    const html = body.toString('utf8');
    for (const iss of issuersIn(html)) {
      if (!this.#record.issuer_keys[iss]) this.#record.issuer_keys[iss] = await this.#keySet(iss);
    }
    const keysByIssuer = Object.fromEntries(Object.entries(this.#record.issuer_keys).map(([iss, k]) => [iss, k.keys]));

    const verification = verifyResponse({ keys: shopKeys.keys, status: r.status, headers, body, authority: u.host, path: u.pathname + u.search });
    const spans = findSpans(html, keysByIssuer).map(({ content, ...s }) => s);
    const entry = {
      index: this.#record.fetches.length,
      url: u.href, authority: u.host, path: u.pathname + u.search, fetched_at: this.#now(),
      status: r.status, headers, body_b64: body.toString('base64'), body_sha256: sha(body),
      shop_keys: shopKeys, verification, spans,
    };
    this.#record.fetches.push(entry);
    return { index: entry.index, html, status: r.status, verification, spans };
  }

  // Exactly the text sent to the model, so the extractor can later show the agent read it.
  modelInput(step, text) {
    this.#assertOpen();
    this.#record.model_inputs.push({ step, at: this.#now(), sha256: sha(text), text });
  }

  decision(step, decision) {
    this.#assertOpen();
    this.#record.decisions.push({ step, at: this.#now(), ...decision });
  }

  // page_index points at the fetched product page the agent bought from.
  purchase({ sku, page_index, price_cents }) {
    this.#assertOpen();
    if (!this.#record.fetches[page_index]) throw new RangeError(`no fetched page ${page_index}`);
    this.#record.purchase = { sku, page_index, price_cents, at: this.#now() };
  }

  seal() {
    if (!this.#record.purchase) throw new Error('nothing was purchased');
    if (!this.#sealed) {
      const record = structuredClone(this.#record);
      this.#sealed = { record, hash: recordHash(record) };
    }
    return this.#sealed;
  }
}

// ---------- dispute time ----------

const merchantIdIn = (html) => html.match(/<meta name="paypal-merchant-id" content="([^"]+)">/)?.[1] ?? null;

// order = what PayPal says at dispute time: { customId, payeeMerchantId, createdAt (ISO) }.
// Everything else is re-derived from the stored record; nothing is re-fetched.
export function recordFacts(record, order) {
  const problems = [];
  const fetches = record.fetches ?? [];

  const hashOk = recordHash(record) === order.customId;
  if (!hashOk) problems.push('record hash does not equal the order custom_id');
  const bodiesOk = fetches.every((f) => sha(Buffer.from(f.body_b64, 'base64')) === f.body_sha256);
  if (!bodiesOk) problems.push('a stored page does not match its own hash');

  const reverified = fetches.map((f) => verifyResponse({
    keys: f.shop_keys.keys, status: f.status, headers: f.headers,
    body: Buffer.from(f.body_b64, 'base64'), authority: f.authority, path: f.path,
  }));
  const signaturesOk = fetches.length > 0 && reverified.every((v) => v.ok);
  reverified.forEach((v, i) => { if (!v.ok) problems.push(`page ${i} (${fetches[i].path}): ${v.reason}`); });

  const keyOnDomain = fetches.every((f) => f.shop_keys.url === `${new URL(f.url).origin}/.well-known/jwks.json` && f.shop_keys.keys.length > 0);
  if (!keyOnDomain) problems.push('a page key set was not fetched from the page\'s own domain');

  const page = fetches[record.purchase?.page_index];
  const signedMerchantId = page ? merchantIdIn(Buffer.from(page.body_b64, 'base64').toString('utf8')) : null;
  const payeeOk = signedMerchantId !== null && signedMerchantId === order.payeeMerchantId;
  if (!payeeOk) problems.push(`signed merchant ID ${signedMerchantId} does not equal PayPal payee ${order.payeeMerchantId}`);

  const orderAt = Math.floor(Date.parse(order.createdAt) / 1000);
  const beforeOk = Number.isFinite(orderAt) && reverified.every((v) => v.ok && v.created <= orderAt);
  if (!beforeOk) problems.push('a signature is newer than the order (or the order time is unknown)');

  return {
    facts: {
      hashesMatch: hashOk && bodiesOk,
      signaturesValid: signaturesOk,
      keyOnShopDomain: keyOnDomain,
      payeeMatches: payeeOk,
      signedBeforeOrder: beforeOk,
    },
    signedMerchantId,
    problems,
  };
}

// ---------- storage ----------

export function saveRecord(dir, { record, hash }) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

export function loadRecord(dir, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('not a record hash');
  return JSON.parse(readFileSync(join(dir, `${hash}.json`), 'utf8'));
}
