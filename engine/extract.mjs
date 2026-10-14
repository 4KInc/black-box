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
    inModelInput: readByModel(h.text, record.model_inputs),
    signedByMerchant: signed,
    selfContained,
    thirdPartySigned: spans.some((s) => s.start <= h.start && h.end <= s.end),
    thirdPartyIssuer: spans.find((s) => s.start <= h.start && h.end <= s.end)?.iss ?? null,
  }));
}
