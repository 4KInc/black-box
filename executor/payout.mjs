// The agent operator pays the merchant back (PayPal Payouts), after an AGENT verdict was refunded.
//   node executor/payout.mjs <dispute_id> [--execute]
// The buyer's refund came out of the merchant's balance, but under the policy the overspend is the
// agent operator's responsibility. This sends exactly the refunded amount from the operator's
// PayPal account to the merchant's, once, and only when:
//   - the logged verdict for the dispute planned a payout (AGENT), and
//   - the refund to the buyer was carried out (accept-claim accepted by PayPal).
// It uses the operator's own credentials (operator/.env), never the merchant's. The merchant is
// paid by its PayPal merchant ID, read from the dispute, and every call is appended to the same
// records/executions/<dispute>.jsonl as the refund.

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPayPal } from '../lib/paypal.mjs';
import { toValue } from '../engine/actions.mjs';
import { executionLog } from './core.mjs';

const ok = (e) => e.status >= 200 && e.status < 300;

// What the log says is owed: { amountCents, currency, merchantId } or { why } when nothing is.
export function payoutDue(entries) {
  const verdict = entries.findLast((e) => e.step === 'verdict');
  const payout = verdict?.plan?.payout;
  if (!payout) return { why: 'the verdict planned no payout (only AGENT verdicts do)' };
  const refund = entries.find((e) => /^accept-claim/.test(e.step) && ok(e));
  if (!refund) return { why: 'the buyer has not been refunded yet' };
  if (entries.some((e) => e.step === 'payout' && ok(e))) return { why: 'already paid' };
  const dispute = entries.findLast((e) => e.step === 'get dispute' && ok(e))?.response;
  const merchantId = dispute?.disputed_transactions?.[0]?.seller?.merchant_id;
  if (!merchantId) return { why: 'no merchant ID on the dispute' };
  const sent = refund.request?.refund_amount;
  return { amountCents: Math.round(Number(sent.value) * 100), currency: sent.currency_code, merchantId };
}

export async function reimburse(disputeId, { root, execute = false, client, source = 'cli' }) {
  const log = executionLog(root, disputeId);
  const due = payoutDue(log.read());
  if (due.why) return { status: 'nothing-due', why: due.why };
  if (!execute) return { status: 'planned', due };

  // Once only, across processes: the lock stays unless PayPal definitely refused.
  const lockPath = join(root, 'records', 'executions', `${disputeId}.payout.lock`);
  try { writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); } catch { return { status: 'already-done', due }; }
  const amount = { currency: due.currency, value: toValue(due.amountCents) };
  const request = {
    sender_batch_header: {
      sender_batch_id: `blackbox-${disputeId}`, // PayPal refuses a second batch with the same ID
      email_subject: 'Agent operator reimbursement',
      email_message: `Reimbursing the refund on dispute ${disputeId}: the agent exceeded the buyer's mandate.`,
    },
    items: [{ recipient_type: 'PAYPAL_ID', receiver: due.merchantId, amount, sender_item_id: disputeId,
      note: `Black Box verdict AGENT on ${disputeId}: the operator's agent overspent; this repays the merchant's refund.` }],
  };
  const r = await client.paypal('POST', '/v1/payments/payouts', request);
  log.write({ step: 'payout', source, method: 'POST', path: '/v1/payments/payouts', status: r.status, debug_id: r.debugId, request, response: r.data });
  if (!r.ok) {
    if (r.status >= 400 && r.status < 500) { try { unlinkSync(lockPath); } catch { /* gone */ } }
    return { status: 'refused', due, response: r.data };
  }
  const batchId = r.data?.batch_header?.payout_batch_id;
  const after = batchId ? await client.paypal('GET', `/v1/payments/payouts/${batchId}`) : null;
  if (after) log.write({ step: 'get payout', source, method: 'GET', path: `/v1/payments/payouts/${batchId}`, status: after.status, debug_id: after.debugId, request: null, response: after.data });
  return { status: 'executed', due, batchId, after: after?.data };
}

if (import.meta.main) {
  const ROOT = join(import.meta.dirname, '..');
  const { readEnv } = await import('../lib/env.mjs');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { execute: { type: 'boolean', default: false } } });
  const [disputeId] = positionals;
  if (!disputeId) { console.error('usage: node executor/payout.mjs <dispute_id> [--execute]'); process.exit(2); }
  // The operator's credentials, kept apart from the merchant's.
  const envPath = join(ROOT, 'operator', '.env');
  if (!existsSync(envPath)) { console.error('operator/.env is missing (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of the operator\'s sandbox app)'); process.exit(2); }
  const operator = readEnv(envPath);
  const client = createPayPal({ id: operator.PAYPAL_CLIENT_ID, secret: operator.PAYPAL_CLIENT_SECRET });
  const out = await reimburse(disputeId, { root: ROOT, execute: values.execute, client });
  if (out.status === 'nothing-due') console.log(`nothing to pay: ${out.why}`);
  else console.log(`${out.status}  operator → merchant ${out.due.merchantId}  ${out.due.currency} ${toValue(out.due.amountCents)}${out.batchId ? `  batch ${out.batchId}  ${out.after?.batch_header?.batch_status ?? ''}` : ''}${out.status === 'planned' ? '\n(dry run: add --execute to send it)' : ''}${out.response ? `\n${JSON.stringify(out.response).slice(0, 400)}` : ''}`);
}
