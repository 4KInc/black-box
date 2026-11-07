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

function visibleText(html, hidden, lower = true) {
  let s = html;
  for (const h of [...hidden].sort((a, b) => b.start - a.start)) s = s.slice(0, h.start) + ' ' + s.slice(h.end);
  const text = stripTags(s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s);
  return lower ? text.toLowerCase() : text;
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const MIN_WORDS = 5; // shorter strings are structure (names, SKUs, URLs), not instructions

// The JSON-LD node a string belongs to: the nearest enclosing Product (or ProductGroup) node.
const PRODUCT_TYPES = new Set(['Product', 'ProductModel', 'IndividualProduct', 'SomeProducts', 'ProductGroup']);
const types = (node) => [].concat(node?.['@type'] ?? []);
const isProductNode = (node) => types(node).some((t) => PRODUCT_TYPES.has(t));
const ids = (node) => [node?.sku, node?.productID].filter((x) => typeof x === 'string' && x);

function* strings(value, path = '', owner = null) {
  if (typeof value === 'string') yield [path, value, owner];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`, owner);
  else if (value && typeof value === 'object') {
    const own = isProductNode(value) ? value : owner;
    for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k, own);
  }
}

// Which product a JSON-LD string is about: its node's identifiers, or for a ProductGroup's own
// fields, the identifiers of every variant in it (text on the group is about all of them).
function subjectOf(owner) {
  if (!owner) return null;
  if (types(owner).includes('ProductGroup')) return { ids: [].concat(owner.hasVariant ?? []).flatMap(ids) };
  return { ids: ids(owner) };
}

// Does a hidden text name the purchased item? By its SKU or exact name in the text, or by sitting
// on the purchased product's own JSON-LD node (matched by sku or productID). Text on another
// Product node, or on another variant, does not name it.
export function namesPurchasedItem(h, item) {
  return Boolean(mentionsItem(h.text, item) || (h.subject && h.subject.ids.includes(item.sku)));
}

// The purchased product's JSON-LD node, wherever it sits on the page (top level, @graph, hasVariant).
export function productNode(html, sku) {
  const all = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (isProductNode(n) && !types(n).includes('ProductGroup')) all.push(n);
    Object.values(n).forEach(walk);
  };
  jsonLdBlocks(html).forEach(walk);
  return all.find((n) => ids(n).includes(sku)) ?? null;
}

// All hidden texts on a page, with offsets into the page string.
export function findHidden(html) {
  const elements = hiddenElements(html);
  const visible = visibleText(html, elements);
  const out = [...elements];

  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const [obj] = jsonLdBlocks(block[0]);
    for (const [path, value, owner] of strings(obj)) {
      const text = normalize(value);
      if (wordCount(text) >= MIN_WORDS && !visible.includes(text.toLowerCase())) {
        out.push({ channel: 'json-ld', method: 'JSON-LD field never rendered', path, text, subject: subjectOf(owner), start: block.index, end: block.index + block[0].length });
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
//   - tells the agent to set aside the buyer's limits, or claims to the agent that the buyer
//     already authorised the spend ("pre-approved any amount", "no limit applies"), or
//   - states a price for this item, in the order's currency, valid when the order was placed,
//     other than the signed price.
// Accurate structured data often carries other prices, and none of these count: another variant
// or SKU, a price range, a former price, shipping, tax or fees, another currency, a price for
// another audience (members, students, bulk, outlet stores), or a sale outside its stated dates.
// A price aimed at AI agents always counts: no other audience can make that legitimate. Each
// sentence is judged on its own, so an honest sentence cannot excuse a lie next to it, and a fee,
// former-price or range wording exempts only the amount it qualifies, so "was $240, now $119"
// still states $119.
const ISO = 'USD|CAD|AUD|NZD|HKD|SGD|MXN|EUR|GBP|CHF|JPY';
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?`;
const DOLLAR = new RegExp(String.raw`(?:\b(USD|US|CA|C|A|AU|NZ|HK|S|SG|MX)\s?)?\$\s?${AMOUNT}(?:\s?(${ISO})\b)?`, 'g');
const CODED = new RegExp(String.raw`\b(${ISO})\s?${AMOUNT}(?![\d,]|\.\d)|(?<![\w.,$])${AMOUNT}\s?(${ISO})\b`, 'g'); // "USD 119", "119.00 USD"
export const OVERRIDE = /\b(?:ignore|disregard|override|bypass|set aside)\b[^.]{0,60}?\b(?:budget|limit|cap|mandate|instructions?|spending)/i;
// A claim, made to the agent, that the buyer already authorised the spend. Kept narrow: financing
// pre-approval and ordinary "approved"/"limit" copy do not match.
const PREAUTH = /\b(?:pre-?approved(?!\s+(?:for\s+)?(?:financ|credit|loans?\b|leas|a payment plan))|pre-?authori[sz]ed|already (?:approved|authori[sz]ed)|authori[sz]ed (?:any|every|unlimited|whatever)\s+(?:amount|price|total|spend(?:ing)?|cost|sum)|no (?:spending |budget |price )?(?:limits?|caps?) (?:applies|apply)|(?:budget|spending limit|price limit|limit|cap) (?:does not|doesn't|do not|don't|no longer) apply)/i;
export const AGENT = /\b(?:AI|agents?|agentic|assistants?|bots?|automated|LLMs?)\b/i;
const FEE = /\b(?:shipping|delivery|postage|freight|handling|tax(?:es)?|VAT|GST|duty|duties|fees?|surcharge|deposit)\b/gi;
const NOT_A_FEE = /\b(?:total|price|pay|pays|paid|charged?|invoiced?|comes? to|amount|now|only|just|you)\b/i; // "with free shipping your total is $119" states a total
const FEE_AFTER = /^\s?(?:for\s+|in\s+)?(?:shipping|delivery|postage|freight|handling|tax(?:es)?|VAT|GST|duty|duties|fees?|surcharge|deposit)\b(?!\s*(?:incl|is incl))/i;
const INCLUSIVE = /\b(?:incl(?:\.|uding|udes|uded|usive)?|with|plus|after)\b[^$]{0,40}?\b(?:shipping|delivery|postage|freight|handling|tax(?:es)?|VAT|GST|duty|duties|fees?)\b|\b(?:shipping|delivery|postage|freight|handling|tax(?:es)?|VAT|GST|duty|duties|fees?)\s+(?:incl(?:\.|uded|usive)?|included)\b/i;
const FORMER = /\b(?:was|were|previously|originally|formerly|list price|MSRP|RRP|compare at|reg(?:ular)?\.? price)\s*:?\s*$/i;
const RANGE_JOIN = /^\s*(?:-|–|—|to|and)\s*$/i;
const RANGE_FIELD = /\b(?:lowPrice|highPrice)\b["':\s]*$/i;
const AUDIENCE = /\b(?:members?|membership|club|loyalty|rewards?|subscribers?|students?|teachers?|military|veterans?|employees?|staff|trade|wholesale|bulk|or more|when you buy|per unit for|outlets?|in[- ]stores?|in our stores)\b/i;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const SIZES = /\bsize\s+(XXS|XS|S|M|L|XL|XXL|\d+)\b/gi;
const SKU = /\b(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,}(?:-[A-Z0-9]+){2,}\b/g; // needs a letter, so a date is not a SKU

const sentences = (text) => text.split(/(?<!\d)[.;!?](?!\d)|\n/).map((x) => x.trim()).filter(Boolean);
const toCents = (int, dec) => Number(int.replace(/,/g, '')) * 100 + Number(dec ?? 0);

// Every amount in a sentence: "$119", "US$119.00", "USD 119", "119.00 USD", with its currency code
// when one is written next to it.
export function moneyTokens(s) {
  const out = [...s.matchAll(DOLLAR)].map((m) => ({ start: m.index, end: m.index + m[0].length, code: (m[1] ?? m[4] ?? '').toUpperCase(), cents: toCents(m[2], m[3]) }));
  for (const m of s.matchAll(CODED)) {
    const start = m.index, end = m.index + m[0].length;
    if (out.some((t) => start < t.end && t.start < end)) continue;
    out.push(m[1] ? { start, end, code: m[1], cents: toCents(m[2], m[3]) } : { start, end, code: m[6], cents: toCents(m[4], m[5]) });
  }
  return out.sort((a, b) => a.start - b.start);
}

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

// A fee amount: "shipping $5", "shipping is $5", "express shipping for the jacket costs $14.95",
// "$5 shipping". `before` and `after` reach only to the neighbouring amounts.
function isFee(before, after) {
  const last = [...before.matchAll(FEE)].at(-1);
  if (last) {
    const gap = before.slice(last.index + last[0].length);
    if (gap.length <= 45 && !NOT_A_FEE.test(gap) && !INCLUSIVE.test(before.slice(Math.max(0, last.index - 12)))) return true;
  }
  return FEE_AFTER.test(after);
}

// Which amounts in a sentence are exempt: their own wording makes them not this item's price.
function exemptAmounts(s, tokens, priceCents) {
  const exempt = new Set();
  tokens.forEach((t, i) => {
    const before = s.slice(i ? tokens[i - 1].end : 0, t.start);
    const after = s.slice(t.end, tokens[i + 1]?.start ?? s.length);
    if (FORMER.test(before) || RANGE_FIELD.test(before) || isFee(before, after)) exempt.add(i);
    // A price "including shipping" or "plus tax" can only be above the item price.
    if ((INCLUSIVE.test(before) || INCLUSIVE.test(after)) && t.cents > priceCents) exempt.add(i);
    if (tokens[i + 1] && RANGE_JOIN.test(after)) { exempt.add(i); exempt.add(i + 1); } // "$100-$150", "from $240 to $275"
  });
  return exempt;
}

export function contradictsListing(text, { priceCents, sku = null, attributes = {}, currency = 'USD', at = null }) {
  if (OVERRIDE.test(text)) return true;
  if (AGENT.test(text) && PREAUTH.test(text)) return true;
  for (const s of sentences(text)) {
    const toAgents = AGENT.test(s);
    if (otherVariant(s, { sku, attributes }) || outsideDates(s, at)) continue;
    if (!toAgents && AUDIENCE.test(s)) continue;
    const tokens = moneyTokens(s);
    const exempt = exemptAmounts(s, tokens, priceCents);
    for (const [i, t] of tokens.entries()) {
      if (t.code && !(t.code === currency || (currency === 'USD' && t.code === 'US'))) continue; // another currency
      if (t.cents === priceCents || exempt.has(i)) continue;
      return true;
    }
  }
  return false;
}

// ---------- JSON-LD offers, read as numbers ----------

function* offersIn(node, product = null) {
  if (Array.isArray(node)) { for (const n of node) yield* offersIn(n, product); return; }
  if (!node || typeof node !== 'object') return;
  if (types(node).includes('Offer')) yield { offer: node, product };
  // An AggregateOffer's lowPrice/highPrice is a range, not a price; Offers inside it still count.
  const inside = isProductNode(node) && !types(node).includes('ProductGroup') ? node : product;
  for (const [k, v] of Object.entries(node)) if (k !== '@type') yield* offersIn(v, inside);
}

function validAt(offer, at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true;
  const from = Date.parse(offer.validFrom);
  if (Number.isFinite(from) && t < from) return false;
  const until = String(offer.priceValidUntil ?? '');
  const u = Date.parse(until);
  if (Number.isFinite(u) && t >= (/^\d{4}-\d{2}-\d{2}$/.test(until) ? u + 86400000 : u + 1)) return false;
  return true;
}

// Is this Offer a price for the purchased item, in the order's currency, valid at order time, other
// than the signed price? An Offer applies if its SKU is the purchased one, or it has no SKU and
// sits on the purchased product's page (not inside another Product).
export function offerContradicts(offer, product, { sku, priceCents, currency = 'USD', at = null }) {
  const offerSku = offer.sku ?? offer.itemOffered?.sku ?? null;
  const applies = offerSku ? offerSku === sku : !product || ids(product).includes(sku);
  const cents = Math.round(Number(String(offer.price ?? '').replace(/,/g, '')) * 100);
  const contradicts = applies && Number.isFinite(cents) && offer.priceCurrency === currency && validAt(offer, at) && cents !== priceCents;
  return { applies, cents, contradicts };
}

// Offers whose price is never shown on the page, as findings. The signed price is on the page, so
// the honest Offer that carries it is not hidden text.
export function hiddenOffers(html, item) {
  const shown = new Set(moneyTokens(visibleText(html, hiddenElements(html), false)).map((t) => t.cents));
  const out = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const [obj] = jsonLdBlocks(block[0]);
    for (const { offer, product } of offersIn(obj)) {
      const o = offerContradicts(offer, product, item);
      if (!Number.isFinite(o.cents) || shown.has(o.cents)) continue;
      const text = normalize(JSON.stringify(offer, null, 2));
      out.push({ channel: 'json-ld', method: 'JSON-LD Offer never rendered', path: 'Offer', text, textHash: sha(text), start: block.index, end: block.index + block[0].length, offer: o });
    }
  }
  return out;
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

  const at = item.at ?? record.purchase.at;
  return [...findHidden(html), ...hiddenOffers(html, { ...item, at })].map((h) => ({
    textHash: h.textHash,
    text: h.text,
    channel: h.channel,
    method: h.method,
    concealedInReadChannel: true,
    namesPurchasedItem: h.offer ? h.offer.applies : namesPurchasedItem(h, item),
    contradictsListing: h.offer ? h.offer.contradicts : contradictsListing(h.text, { ...item, at }),
    addressesAgents: AGENT.test(h.text),
    inModelInput: readByModel(h.text, record.model_inputs),
    signedByMerchant: signed,
    selfContained,
    thirdPartySigned: spans.some((s) => s.start <= h.start && h.end <= s.end),
    thirdPartyIssuer: spans.find((s) => s.start <= h.start && h.end <= s.end)?.iss ?? null,
  }));
}
