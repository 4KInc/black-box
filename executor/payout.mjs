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
// Each payout is an attempt logged before the call (a stable action ID and the hash of the exact
// request) with its result after. The sender_batch_id is fixed per attempt, so PayPal refuses a
// second batch for it. A batch is pending until PayPal reports its item SUCCESS; no new batch is
// made while one is pending, or while an attempt's outcome is unknown (that is held for a person).
// Only an item PayPal reports as failed (e.g. SELF_PAY_NOT_ALLOWED) paid nothing: once that is
// logged (--refresh, or --execute, which looks the pending batch up first), the next --execute is a
// new attempt with its own lock and batch ID.

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPayPal } from '../lib/paypal.mjs';
import { toValue } from '../engine/actions.mjs';
import { executionLog, payloadHash, STALE_LOCK_MS } from './core.mjs';
import { paypalFromLog, payoutAttempts } from '../replay/cases.mjs';

const ok = (e) => e.status >= 200 && e.status < 300;

// What the log says is owed: { amountCents, currency, merchantId } or { why } when nothing is
// (held: true when it waits for a person, because an earlier attempt's outcome is unknown).
export function payoutDue(entries) {
  const verdict = entries.findLast((e) => e.step === 'verdict');
  const payout = verdict?.plan?.payout;
  if (!payout) return { why: 'the verdict planned no payout (only AGENT verdicts do)' };
  const refund = entries.find((e) => /^accept-claim/.test(e.step) && ok(e)) ?? reconciledRefund(entries);
  if (!refund) return { why: 'the buyer has not been refunded yet' };
  const states = payoutAttempts(entries).map((a) => a.state);
  if (states.includes('succeeded')) return { why: 'already paid' };
  if (states.includes('unknown')) return { why: 'outcome unknown: an earlier payout attempt has no known result', held: true };
  if (states.includes('pending')) return { why: 'payout pending: no new batch until PayPal reports the item SUCCESS or failed' };
  const dispute = entries.findLast((e) => e.step === 'get dispute' && ok(e))?.response;
  const merchantId = dispute?.disputed_transactions?.[0]?.seller?.merchant_id;
  if (!merchantId) return { why: 'no merchant ID on the dispute' };
  const sent = refund.request?.refund_amount;
  if (!sent) return { why: 'the refunded amount is not in the log', held: true };
  return { amountCents: Math.round(Number(sent.value) * 100), currency: sent.currency_code, merchantId };
}
// A refund a later run found PayPal had made: the amount is the one its attempt sent.
function reconciledRefund(entries) {
  const r = entries.find((e) => e.step === 'reconciled' && e.kind === 'accept-claim');
  return r && entries.findLast((e) => /^accept-claim/.test(e.step) && e.actionId === r.actionId && e.request);
}

export async function reimburse(disputeId, { root, execute = false, client, source = 'cli' }) {
  const log = executionLog(root, disputeId);
  // A pending batch is looked up first, so its latest item status decides.
  if (execute && payoutAttempts(log.read()).at(-1)?.state === 'pending') await refreshPayout(disputeId, { root, client, source });
  const entries = log.read();
  const due = payoutDue(entries);
  if (due.held) { if (execute) log.write({ step: 'hold', source, why: due.why, kind: 'payout' }); return { status: 'held-for-person', why: due.why }; }
  if (due.why) return { status: 'nothing-due', why: due.why };
  // Attempt n+1 after n failed ones; the first keeps the original lock and batch ID. A refused
  // attempt created no batch, so the next one reuses its ID.
  const failed = payoutAttempts(entries).filter((a) => a.failed).length;
  const suffix = failed ? `-${failed + 1}` : '';
  if (!execute) return { status: 'planned', due, attempt: failed + 1 };

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
  const id = `${disputeId}:payout:${failed + 1}`;
  const hash = payloadHash(request);
  const earlier = payoutAttempts(entries).findLast((a) => a.actionId === id);
  if (earlier && earlier.payloadHash !== hash) {
    const why = 'the payout request differs from the earlier attempt with this batch ID';
    log.write({ step: 'hold', source, why, kind: 'payout', actionId: id, earlier: earlier.payloadHash, now: hash });
    return { status: 'held-for-person', why, due };
  }

  // Once per attempt, across processes on this machine: the lock stays unless PayPal definitely
  // refused. A lock with no attempt logged under it is from a run that died before sending; once
  // stale, it is taken over.
  const lockPath = join(root, 'records', 'executions', `${disputeId}.payout${failed ? `.${failed + 1}` : ''}.lock`);
  try { writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); } catch {
    const age = (() => { try { return Date.now() - statSync(lockPath).mtimeMs; } catch { return null; } })();
    if (earlier || age === null || age < STALE_LOCK_MS) return { status: 'in-progress', due };
    writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`);
  }
  log.write({ step: 'payout-attempt', source, actionId: id, payloadHash: hash, senderBatchId: request.sender_batch_header.sender_batch_id });
  let r;
  try { r = await client.paypal('POST', '/v1/payments/payouts', request); } catch (e) { r = { ok: false, status: null, error: e.message }; }
  log.write({ step: 'payout', source, actionId: id, payloadHash: hash, method: 'POST', path: '/v1/payments/payouts', status: r.status ?? null, debug_id: r.debugId ?? null, request, response: r.data ?? null, ...(r.error ? { error: r.error } : {}) });
  if (!r.ok) {
    if (r.status >= 400 && r.status < 500) { try { unlinkSync(lockPath); } catch { /* gone */ } return { status: 'refused', due, response: r.data }; }
    log.write({ step: 'hold', source, why: 'outcome unknown: the payout was sent but its result is not known', kind: 'payout', actionId: id, status: r.status ?? null });
    return { status: 'outcome-unknown', due };
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
