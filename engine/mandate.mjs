// Deterministic mandate check. Money is integer minor units (cents) throughout.
//
// mandate  = { item: { category, attributes: { color: 'blue', size: 'M' } },
//              maxTotalCents, currency, notBefore, notAfter, signedShopsOnly }
// purchase = { sku, category, attributes, totalCents, currency, at, pageSigned }

import { moneyTokens, OVERRIDE } from './extract.mjs';

const norm = (s) => String(s).trim().toLowerCase();

export function checkMandate(mandate, purchase) {
  const violations = [];
  const item = mandate.item ?? {};

  if (item.category && norm(item.category) !== norm(purchase.category)) {
    violations.push({ code: 'CATEGORY', detail: `bought ${purchase.category}, mandate allows ${item.category}` });
  }
  for (const [k, want] of Object.entries(item.attributes ?? {})) {
    const got = purchase.attributes?.[k];
    if (got === undefined || norm(got) !== norm(want)) {
      violations.push({ code: 'ATTRIBUTE', detail: `${k}: bought ${got ?? '(none)'}, mandate requires ${want}` });
    }
  }
  if (purchase.currency !== mandate.currency) {
    violations.push({ code: 'CURRENCY', detail: `paid in ${purchase.currency}, mandate is in ${mandate.currency}` });
  }
  const at = Date.parse(purchase.at);
  if (Number.isNaN(at)) throw new TypeError(`purchase.at is not a timestamp: ${purchase.at}`);
  if ((mandate.notBefore && at < Date.parse(mandate.notBefore)) || (mandate.notAfter && at > Date.parse(mandate.notAfter))) {
    violations.push({ code: 'WINDOW', detail: `bought at ${purchase.at}, outside the mandate window` });
  }
  if (mandate.signedShopsOnly && !purchase.pageSigned) {
    violations.push({ code: 'UNSIGNED_SHOP', detail: 'bought from a page without a valid merchant signature' });
  }
  const overCap = purchase.totalCents - mandate.maxTotalCents;
  if (overCap > 0) {
    violations.push({ code: 'OVER_CAP', detail: `total ${purchase.totalCents} exceeds cap ${mandate.maxTotalCents} by ${overCap}` });
  }

  // If the item itself was out of scope, the whole payment is. If only the price was, just the excess.
  const wrongItem = violations.some((v) => v.code !== 'OVER_CAP');
  const outOfScopeCents = wrongItem ? purchase.totalCents : Math.max(0, overCap);

  return { broken: violations.length > 0, violations, outOfScopeCents };
}

// The buyer's own words to the agent, read against the mandate they signed. Does the request ask
// for what the mandate forbids: an amount above the cap, no limit at all, or the variant or kind
// of item that was bought instead of the one approved? Deliberately broad: the fact can only move
// a case from AGENT to NEEDS A HUMAN, so a false yes costs a review and a false no costs the
// operator money the buyer asked it to spend.
const NO_LIMIT = /\b(?:no|without (?:a|any)) (?:budget|limit|cap|price limit|spending limit)\b|\b(?:budget|price|cost|limit|money)s? (?:doesn't|does not|don't|do not|won't) matter\b|\b(?:whatever|any) (?:it costs|price|amount|cost)\b|\bmoney is no object\b|\b(?:spend|pay) (?:whatever|anything|any amount|more)\b|\b(?:go|going|goes) over (?:the |my )?(?:budget|limit|cap)\b/i;
const WORD_AMOUNT = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s?(?:dollars|bucks|usd)\b/gi;
const SIZE_WORDS = { XS: 'extra small', S: 'small', M: 'medium', L: 'large', XL: 'extra large' };
const says = (text, phrase) => new RegExp(`(?<![\\w-])${String(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text);

export function requestExceedsMandate(request, mandate, product = {}) {
  const why = [];
  const text = String(request ?? '');
  if (!text.trim()) return { exceeds: false, why };
  const amounts = [...moneyTokens(text).map((t) => t.cents), ...[...text.matchAll(WORD_AMOUNT)].map((m) => Number(m[1].replace(/,/g, '')) * 100 + Number(m[2] ?? 0))];
  const over = amounts.filter((c) => c > mandate.maxTotalCents);
  if (over.length) why.push(`names $${(Math.max(...over) / 100).toFixed(2)}, above the $${(mandate.maxTotalCents / 100).toFixed(2)} cap`);
  if (OVERRIDE.test(text) || NO_LIMIT.test(text)) why.push('tells the agent the limit does not apply');
  for (const [k, want] of Object.entries(mandate.item?.attributes ?? {})) {
    const got = product.attributes?.[k];
    if (got === undefined || norm(got) === norm(want)) continue;
    const words = k === 'size' ? [`size ${got}`, SIZE_WORDS[String(got).toUpperCase()]].filter(Boolean) : [got];
    if (words.some((w) => says(text, w))) why.push(`asks for ${k} ${got}, the mandate says ${want}`);
  }
  const category = mandate.item?.category;
  if (category && product.category && norm(category) !== norm(product.category) && says(text, product.category)) {
    why.push(`asks for a ${product.category}, the mandate says ${category}`);
  }
  return { exceeds: why.length > 0, why };
}
