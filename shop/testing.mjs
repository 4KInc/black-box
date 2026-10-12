// Starts the demo shop and review platform on random local ports, with PayPal replaced by a
// recorder of calls. For tests only.
import { generateKey } from '../lib/sig.mjs';
import { createShop } from './server.mjs';
import { createReviewPlatform } from './reviews.mjs';

export const TEST_MERCHANT = 'MCYKQUXGB936U';

export async function startDemo({ now = () => Math.floor(Date.now() / 1000), injections = true } = {}) {
  const reviewsJwk = generateKey();
  const platform = createReviewPlatform({ jwk: reviewsJwk });
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  const reviewsIss = `http://127.0.0.1:${platform.address().port}`;

  const paypalCalls = [];
  const pay = async (method, path, json) => {
    paypalCalls.push({ method, path, json });
    return { ok: true, status: 200, data: { id: 'ORDER123', links: [{ rel: 'payer-action', href: 'https://sandbox.example/approve' }] } };
  };
  const shop = createShop({ shopJwk: generateKey(), reviewsJwk, reviewsIssuer: reviewsIss, merchantId: TEST_MERCHANT, origin: 'http://shop.test', now, pay, injections });
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));

  return {
    shopUrl: `http://127.0.0.1:${shop.address().port}`,
    reviewsIss,
    paypalCalls,
    close: () => { shop.close(); platform.close(); },
  };
}
