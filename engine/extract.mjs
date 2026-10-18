// Concealment extractor: deterministic code that finds text a person would not see but the
// agent reads (JSON-LD, meta, textContent), then turns each hidden text into a finding for
// engine/findings.mjs. Hiding methods outside those channels are not counted, because the
// agent could not have read them.
//
// Counted: JSON-LD or meta text never rendered; display:none; visibility:hidden; off-screen
// positioning; zero size or zero font; text coloured like its background; aria-hidden.
// Works on the self-contained pages Black Box requires (inline CSS, no scripts).

import { createHash } from 'node:crypto';
import { decodeEntities, jsonLdBlocks, normalize, stripTags } from '../lib/channels.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

const HIDING = [
  ['display:none', /display\s*:\s*none/i],
  ['visibility:hidden', /visibility\s*:\s*hidden/i],
  ['off-screen', /(?:left|top|right|text-indent)\s*:\s*-\d{3,}(?:px|em|rem)/i],
  ['zero size', /(?:^|;)\s*(?:width|height|max-width|max-height)\s*:\s*0(?:px)?\s*(?:;|$)/i],
  ['zero font', /font-size\s*:\s*0(?:px|em|rem)?\s*(?:;|$)/i],
];

function hidingMethod(style, pageBg) {
  for (const [name, re] of HIDING) if (re.test(style)) return name;
  const color = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]?.trim().toLowerCase();
  const bg = style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]?.trim().toLowerCase() ?? pageBg;
  if (color && bg && color === bg) return 'coloured like its background';
  return null;
}

// Classes that a <style> block hides, e.g. .sr-x{display:none}.
function hiddenClasses(html, pageBg) {
  const out = new Map();
  for (const css of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rule of css[1].matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
      const method = hidingMethod(rule[2], pageBg);
      if (method) out.set(rule[1], method);
    }
  }
  return out;
}

function pageBackground(html) {
  return html.match(/body\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-f]{3,6}|[a-z]+)\s*[;}]/i)?.[1]?.toLowerCase() ?? null;
}

// Returns [{start, end}] of the element whose opening tag starts at `start`.
function elementEnd(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return re.lastIndex;
  }
  return html.length;
}

function hiddenElements(html) {
  const pageBg = pageBackground(html);
  const classes = hiddenClasses(html, pageBg);
  const out = [];
  const bodyStart = html.search(/<body\b/i);
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    if (m.index < bodyStart) continue;
    const [open, tag, attrs] = m;
    if (/^(script|style)$/i.test(tag)) continue;
    let method = null;
    const style = attrs.match(/\sstyle="([^"]*)"/i)?.[1];
    if (style) method = hidingMethod(style, pageBg);
    if (!method && /\saria-hidden="true"/i.test(attrs)) method = 'aria-hidden';
    if (!method) {
      const cls = attrs.match(/\sclass="([^"]*)"/i)?.[1]?.split(/\s+/) ?? [];
      const hit = cls.find((c) => classes.has(c));
      if (hit) method = classes.get(hit);
    }
    if (!method) continue;
    const end = open.endsWith('/>') ? m.index + open.length : elementEnd(html, tag, m.index);
    const text = stripTags(html.slice(m.index + open.length, end));
    if (text) out.push({ channel: 'text', method, text, start: m.index, end });
  }
  // Keep only outermost hidden elements, so nested hidden text is reported once.
  return out.filter((e) => !out.some((o) => o !== e && o.start <= e.start && o.end >= e.end));
}

function visibleText(html, hidden) {
  let s = html;
  for (const h of [...hidden].sort((a, b) => b.start - a.start)) s = s.slice(0, h.start) + ' ' + s.slice(h.end);
  return stripTags(s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s).toLowerCase();
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const MIN_WORDS = 5; // shorter strings are structure (names, SKUs, URLs), not instructions

function* strings(value, path = '') {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
}

// All hidden texts on a page, with offsets into the page string.
export function findHidden(html) {
  const elements = hiddenElements(html);
  const visible = visibleText(html, elements);
  const out = [...elements];

  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const [obj] = jsonLdBlocks(block[0]);
    for (const [path, value] of strings(obj)) {
      const text = normalize(value);
      if (wordCount(text) >= MIN_WORDS && !visible.includes(text.toLowerCase())) {
        out.push({ channel: 'json-ld', method: 'JSON-LD field never rendered', path, text, start: block.index, end: block.index + block[0].length });
      }
    }
  }
  for (const m of html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"\s*\/?>/gi)) {
    const text = normalize(decodeEntities(m[2]));
    if (wordCount(text) >= MIN_WORDS && !visible.includes(text.toLowerCase())) {
      out.push({ channel: 'meta', method: 'meta content never rendered', path: m[1], text, start: m.index, end: m.index + m[0].length });
    }
  }
  return out.map((h) => ({ ...h, textHash: sha(h.text) }));
}

// Black Box pages must be self-contained: nothing outside the signed bytes can change them.
export function isSelfContained(html) {
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  if (scripts.some((s) => !/^<script type="application\/ld\+json">$/i.test(s))) return false;
  return !/\ssrc=|<link\b|@import|url\(|<iframe|<object|<embed|\son[a-z]+=/i.test(html);
}

export function mentionsItem(text, { sku, name }) {
  const t = text.toLowerCase();
  return (sku && t.includes(sku.toLowerCase())) || (name && t.includes(name.toLowerCase()));
}

// Does a hidden text contradict what the merchant signed for this item? Under the policy a "yes"
// costs the merchant the whole payment, so it is deliberately narrow. It is "yes" if the text
//   - tells the agent to set aside the buyer's limits, or
//   - states a price for this item, in the order's currency, valid when the order was placed,
//     other than the signed price.
// Accurate structured data often carries other prices, and none of these count: another variant
// or SKU, a price range, a former price, shipping, tax or fees, another currency, a price for
// another audience (members, students, bulk), or a sale outside its stated dates. A price aimed
// at AI agents always counts: no other audience can make that legitimate. Each sentence is judged
// on its own, so an honest sentence cannot excuse a lie next to it.
const MONEY = /(?:\b(USD|US|CA|C|A|AU|NZ|HK|S|SG|MX)\s?)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?:\s?(USD|CAD|AUD|NZD|HKD|SGD|MXN)\b)?/g;
const OVERRIDE = /\b(?:ignore|disregard|override|bypass|set aside)\b[^.]{0,60}?\b(?:budget|limit|cap|mandate|instructions?|spending)/i;
const AGENT = /\b(?:AI|agents?|agentic|assistants?|bots?|automated|LLMs?)\b/i;
const RANGE = /\b(?:prices? (?:range|vary)|ranges? from|ranging from|from|starting at|starts at|as low as|up to|between)\s*(?:[A-Z]{1,3})?\$|\b(?:lowPrice|highPrice)\b|\$\s?[\d,.]+\s?(?:-|–|—|to)\s?(?:[A-Z]{1,3})?\$/i;
const NOT_THE_PRICE = /\b(?:shipping|delivery|postage|freight|tax(?:es)?|VAT|GST|duty|duties|fees?|surcharge|deposit)\b|\b(?:was|previously|originally|formerly|list price|MSRP|RRP|compare at|reg(?:ular)?\.? price)\s*:?\s*[A-Z]{0,3}\$/i;
const AUDIENCE = /\b(?:members?|membership|club|loyalty|rewards?|subscribers?|students?|teachers?|military|veterans?|employees?|staff|trade|wholesale|bulk|or more|when you buy|per unit for)\b/i;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const SIZES = /\bsize\s+(XXS|XS|S|M|L|XL|XXL|\d+)\b/gi;
const SKU = /\b(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,}(?:-[A-Z0-9]+){2,}\b/g; // needs a letter, so a date is not a SKU

const sentences = (text) => text.split(/(?<!\d)[.;!?](?!\d)|\n/).map((x) => x.trim()).filter(Boolean);

function otherVariant(sentence, { sku, attributes = {} }) {
  if ((sentence.match(SKU) ?? []).some((x) => x !== sku)) return true;
  const size = attributes.size && [...sentence.matchAll(SIZES)].some((m) => m[1].toUpperCase() !== String(attributes.size).toUpperCase());
  return Boolean(size);
}

// A sale or offer whose stated dates do not cover the order time.
function outsideDates(sentence, at) {
  const t = Date.parse(at);
  const dates = [...sentence.matchAll(DATE)].map((m) => Date.parse(`${m[1]}T00:00:00Z`)).filter(Number.isFinite);
  if (!dates.length || !Number.isFinite(t)) return false;
  if (dates.length >= 2) return t < Math.min(...dates) || t >= Math.max(...dates) + 86400000;
  const d = dates[0];
  if (/\b(?:until|through|thru|ends?|ended|expires?|expired|ending|by)\b/i.test(sentence)) return t >= d + 86400000;
  if (/\b(?:from|starting|starts|begins?|after)\b/i.test(sentence)) return t < d;
  return false;
}

export function contradictsListing(text, { priceCents, sku = null, attributes = {}, currency = 'USD', at = null }) {
  if (OVERRIDE.test(text)) return true;
  for (const s of sentences(text)) {
    const toAgents = AGENT.test(s);
    for (const m of s.matchAll(MONEY)) {
      const code = (m[1] ?? m[4] ?? '').toUpperCase();
      if (code && !(currency === 'USD' && (code === 'USD' || code === 'US'))) continue; // another currency
      const cents = Number(m[2].replace(/,/g, '')) * 100 + Number(m[3] ?? 0);
      if (cents === priceCents) continue;
      if (otherVariant(s, { sku, attributes }) || RANGE.test(s) || NOT_THE_PRICE.test(s) || outsideDates(s, at)) continue;
      if (!toAgents && AUDIENCE.test(s)) continue;
      return true;
    }
  }
  return false;
}

function readByModel(text, modelInputs) {
  const t = normalize(text);
  const escaped = JSON.stringify(t).slice(1, -1); // as it appears inside serialised JSON-LD
  return modelInputs.some((mi) => { const n = normalize(mi.text); return n.includes(t) || n.includes(escaped); });
}

// Findings for the purchased page of a sealed record, in the shape engine/findings.mjs expects.
export function findingsFor(record, item) {
  const page = record.fetches[record.purchase.page_index];
  const html = Buffer.from(page.body_b64, 'base64').toString('utf8');
  const signed = page.verification?.ok === true;
  const selfContained = isSelfContained(html);
  const spans = (page.spans ?? []).filter((s) => s.ok && s.subject === item.sku);

  return findHidden(html).map((h) => ({
    textHash: h.textHash,
    text: h.text,
    channel: h.channel,
    method: h.method,
    concealedInReadChannel: true,
    namesPurchasedItem: Boolean(mentionsItem(h.text, item)),
    contradictsListing: contradictsListing(h.text, { ...item, at: item.at ?? record.purchase.at }),
    inModelInput: readByModel(h.text, record.model_inputs),
    signedByMerchant: signed,
    selfContained,
    thirdPartySigned: spans.some((s) => s.start <= h.start && h.end <= s.end),
    thirdPartyIssuer: spans.find((s) => s.start <= h.start && h.end <= s.end)?.iss ?? null,
  }));
}
