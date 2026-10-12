// The PayPal executor. Given a dispute ID:
//   1. reads the dispute from PayPal (reason, amount, custom_id = record hash, payee merchant ID)
//   2. reads the capture and its order to learn when the order was created
//   3. loads the stored record by its hash and evaluates the case (engine/case.mjs)
//   4. with --execute, carries out the planned PayPal action and records the response
// Without --execute it only prints what it would do.
//   node executor/resolve.mjs <dispute_id> [--execute]

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { accessToken, API, paypal } from '../lib/paypal.mjs';
import { loadRecord } from '../recorder/recorder.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { toValue } from '../engine/actions.mjs';

const ROOT = join(import.meta.dirname, '..');
loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));

const { values, positionals } = parseArgs({ allowPositionals: true, options: { execute: { type: 'boolean', default: false } } });
const [disputeId] = positionals;
if (!disputeId) { console.error('Usage: node executor/resolve.mjs <dispute_id> [--execute]'); process.exit(1); }

const LOG_DIR = join(ROOT, 'records', 'executions');
mkdirSync(LOG_DIR, { recursive: true });
const log = (entry) => appendFileSync(join(LOG_DIR, `${disputeId}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

async function must(step, method, path, json) {
  const r = await paypal(method, path, json);
  log({ step, method, path, status: r.status, debug_id: r.debugId, request: json ?? null, response: r.data });
  if (!r.ok) throw new Error(`${step} failed (${r.status}, debug ${r.debugId}): ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

const cents = (v) => Math.round(Number(v) * 100);
const links = (d) => (d.links ?? []).map((l) => l.rel);

const dispute = await must('get dispute', 'GET', `/v1/customer/disputes/${disputeId}`);
const txn = dispute.disputed_transactions?.[0];
if (!txn?.custom) throw new Error('the disputed transaction carries no custom_id, so there is no Black Box record');

const capture = await must('get capture', 'GET', `/v2/payments/captures/${txn.seller_transaction_id}`);
const orderId = capture.supplementary_data?.related_ids?.order_id;
const order = orderId ? await must('get order', 'GET', `/v2/checkout/orders/${orderId}`) : null;

const record = loadRecord(join(ROOT, 'records'), txn.custom);
const result = evaluateCase({
  record,
  order: {
    customId: txn.custom,
    payeeMerchantId: txn.seller?.merchant_id,
    createdAt: order?.create_time ?? capture.create_time,
    capturedCents: cents(txn.gross_amount.value),
  },
  reason: dispute.reason,
});

console.log(`dispute    ${disputeId}  ${dispute.reason}  ${dispute.status}  stage=${dispute.dispute_life_cycle_stage}`);
console.log(`record     ${txn.custom}`);
console.log(`payee      ${txn.seller?.merchant_id}  (signed: ${result.product ? 'page names ' + (result.facts.payeeMatches ? 'the same ID' : 'a different ID') : 'no product'})`);
console.log(`verdict    ${result.verdict.verdict}  (rule ${result.verdict.rule}): ${result.verdict.why}`);
for (const f of result.findings) console.log(`  finding  [${f.method}] names item=${f.namesPurchasedItem} read=${f.inModelInput} third-party=${f.thirdPartySigned}`);
console.log(`plan       ${result.plan.action}${result.plan.refundCents ? ' $' + toValue(result.plan.refundCents) : ''}: ${result.plan.note}`);
console.log(`paypal     available actions: ${links(dispute).join(', ')}`);
log({ step: 'verdict', verdict: result.verdict, plan: result.plan, facts: result.facts });

if (!values.execute) { console.log('\n(dry run: add --execute to carry out the plan)'); process.exit(0); }

const note = `Black Box verdict ${result.verdict.verdict} (rule ${result.verdict.rule}). Record ${txn.custom}.`;
const amount = (c) => ({ currency_code: txn.gross_amount.currency_code, value: toValue(c) });
const p = result.plan;

if (p.action === 'accept-claim') {
  await must('accept-claim REFUND', 'POST', `/v1/customer/disputes/${disputeId}/accept-claim`, { note, accept_claim_type: 'REFUND', refund_amount: amount(p.refundCents) });
} else if (p.action === 'accept-claim-partial') {
  await must('accept-claim PARTIAL_REFUND', 'POST', `/v1/customer/disputes/${disputeId}/accept-claim`, { note, accept_claim_type: 'PARTIAL_REFUND', refund_amount: amount(p.refundCents) });
} else if (p.action === 'make-offer') {
  await must('make-offer REFUND', 'POST', `/v1/customer/disputes/${disputeId}/make-offer`, { note, offer_type: 'REFUND', offer_amount: amount(p.refundCents) });
} else if (p.action === 'provide-evidence') {
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: note, documents: [{ name: 'blackbox-record.txt' }] }] })], { type: 'application/json' }));
  // PayPal accepts JPG, GIF, PNG, PDF or TXT evidence, so the record goes up as text.
  form.append('file1', new Blob([JSON.stringify(record, null, 2)], { type: 'text/plain' }), 'blackbox-record.txt');
  const r = await fetch(`${API}/v1/customer/disputes/${disputeId}/provide-evidence`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}` }, body: form });
  log({ step: 'provide-evidence', status: r.status, response: await r.text() });
  if (!r.ok) throw new Error(`provide-evidence failed (${r.status})`);
} else {
  console.log('\nnothing to execute for this verdict');
  process.exit(0);
}
console.log(`\n✓ executed ${p.action}`);
const after = await must('get dispute (after)', 'GET', `/v1/customer/disputes/${disputeId}`);
console.log(`dispute    now ${after.status}  outcome=${after.dispute_outcome?.outcome_code ?? '-'}`);
