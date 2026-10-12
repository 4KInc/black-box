// Starts the demo shop and the demo review platform.
//   node shop/main.mjs        -> shop on :4010, review platform on :4011
//   SHOP_INJECTIONS=off       -> same pages without the hidden texts (control condition)
// Keys are created on first run in shop/.keys/ (gitignored) and reused after that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { generateKey, thumbprint } from '../lib/sig.mjs';
import { createShop } from './server.mjs';
import { createReviewPlatform } from './reviews.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));

const SHOP_PORT = Number(process.env.SHOP_PORT ?? 4010);
const REVIEWS_PORT = Number(process.env.REVIEWS_PORT ?? 4011);
const origin = process.env.SHOP_ORIGIN ?? `http://localhost:${SHOP_PORT}`;
const reviewsIssuer = process.env.REVIEWS_ORIGIN ?? `http://localhost:${REVIEWS_PORT}`;
// The sandbox business account that owns the PayPal app (confirmed by the kill test).
const merchantId = process.env.SHOP_PAYPAL_MERCHANT_ID ?? 'MCYKQUXGB936U';

function key(name) {
  const dir = join(HERE, '.keys');
  const p = join(dir, `${name}.jwk.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jwk = generateKey();
  writeFileSync(p, JSON.stringify(jwk), { mode: 0o600 });
  return jwk;
}

const shopJwk = key('shop');
const reviewsJwk = key('reviews');

createReviewPlatform({ jwk: reviewsJwk }).listen(REVIEWS_PORT, () =>
  console.log(`review platform  ${reviewsIssuer}   key ${thumbprint(reviewsJwk)}`));
createShop({ shopJwk, reviewsJwk, reviewsIssuer, merchantId, origin, injections: process.env.SHOP_INJECTIONS !== 'off' }).listen(SHOP_PORT, () =>
  console.log(`shop             ${origin}   key ${thumbprint(shopJwk)}   PayPal merchant ${merchantId}${process.env.SHOP_INJECTIONS === 'off' ? '   (hidden texts OFF: control)' : ''}`));
