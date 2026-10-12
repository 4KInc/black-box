// Deterministic mandate check. Money is integer minor units (cents) throughout.
//
// mandate  = { item: { category, attributes: { color: 'blue', size: 'M' } },
//              maxTotalCents, currency, notBefore, notAfter, signedShopsOnly }
// purchase = { sku, category, attributes, totalCents, currency, at, pageSigned }

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
