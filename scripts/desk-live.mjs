// The evidence desk, live in the PayPal sandbox: ordinary orders (no agent, no Black Box record)
// for the sandbox buyer to pay and dispute, so the hosted desk handles real PayPal disputes.
//   node scripts/desk-live.mjs order [--postcode 97201]       an $89 order shipped to Portland; prints the link the buyer approves
//   node scripts/desk-live.mjs capture <order_id>             capture it once the buyer approved
//   node scripts/desk-live.mjs track <order_id> <capture_id> <tracking_number> [carrier]   add tracking to the PayPal order
//   node scripts/desk-live.mjs refund <capture_id> <amount>   refund part or all of it
//   node scripts/desk-live.mjs show <order_id>                the order as PayPal reports it: captures, refunds, trackers
// Uses the merchant's sandbox app (killtest/.env), like the rest of the live tooling.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { paypal } from '../lib/paypal.mjs';

const ROOT = join(import.meta.dirname, '..');
const HOSTED = process.env.PUBLIC_ORIGIN ?? 'https://black-box-342881585799.us-central1.run.app';

export function orderBody({ postcode = '97201' } = {}) {
  const value = '89.00';
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'default',
      description: 'Harbor Wool Beanie (HB-NAVY)',
      amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
      items: [{ name: 'Harbor Wool Beanie', sku: 'HB-NAVY', quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'USD', value } }],
      shipping: { type: 'SHIPPING', name: { full_name: 'Sandbox Buyer' }, address: { address_line_1: '1200 SW Main St', admin_area_2: 'Portland', admin_area_1: 'OR', postal_code: postcode, country_code: 'US' } },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name: 'Driftwood Outfitters', user_action: 'PAY_NOW', shipping_preference: 'SET_PROVIDED_ADDRESS',
      return_url: `${HOSTED}/desk`, cancel_url: `${HOSTED}/desk`,
    } } },
  };
}

if (import.meta.main) {
  loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { postcode: { type: 'string' } } });
  const [cmd, ...args] = positionals;
  const must = async (what, ...call) => {
    const r = await paypal(...call);
    if (!r.ok) { console.error(`${what} failed (${r.status}, debug ${r.debugId}): ${JSON.stringify(r.data).slice(0, 600)}`); process.exit(1); }
    return r.data;
  };
  if (cmd === 'order') {
    const o = await must('create order', 'POST', '/v2/checkout/orders', orderBody({ postcode: values.postcode }));
    console.log(`order ${o.id}  ${o.status}\nthe buyer approves: ${o.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve').href}`);
  } else if (cmd === 'capture' && args[0]) {
    const o = await must('capture', 'POST', `/v2/checkout/orders/${encodeURIComponent(args[0])}/capture`, {});
    const c = o.purchase_units[0].payments.captures[0];
    console.log(`order ${o.id}  ${o.status}  capture ${c.id}  ${c.status}  $${c.amount.value}`);
  } else if (cmd === 'track' && args[2]) {
    const [orderId, captureId, number, carrier = 'UPS'] = args;
    const o = await must('track', 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`, { capture_id: captureId, tracking_number: number, carrier, notify_payer: false });
    console.log(`order ${o.id}: trackers ${JSON.stringify(o.purchase_units?.[0]?.shipping?.trackers?.map((t) => [t.id, t.status]) ?? [])}`);
  } else if (cmd === 'refund' && args[1]) {
    const r = await must('refund', 'POST', `/v2/payments/captures/${encodeURIComponent(args[0])}/refund`, { amount: { currency_code: 'USD', value: Number(args[1]).toFixed(2) }, note_to_payer: 'Refund from Driftwood Outfitters' });
    console.log(`refund ${r.id}  ${r.status}`);
  } else if (cmd === 'show' && args[0]) {
    const o = await must('get order', 'GET', `/v2/checkout/orders/${encodeURIComponent(args[0])}`);
    const u = o.purchase_units[0];
    console.log(JSON.stringify({ id: o.id, status: o.status, created: o.create_time, ships_to: u.shipping?.address?.postal_code, captures: u.payments?.captures?.map((c) => [c.id, c.status, c.amount.value]), refunds: u.payments?.refunds?.map((r) => [r.id, r.status, r.amount.value]), trackers: u.shipping?.trackers?.map((t) => [t.id, t.status]) }, null, 2));
  } else {
    console.error('usage: order | capture <order_id> | track <order_id> <capture_id> <tracking_number> [carrier] | refund <capture_id> <amount> | show <order_id>');
    process.exit(1);
  }
}
