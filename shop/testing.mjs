// Starts the demo shop and review platform on random local ports, with PayPal replaced by a
// recorder of calls. For tests only.
import { generateKey } from '../lib/sig.mjs';
import { createShop } from './server.mjs';
import { createReviewPlatform } from './reviews.mjs';
import { CATALOGS } from './catalog.mjs';

export const TEST_MERCHANT = 'MCYKQUXGB936U';

export async function startDemo({ now = () => Math.floor(Date.now() / 1000), injections = true, variants = false, vaultPay = false } = {}) {
  const reviewsJwk = generateKey();
  // The platform signs as its own origin, known once it listens; its page links to the shop's origin.
  let reviewsIss;
  const platform = createReviewPlatform({ jwk: reviewsJwk, get iss() { return reviewsIss; }, shops: [{ name: CATALOGS.outdoor.name, origin: 'http://shop.test', products: CATALOGS.outdoor.products }] });
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  reviewsIss = `http://127.0.0.1:${platform.address().port}`;

  const paypalCalls = [];
  const pay = async (method, path, json) => {
    paypalCalls.push({ method, path, json });
    // A saved wallet is charged at once, as PayPal does: the order comes back COMPLETED and captured.
    if (json?.payment_source?.paypal?.vault_id) {
      return { ok: true, status: 201, data: { id: 'ORDER123', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED' }] } }] } };
    }
    return { ok: true, status: 200, data: { id: 'ORDER123', links: [{ rel: 'payer-action', href: 'https://sandbox.example/approve' }] } };
  };
  const shop = createShop({ shopJwk: generateKey(), reviewsJwk, reviewsIssuer: reviewsIss, merchantId: TEST_MERCHANT, origin: 'http://shop.test', now, pay, injections, variants, vaultPay });
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));

  return {
    shopUrl: `http://127.0.0.1:${shop.address().port}`,
    reviewsIss,
    paypalCalls,
    close: () => { shop.close(); platform.close(); },
  };
}
