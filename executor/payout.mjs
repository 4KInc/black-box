// The agent operator pays the merchant back (PayPal Payouts), after an AGENT verdict was refunded.
//   node executor/payout.mjs <dispute_id> [--execute | --refresh] [--fixture <name>]
//   --refresh looks up the latest payout batch again and logs its batch and item status
//   --fixture copies the logged payout (batch id, batch and item status) into the committed
//   fixtures/recorded/<name>.paypal.json, so the replay and the hosted site show it
// The buyer's refund came out of the merchant's balance, but under the policy the overspend is the
// agent operator's responsibility. This sends exactly the refunded amount from the operator's
// PayPal account to the merchant's, once, and only when:
//   - the logged verdict for the dispute planned a payout (AGENT), and
//   - the refund to the buyer was carried out (accept-claim accepted by PayPal).
// It uses the operator's own credentials (operator/.env), never the merchant's. The merchant is
// paid by its PayPal merchant ID, read from the dispute, and every call is appended to the same
// records/executions/<dispute>.jsonl as the refund.
// A payout whose item PayPal later failed (e.g. SELF_PAY_NOT_ALLOWED) paid nothing: once
// --refresh has logged that, the next --execute is a new attempt with its own lock and batch ID.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPayPal } from '../lib/paypal.mjs';
import { toValue } from '../engine/actions.mjs';
import { executionLog } from './core.mjs';
import { paypalFromLog, payoutAttempts } from '../replay/cases.mjs';

const ok = (e) => e.status >= 200 && e.status < 300;

// What the log says is owed: { amountCents, currency, merchantId } or { why } when nothing is.
export function payoutDue(entries) {
  const verdict = entries.findLast((e) => e.step === 'verdict');
  const payout = verdict?.plan?.payout;
  if (!payout) return { why: 'the verdict planned no payout (only AGENT verdicts do)' };
  const refund = entries.find((e) => /^accept-claim/.test(e.step) && ok(e));
  if (!refund) return { why: 'the buyer has not been refunded yet' };
  if (payoutAttempts(entries).some((a) => !a.failed)) return { why: 'already paid' };
  const dispute = entries.findLast((e) => e.step === 'get dispute' && ok(e))?.response;
  const merchantId = dispute?.disputed_transactions?.[0]?.seller?.merchant_id;
  if (!merchantId) return { why: 'no merchant ID on the dispute' };
  const sent = refund.request?.refund_amount;
  return { amountCents: Math.round(Number(sent.value) * 100), currency: sent.currency_code, merchantId };
}

export async function reimburse(disputeId, { root, execute = false, client, source = 'cli' }) {
  const log = executionLog(root, disputeId);
  const entries = log.read();
  const due = payoutDue(entries);
  if (due.why) return { status: 'nothing-due', why: due.why };
  // Attempt n+1 after n failed ones; the first keeps the original lock and batch ID.
  const failed = payoutAttempts(entries).filter((a) => a.failed).length;
  const suffix = failed ? `-${failed + 1}` : '';
  if (!execute) return { status: 'planned', due, attempt: failed + 1 };

  // Once per attempt, across processes: the lock stays unless PayPal definitely refused.
  const lockPath = join(root, 'records', 'executions', `${disputeId}.payout${failed ? `.${failed + 1}` : ''}.lock`);
  try { writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); } catch { return { status: 'already-done', due }; }
  const amount = { currency: due.currency, value: toValue(due.amountCents) };
  const request = {
    sender_batch_header: {
      sender_batch_id: `blackbox-${disputeId}${suffix}`, // PayPal refuses a second batch with the same ID
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

// Looks up the latest payout batch again and logs it, so a later failure (or success) is on record.
export async function refreshPayout(disputeId, { root, client, source = 'cli' }) {
  const log = executionLog(root, disputeId);
  const last = payoutAttempts(log.read()).at(-1);
  if (!last?.batchId) return { status: 'no-payout' };
  const r = await client.paypal('GET', `/v1/payments/payouts/${last.batchId}`);
  log.write({ step: 'get payout', source, method: 'GET', path: `/v1/payments/payouts/${last.batchId}`, status: r.status, debug_id: r.debugId, request: null, response: r.data });
  if (!r.ok) return { status: 'lookup-failed', batchId: last.batchId, httpStatus: r.status };
  return { status: 'refreshed', batchId: last.batchId, batchStatus: r.data?.batch_header?.batch_status ?? null, itemStatus: r.data?.items?.[0]?.transaction_status ?? null };
}

// Copies the payout logged for a dispute into its committed PayPal fixture. Nothing else in the
// fixture changes, so the case's verdict, rule and action are as before.
export function exportPayout(root, disputeId, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError(`not a fixture name: ${name}`);
  const path = join(root, 'fixtures', 'recorded', `${name}.paypal.json`);
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  if (fixture.disputeId !== disputeId) throw new Error(`${name}.paypal.json is dispute ${fixture.disputeId}, not ${disputeId}`);
  const payout = paypalFromLog(executionLog(root, disputeId).read())?.payout;
  if (!payout) return { status: 'no-payout' };
  writeFileSync(path, JSON.stringify({ ...fixture, payout }, null, 2) + '\n');
  return { status: 'exported', path, payout };
}

if (import.meta.main) {
  const ROOT = join(import.meta.dirname, '..');
  const { readEnv } = await import('../lib/env.mjs');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { execute: { type: 'boolean', default: false }, refresh: { type: 'boolean', default: false }, fixture: { type: 'string' } } });
  const [disputeId] = positionals;
  if (!disputeId) { console.error('usage: node executor/payout.mjs <dispute_id> [--execute | --refresh] [--fixture <name>]'); process.exit(2); }
  // The operator's credentials, kept apart from the merchant's.
  const envPath = join(ROOT, 'operator', '.env');
  if (!existsSync(envPath)) { console.error('operator/.env is missing (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of the operator\'s sandbox app)'); process.exit(2); }
  const operator = readEnv(envPath);
  const client = createPayPal({ id: operator.PAYPAL_CLIENT_ID, secret: operator.PAYPAL_CLIENT_SECRET });
  if (values.refresh) {
    const r = await refreshPayout(disputeId, { root: ROOT, client });
    console.log(r.status === 'refreshed' ? `batch ${r.batchId}  ${r.batchStatus}  item ${r.itemStatus ?? '?'}` : r.status === 'no-payout' ? 'no payout logged for this dispute' : `lookup of batch ${r.batchId} failed (HTTP ${r.httpStatus})`);
    process.exit(r.status === 'refreshed' ? 0 : 1);
  }
  const out = await reimburse(disputeId, { root: ROOT, execute: values.execute, client });
  if (out.status === 'nothing-due') console.log(`nothing to pay: ${out.why}`);
  else console.log(`${out.status}  operator → merchant ${out.due.merchantId}  ${out.due.currency} ${toValue(out.due.amountCents)}${out.batchId ? `  batch ${out.batchId}  ${out.after?.batch_header?.batch_status ?? ''}  item ${out.after?.items?.[0]?.transaction_status ?? '?'}` : ''}${out.status === 'planned' ? `  (attempt ${out.attempt})\n(dry run: add --execute to send it)` : ''}${out.response ? `\n${JSON.stringify(out.response).slice(0, 400)}` : ''}`);
  if (values.fixture) {
    const ex = exportPayout(ROOT, disputeId, values.fixture);
    console.log(ex.status === 'exported' ? `fixture    ${ex.path}  (batch ${ex.payout.batchId}, item ${ex.payout.itemStatus ?? '?'})` : 'fixture    no payout logged for this dispute yet; nothing exported');
  }
}
