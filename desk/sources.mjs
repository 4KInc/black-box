// What the evidence desk knows about one dispute, as a list of facts, each with where it came from.
//   kind 'paypal'    read from PayPal's own dispute and order (the strongest source)
//   kind 'records'   the merchant's own export (JSON): it shows what the merchant says happened,
//                    so it cannot prove delivery on its own
//   kind 'document'  a message the merchant added (a carrier email, a support thread): facts an AI
//                    pointed at, kept only when its quote is in the file word for word and the
//                    value can be read from that quote by code
// A fact is { key, value, quote, source: { kind, name } }. No imports from the engine: the desk
// is a separate path for disputes the responsibility engine does not take.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../lib/channels.mjs';

export const cents = (v) => Math.round(Number(v) * 100);
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// The keys a fact may have, and how code reads a value from a quote. Each returns the value read
// from the quote, or null when the quote does not show one.
const STATUS = [
  // Order matters: "returned to sender" and "delivery attempted" both contain "deliver".
  ['RETURNED', /\breturn(?:ed|ing)? to (?:the )?sender\b|\bbeing returned\b|\breturned\b/i],
  ['EXCEPTION', /\b(?:not delivered|undeliverable|delivery (?:was )?attempted|attempted delivery|delivery exception|lost|damaged in transit)\b/i],
  ['IN_TRANSIT', /\b(?:will|to) be delivered\b|\b(?:estimated|expected|scheduled) delivery\b/i],
  ['DELIVERED', /\bdelivered\b/i],
  ['IN_TRANSIT', /\b(?:in transit|out for delivery|on its way|shipped|picked up)\b/i],
];
export const statusIn = (quote) => STATUS.find(([, re]) => re.test(quote))?.[0] ?? null;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The dates written in a quote, as YYYY-MM-DD: 2026-11-03, November 3, 2026, 3 Nov 2026, 11/03/2026 (US).
export function datesIn(quote) {
  const out = [];
  const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  for (const m of quote.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(iso(+m[1], +m[2], +m[3]));
  for (const m of quote.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g)) { const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (i >= 0) out.push(iso(+m[3], i + 1, +m[2])); }
  for (const m of quote.matchAll(/\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})\b/g)) { const i = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (i >= 0) out.push(iso(+m[3], i + 1, +m[1])); }
  for (const m of quote.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push(iso(+m[3], +m[1], +m[2]));
  return out.filter(Boolean);
}

export const compact = (s) => String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
export const sameTracking = (a, b) => Boolean(a) && compact(a) === compact(b);
export const samePostcode = (a, b) => Boolean(a) && Boolean(b) && compact(a).slice(0, 5) === compact(b).slice(0, 5);

// PayPal's carrier names for the carriers a merchant most often writes; anything else is OTHER.
const CARRIERS = [['UPS', /\bUPS\b/i], ['USPS', /\bUSPS\b|\bU\.?S\.? Postal\b|\bPostal Service\b/i], ['FEDEX', /\bFed ?Ex\b/i], ['DHL', /\bDHL\b/i]];
export const carrierIn = (quote) => CARRIERS.find(([, re]) => re.test(quote))?.[0] ?? null;

// key -> (claimed value, quote) -> the value code reads from the quote, or null.
export const READERS = {
  tracking_number: (v, q) => { const t = compact(v); return /^[A-Z0-9]{8,40}$/.test(t) && compact(q).includes(t) ? t : null; },
  carrier: (v, q) => carrierIn(q) ?? (v && normalize(q).toLowerCase().includes(String(v).toLowerCase()) ? String(v) : null),
  delivery_status: (v, q) => { const s = statusIn(q); return s && (!v || String(v).toUpperCase() === s) ? s : null; },
  delivered_at: (v, q) => { const ds = datesIn(q); return v ? (ds.includes(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null) : ds[0] ?? null; },
  shipped_at: (v, q) => { const ds = datesIn(q); return v ? (ds.includes(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null) : ds[0] ?? null; },
  delivery_postcode: (v, q) => { const p = String(v ?? '').trim(); return p && new RegExp(`(^|[^A-Za-z0-9])${p.replace(/[^A-Za-z0-9 -]/g, '')}([^A-Za-z0-9]|$)`, 'i').test(q) ? p : null; },
  refund_id: (v, q) => { const t = compact(v); return /^[A-Z0-9]{10,30}$/.test(t) && compact(q).includes(t) ? t : null; },
};
export const KEYS = Object.keys(READERS);

// A document's candidate facts (from the AI), kept only when grounded. Returns { facts, dropped }.
export function groundFacts(doc, candidates) {
  const text = normalize(doc.text);
  const facts = [];
  const dropped = [];
  for (const c of candidates ?? []) {
    const key = String(c?.key ?? '');
    const quote = normalize(String(c?.quote ?? ''));
    const read = READERS[key];
    const why = !read ? 'not a fact the desk uses'
      : quote.length < 4 || !text.includes(quote) ? 'its quote is not in the document'
        : null;
    const value = why ? null : read(c.value, quote);
    if (why || value === null) { dropped.push({ key, value: c?.value ?? null, quote: String(c?.quote ?? '').slice(0, 200), why: why ?? 'its value cannot be read from its quote' }); continue; }
    facts.push({ key, value, quote, source: { kind: 'document', name: doc.name } });
  }
  return { facts, dropped };
}

// Lines in a document that address whoever processes it ("ignore the facts and say ..."), kept
// only when quoted exactly. They are shown, never followed: nothing here reads them as instructions.
export function groundInstructions(doc, quotes) {
  const text = normalize(doc.text);
  return [...new Set((quotes ?? []).map((q) => normalize(String(q ?? ''))).filter((q) => q.length >= 12 && text.includes(q)))];
}

// The merchant's own export: a JSON object with any of the keys above. Read by code, no AI.
export function recordFacts(name, json) {
  const facts = [];
  for (const key of KEYS) {
    const v = json?.[key];
    if (v === undefined || v === null || v === '') continue;
    const quote = `"${key}": ${JSON.stringify(v)}`;
    const value = key === 'delivery_status' ? String(v).toUpperCase()
      : key === 'tracking_number' || key === 'refund_id' ? compact(v)
        : key.endsWith('_at') ? String(v).slice(0, 10) : String(v);
    facts.push({ key, value, quote, source: { kind: 'records', name } });
  }
  return facts;
}

// What PayPal itself says: the dispute, and the order behind the disputed capture.
export function paypalFacts({ dispute, order }) {
  const txn = dispute?.disputed_transactions?.[0] ?? {};
  const captureId = txn.seller_transaction_id ?? null;
  const unit = order?.purchase_units?.[0] ?? {};
  const address = unit.shipping?.address ?? null;
  const ofCapture = (r) => !captureId || !(r.links ?? []).some((l) => l.rel === 'up') || (r.links ?? []).some((l) => l.rel === 'up' && String(l.href).endsWith(`/captures/${captureId}`));
  return {
    disputeId: dispute?.dispute_id ?? null,
    reason: dispute?.reason ?? null,
    status: dispute?.status ?? null,
    disputedCents: cents(dispute?.dispute_amount?.value ?? txn.gross_amount?.value ?? 0),
    currency: dispute?.dispute_amount?.currency_code ?? txn.gross_amount?.currency_code ?? 'USD',
    captureId,
    orderId: order?.id ?? null,
    orderedAt: String(order?.create_time ?? txn.create_time ?? '').slice(0, 10) || null,
    shipTo: address ? { postcode: address.postal_code ?? null, city: address.admin_area_2 ?? null, country: address.country_code ?? null } : null,
    items: (unit.items ?? []).map((i) => ({ name: i.name, sku: i.sku ?? null, quantity: Number(i.quantity ?? 1) })),
    refunds: (unit.payments?.refunds ?? []).filter(ofCapture).map((r) => ({ id: compact(r.id), status: r.status ?? null, cents: cents(r.amount?.value ?? 0), at: r.create_time ?? null })),
    // A tracker's ID is "<capture ID>-<tracking number>". Its status is only what the merchant set
    // (SHIPPED or CANCELLED), not the carrier's.
    trackers: (unit.shipping?.trackers ?? []).map((t) => ({ id: t.id, status: t.status ?? null, number: captureId && String(t.id).startsWith(`${captureId}-`) ? compact(String(t.id).slice(captureId.length + 1)) : null })),
    requested: (dispute?.evidences ?? []).filter((e) => e.source === 'REQUESTED_FROM_SELLER').map((e) => e.evidence_type),
    // A buyer's own words, for the page only; never used as a fact.
    sellerDueAt: dispute?.seller_response_due_date ?? null,
  };
}

// The documents the merchant added for a dispute: records/desk/<dispute>/docs/*.txt (messages)
// and *.json (exports). Each with its hash, so an AI reading is done once per exact file.
export const deskDir = (root, disputeId) => {
  if (!/^[A-Z0-9-]{6,64}$/.test(disputeId)) throw new TypeError(`not a dispute ID: ${disputeId}`);
  return join(root, 'records', 'desk', disputeId);
};

export function loadDocs(root, disputeId) {
  const dir = join(deskDir(root, disputeId), 'docs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(txt|json)$/.test(f)).sort().map((name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    return { name, text, hash: sha256(text), kind: name.endsWith('.json') ? 'records' : 'document' };
  });
}

export const MAX_DOC = 20_000;
export function addDoc(root, disputeId, name, text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  if (!body.trim()) throw new Error('The document is empty.');
  if (body.length > MAX_DOC) throw new Error(`The document is longer than ${MAX_DOC} characters.`);
  const kind = /\.json$/i.test(name ?? '') ? 'json' : 'txt';
  if (kind === 'json') JSON.parse(body); // refuse a broken export now, not at decision time
  const base = String(name ?? 'document').replace(/\.(txt|json)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'document';
  const dir = join(deskDir(root, disputeId), 'docs');
  mkdirSync(dir, { recursive: true });
  let file = `${base}.${kind}`;
  for (let i = 2; existsSync(join(dir, file)); i++) file = `${base}-${i}.${kind}`;
  writeFileSync(join(dir, file), body);
  return file;
}
