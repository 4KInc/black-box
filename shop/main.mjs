// Starts the demo shop and the demo review platform.
//   node shop/main.mjs        -> shop on :4010, review platform on :4011
//   SHOP_INJECTIONS=off       -> same pages without the hidden texts (control condition)
//   SHOP_EXTRA_DATA=<key>     -> add one accurate, differently priced statement (catalog LEGIT_PRICE_DATA)
//   SHOP_VARIANTS=on          -> also serve those pages under /v/control/ and /v/<key>/, same key
//   SHOP_CATALOG=audio        -> be Northline Audio (headphones, study setup 2) instead of Driftwood
//   SHOP_ROLE=shop|reviews    -> run only one of the two, on PORT (hosted: one Cloud Run service each);
//                                the review platform links its reviews to SHOP_ORIGIN
// Keys are created on first run in shop/.keys/ (gitignored) and reused after that. Hosted, they
// come from SHOP_JWK and REVIEWS_JWK (Secret Manager) instead, so they survive restarts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { generateKey, thumbprint } from '../lib/sig.mjs';
import { createShop } from './server.mjs';
import { createReviewPlatform } from './reviews.mjs';
import { CATALOGS } from './catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));

const ROLE = process.env.SHOP_ROLE ?? 'both';
if (!['both', 'shop', 'reviews'].includes(ROLE)) throw new Error(`unknown SHOP_ROLE ${ROLE}`);
const SHOP_PORT = Number(process.env.SHOP_PORT ?? (ROLE === 'shop' ? process.env.PORT : null) ?? 4010);
const REVIEWS_PORT = Number(process.env.REVIEWS_PORT ?? (ROLE === 'reviews' ? process.env.PORT : null) ?? 4011);
const origin = process.env.SHOP_ORIGIN ?? `http://localhost:${SHOP_PORT}`;
const reviewsIssuer = process.env.REVIEWS_ORIGIN ?? `http://localhost:${REVIEWS_PORT}`;
// The sandbox business account that owns the PayPal app (confirmed by the kill test).
const merchantId = process.env.SHOP_PAYPAL_MERCHANT_ID ?? 'MCYKQUXGB936U';

function key(name, env) {
  if (process.env[env]) return JSON.parse(process.env[env]);
  const dir = join(HERE, '.keys');
  const p = join(dir, `${name}.jwk.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jwk = generateKey();
  writeFileSync(p, JSON.stringify(jwk), { mode: 0o600 });
  return jwk;
}

// Each shop signs with its own key; Driftwood keeps the original file name.
// The review platform alone needs no shop key.
const shopJwk = ROLE === 'reviews' ? null : key(process.env.SHOP_CATALOG && process.env.SHOP_CATALOG !== 'outdoor' ? `shop-${process.env.SHOP_CATALOG}` : 'shop', 'SHOP_JWK');
const reviewsJwk = key('reviews', 'REVIEWS_JWK');

// The review platform's home page lists the reviews it signed, linked to each shop's pages. Run
// here with the shop, that one shop. Hosted alone (SHOP_ROLE=reviews), Driftwood at SHOP_ORIGIN and,
// when AUDIO_SHOP_ORIGIN is set, Northline Audio too.
const catalog = CATALOGS[process.env.SHOP_CATALOG || 'outdoor'];
const shopAt = (key, at) => ({ name: CATALOGS[key].name, origin: at ?? null, products: CATALOGS[key].products });
const reviewedShops = ROLE === 'reviews'
  ? [shopAt('outdoor', process.env.SHOP_ORIGIN), ...(process.env.AUDIO_SHOP_ORIGIN ? [shopAt('audio', process.env.AUDIO_SHOP_ORIGIN)] : [])]
  : [{ name: catalog.name, origin, products: catalog.products }];
if (ROLE !== 'shop') createReviewPlatform({ jwk: reviewsJwk, iss: reviewsIssuer, shops: reviewedShops }).listen(REVIEWS_PORT, () =>
  console.log(`review platform  ${reviewsIssuer}   key ${thumbprint(reviewsJwk)}`));
if (ROLE !== 'reviews') createShop({ shopJwk, reviewsJwk, reviewsIssuer, merchantId, origin, injections: process.env.SHOP_INJECTIONS !== 'off', extraData: process.env.SHOP_EXTRA_DATA || null, catalog: process.env.SHOP_CATALOG || 'outdoor', variants: process.env.SHOP_VARIANTS === 'on' }).listen(SHOP_PORT, () =>
  console.log(`shop             ${origin}   ${process.env.SHOP_CATALOG || 'outdoor'}   key ${thumbprint(shopJwk)}   PayPal merchant ${merchantId}${process.env.SHOP_INJECTIONS === 'off' ? '   (hidden texts OFF: control)' : ''}`));
