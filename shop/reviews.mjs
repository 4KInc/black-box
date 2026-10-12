// "Trailhead Reviews", a demo third-party review platform. It signs each review it publishes;
// the shop embeds the signed review in its page unchanged. Its key lives on its own origin.
import { createServer } from 'node:http';
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

export function createReviewPlatform({ jwk }) {
  const body = JSON.stringify(jwks(jwk));
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
