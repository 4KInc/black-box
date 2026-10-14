// Self-contained pages: inline CSS and SVG only. No scripts, no external files, so the signed
// bytes are everything the agent can read. The only <script> is JSON-LD, which is data.
import { PRODUCTS, SHOP_NAME, dollars } from './catalog.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CSS = `
:root{--ink:#1f2933;--muted:#5f6b7a;--line:#e3e7ec;--bg:#f7f8fa;--card:#fff;--accent:#0b5cad}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
header a{color:var(--ink);text-decoration:none;font-weight:700}header small{color:var(--muted)}
main{max-width:920px;margin:0 auto;padding:24px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;color:inherit;text-decoration:none;display:block}
.card h2{font-size:18px;margin:8px 0 4px}.price{font-weight:700;font-size:20px}
.product{display:grid;grid-template-columns:minmax(220px,340px) 1fr;gap:28px}
@media (max-width:640px){.product{grid-template-columns:1fr}}
.facts{color:var(--muted);margin:4px 0 16px}.sku{font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)}
.review{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 12px;padding:12px 16px}
.review footer{color:var(--muted);font-size:14px}.stars{color:#c98a00;margin:0}
.signed{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:32px;padding-top:12px}
`;

function jacketSvg(hex) {
  return `<svg viewBox="0 0 200 200" role="img" aria-label="jacket" style="width:100%;background:#eef2f6;border-radius:12px">` +
    `<path d="M70 40 L100 52 L130 40 L165 62 L185 120 L160 128 L152 100 L152 175 L48 175 L48 100 L40 128 L15 120 L35 62 Z" fill="${hex}"/>` +
    `<path d="M100 52 L100 175" stroke="#0003" stroke-width="3"/></svg>`;
}

function shell({ title, merchantId, origin, body, jsonLd }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="paypal-merchant-id" content="${esc(merchantId)}">
<meta name="shop-key-set" content="${esc(origin)}/.well-known/jwks.json">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
<style>${CSS}</style></head>
<body><header><a href="/">${SHOP_NAME}</a><small>Every page on this site is signed by ${SHOP_NAME}.</small></header>
<main>${body}
<p class="signed">Seller: ${SHOP_NAME}, PayPal merchant ID ${esc(merchantId)}. This page is signed; the key is published at ${esc(origin)}/.well-known/jwks.json.</p>
</main></body></html>`;
}

const seller = (merchantId) => ({
  '@type': 'Organization',
  name: SHOP_NAME,
  identifier: { '@type': 'PropertyValue', propertyID: 'paypal-merchant-id', value: merchantId },
});

export function categoryPage({ merchantId, origin }) {
  const listed = PRODUCTS.filter((p) => p.listed !== false);
  const cards = listed.map((p) => `<a class="card" href="/p/${p.sku}">${jacketSvg(p.hex)}
<h2>${esc(p.name)}</h2><div class="facts">${esc(p.color)}, size ${esc(p.size)}</div><div class="price">${dollars(p.priceCents)}</div></a>`).join('\n');
  return shell({
    title: `Rain jackets | ${SHOP_NAME}`, merchantId, origin,
    body: `<h1>Rain jackets</h1><div class="grid">${cards}</div>`,
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'ItemList', name: 'Rain jackets', seller: seller(merchantId),
      itemListElement: listed.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/p/${p.sku}`, name: p.name })),
    },
  });
}

export function productPage({ product: p, merchantId, origin, signedReviews }) {
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Product',
    sku: p.sku, productID: p.sku, name: p.name, description: p.description, color: p.color, size: p.size, category: p.category,
    offers: { '@type': 'Offer', price: (p.priceCents / 100).toFixed(2), priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: seller(merchantId) },
    ...(p.hiddenJsonLd ?? {}),
  };
  const body = `<div class="product"><div>${jacketSvg(p.hex)}</div><div>
<h1>${esc(p.name)}</h1><div class="sku">SKU ${esc(p.sku)}</div>
<p class="facts">Colour: ${esc(p.color)} · Size: ${esc(p.size)}</p>
<p class="price">${dollars(p.priceCents)}</p>
<p>${esc(p.description)}</p>
${p.hiddenNote ? `<p style="${esc(p.hiddenNote.style)}">${esc(p.hiddenNote.text)}</p>
` : ''}<h2>Reviews</h2>
${signedReviews.join('\n')}
</div></div>`;
  return shell({ title: `${p.name} | ${SHOP_NAME}`, merchantId, origin, body, jsonLd });
}

export function messagePage({ title, text, merchantId, origin }) {
  return shell({ title, merchantId, origin, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to the shop</a></p>` });
}
