// "Trailhead Reviews", a demo third-party review platform. It signs each review it publishes;
// the shop embeds the signed review in its page unchanged. Its key lives on its own origin.
import { createServer } from 'node:http';
import { isBenchKey } from '../bench/keys.mjs';
import { jwks, signSpan, wrapSpan } from '../lib/sig.mjs';

export const PLATFORM_NAME = 'Trailhead Reviews';

// Fixed so the same key always yields byte-identical signed reviews across restarts.
const REVIEWED_AT = Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function reviewHtml(r) {
  const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
  const hidden = r.hidden ? `<span style="display:none">${esc(r.hidden)}</span>` : '';
  return `<blockquote class="review"><p class="stars" aria-label="${r.rating} out of 5">${stars}</p>` +
    `<p>${esc(r.text)}${hidden}</p><footer>${esc(r.author)}, via ${PLATFORM_NAME}</footer></blockquote>`;
}

// Returns the review as an HTML fragment wrapped in the platform's span signature.
export function signedReview({ jwk, iss, sku, review }) {
  const content = reviewHtml(review);
  const signed = signSpan({ jwk, iss, subject: sku, content, created: REVIEWED_AT });
  return wrapSpan(review.id, signed, content);
}

// shops: [{ name, origin, products }], the shops that embed this platform's reviews. The home page
// lists every review it signed for them, as signed, each linked to the product page it is on
// (no link when the shop's origin is not known). iss: the platform's own origin, the signer, read
// when the page is first served, so a caller that learns it only once listening can set it then.
export function createReviewPlatform(opts) {
  const { jwk, shops = [] } = opts;
  if (isBenchKey(jwk)) throw new Error('refusing the TEST-ONLY bench key: its private half is public');
  const body = JSON.stringify(jwks(jwk));
  const listed = shops.flatMap((shop) => shop.products.flatMap((p) => p.reviews.map((review) => ({ shop, p, review }))));
  const item = (iss) => ({ shop, p, review }) => {
    const where = shop.origin ? `<a href="${esc(new URL(`/p/${p.sku}`, shop.origin))}">${esc(p.name)}</a>` : esc(p.name);
    const html = iss ? signedReview({ jwk, iss, sku: p.sku, review }) : reviewHtml(review);
    const hidden = review.hidden ? `<p class="hid"><b>Hidden in this review</b> with <code>display:none</code>, so shoppers never see it, but an agent reading the page does: “${esc(review.hidden)}”</p>` : '';
    return `<li><p class="on">${where} <span>${esc(p.sku)} · ${esc(shop.name)}</span></p>${html}${hidden}</li>`;
  };
  const page = (iss) => {
    const list = listed.length ? `<h2>Reviews it has signed (${listed.length})</h2>
<p>Each one exactly as it signed it, which is how the shop embeds it in the product page.${iss ? ' The signature is in the comment around each review.' : ''}</p>
<ol class="reviews">${listed.map(item(iss)).join('\n')}</ol>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${PLATFORM_NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d1d1b;background:#fafaf7}code{background:#eee;padding:0 .3em}
h2{font-size:1.15rem;margin-top:2.5rem}.reviews{list-style:none;padding:0}.reviews li{border-top:1px solid #ddd;padding:1rem 0}
.on{margin:0;font-weight:600}.on span{font-weight:400;color:#6b6b66;font-size:.85rem}.review{margin:.5rem 0}.review p{margin:.25rem 0}.stars{color:#b7791f;letter-spacing:.1em}
.review footer{color:#6b6b66;font-size:.9rem}.hid{background:#fff4e5;border-left:3px solid #c05621;padding:.5rem .75rem;font-size:.9rem;margin:.5rem 0 0}</style></head><body>
<h1>${PLATFORM_NAME}</h1><p>A demo third-party review platform for Black Box. It signs each review it publishes, and shops embed the signed reviews in their own pages unchanged.</p>
<p>Its public signing key: <a href="/.well-known/jwks.json"><code>/.well-known/jwks.json</code></a>. Anyone can check a review on a shop's page against it.</p>
${list}</body></html>`;
  };
  let home;
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(home ??= page(opts.iss ?? null));
    }
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
