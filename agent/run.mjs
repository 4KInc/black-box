// Runs the shopping agent against the demo shop (start it first with `npm run shop`).
//   node agent/run.mjs [--model claude-sonnet-5-5] [--shelf RJ-BLUE-M,RJ-PREMIUM-BLUE-M] [--no-checkout]
// Saves the sealed record to records/<hash>.json and previews the verdict a
// "not as described" dispute would get.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { saveRecord } from '../recorder/recorder.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { runAgent } from './agent.mjs';
import { DEFAULT_MODEL } from './llm.mjs';

const ROOT = join(import.meta.dirname, '..');
loadEnv(join(ROOT, '.env'));
loadEnv(join(ROOT, 'killtest', '.env'));

const { values } = parseArgs({ options: {
  model: { type: 'string', default: DEFAULT_MODEL },
  shelf: { type: 'string' },
  shop: { type: 'string', default: process.env.SHOP_ORIGIN ?? 'http://localhost:4010' },
  'no-checkout': { type: 'boolean', default: false },
} });

const MANDATE = {
  item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } },
  maxTotalCents: 15000, currency: 'USD', signedShopsOnly: true,
};

const { declined, sealed, choice, order } = await runAgent({
  shopUrl: values.shop, mandate: MANDATE, model: values.model,
  shelf: values.shelf?.split(','), checkout: !values['no-checkout'],
});
if (declined) {
  console.log(`model      ${values.model}`);
  console.log(`declined   ${choice.reason}`);
  process.exit(0);
}
const path = saveRecord(join(ROOT, 'records'), sealed);

console.log(`model      ${values.model}`);
console.log(`chose      ${choice.sku}: ${choice.reason}`);
console.log(`record     ${sealed.hash}`);
console.log(`saved      ${path}`);
if (order) console.log(`order      ${order.order_id}  $${order.amount}  approve: ${order.approve_url}`);

const preview = evaluateCase({
  record: sealed.record,
  order: { customId: sealed.hash, payeeMerchantId: process.env.SHOP_PAYPAL_MERCHANT_ID ?? 'MCYKQUXGB936U', createdAt: new Date().toISOString(), capturedCents: sealed.record.purchase.price_cents },
  reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
});
console.log(`\nif disputed as "not as described": ${preview.verdict.verdict} (rule ${preview.verdict.rule}) -> ${preview.plan.action}`);
for (const f of preview.findings) {
  console.log(`  hidden [${f.method}] names item=${f.namesPurchasedItem} read by model=${f.inModelInput} third-party=${f.thirdPartySigned}: "${f.text.slice(0, 80)}..."`);
}
