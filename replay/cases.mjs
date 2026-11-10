// Where the replay finds its cases:
//   - sealed records in records/ (live runs) and fixtures/recorded/ (committed runs)
//   - the PayPal side of a dispute, from the executor log records/executions/<dispute>.jsonl,
//     or from a committed <name>.paypal.json next to a fixture record
// A case with no PayPal side is shown as a preview: "if this were disputed as not as described".
// A run where the agent bought nothing is a recording too (declined): no order, so no verdict.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { movesMoney } from '../engine/actions.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { recordHash } from '../recorder/recorder.mjs';
import { enrolmentFrom, payerForKey } from '../mandate/server.mjs';
import { attempts } from '../executor/attempts.mjs';
export { settlement } from './settlement.mjs';

const cents = (v) => Math.round(Number(v) * 100);
const amount = (a) => (a ? { cents: cents(a.value), currency: a.currency_code } : null);

// A payout item in one of these states paid nothing; the operator may try again.
export const PAYOUT_FAILED = new Set(['FAILED', 'DENIED', 'RETURNED', 'BLOCKED']);

// Every payout attempt, oldest first, each with its result and the latest logged look at its batch.
// state:
//   'unknown'    the attempt was logged but no result was (a crash or a timeout), or a 5xx
//   'refused'    PayPal answered 4xx: no batch was created
//   'pending'    PayPal created the batch; its item is not yet SUCCESS or failed
//   'succeeded'  the item is SUCCESS
//   'failed'     the item is known to have paid nothing (FAILED, DENIED, RETURNED, BLOCKED)
// Payouts logged before attempts were (a result with no actionId) are read the same way.
export function payoutAttempts(entries) {
  const ok = (e) => e.status >= 200 && e.status < 300;
  const results = entries.filter((e) => e.step === 'payout');
  const list = [
    ...entries.filter((e) => e.step === 'payout-attempt').map((attempt) => ({ attempt, entry: results.find((r) => r.actionId === attempt.actionId && r.payloadHash === attempt.payloadHash && r.at >= attempt.at) ?? null })),
    ...results.filter((r) => !r.actionId && ok(r)).map((entry) => ({ attempt: null, entry })),
  ].sort((x, y) => String((x.attempt ?? x.entry).at).localeCompare(String((y.attempt ?? y.entry).at)));
  return list.map(({ attempt, entry }) => {
    const batchId = entry && ok(entry) ? entry.response?.batch_header?.payout_batch_id ?? null : null;
    const after = entries.findLast((e) => e.step === 'get payout' && ok(e) && batchId && e.response?.batch_header?.payout_batch_id === batchId)?.response ?? null;
    const itemStatus = after?.items?.[0]?.transaction_status ?? null;
    const state = !entry || (!ok(entry) && !(entry.status >= 400 && entry.status < 500)) ? 'unknown'
      : !ok(entry) ? 'refused'
        : itemStatus === 'SUCCESS' ? 'succeeded' : PAYOUT_FAILED.has(itemStatus) ? 'failed' : 'pending';
    return { attempt, entry, actionId: attempt?.actionId ?? null, payloadHash: attempt?.payloadHash ?? null, batchId, after, itemStatus, state, failed: state === 'failed' };
  });
}

// The PayPal facts the replay needs, taken from an executor log. Only IDs, amounts, times and
// statuses are kept: no buyer or seller names or emails.
export function paypalFromLog(entries) {
  const ok = (step) => entries.filter((e) => e.step === step && e.status >= 200 && e.status < 300).map((e) => e.response);
  const dispute = ok('get dispute').at(-1);
  if (!dispute) return null;
  const txn = dispute.disputed_transactions?.[0] ?? {};
  const order = ok('get order').at(-1);
  const capture = ok('get capture').at(-1);
  // An action PayPal accepted, or one a later run found PayPal had carried out (reconciled).
  const done = (e) => e.status >= 200 && e.status < 300;
  const reconciled = (kind) => entries.find((e) => e.step === 'reconciled' && e.kind === kind);
  const executed = entries.find((e) => /^(accept-claim|make-offer|provide-evidence)/.test(e.step) && done(e))
    ?? (() => { const r = ['accept-claim', 'make-offer', 'provide-evidence'].map(reconciled).find(Boolean); return r && { step: r.kind, status: null, at: r.at, debug_id: null }; })();
  const escalated = entries.find((e) => e.step === 'escalate' && done(e)) ?? reconciled('escalate');
  // The payout that counts: the latest one not known to have failed.
  const attempt = payoutAttempts(entries).findLast((a) => a.state === 'pending' || a.state === 'succeeded');
  const payout = attempt?.entry;
  const payoutAfter = attempt?.after;
  const after = ok('get dispute (after)').at(-1);
  const flagger = entries.findLast((e) => e.step === 'flagger' && e.result)?.result ?? null;
  // Actions sent whose result is not known, and the state of the latest payout attempt.
  const unknown = attempts(entries).filter((a) => a.state === 'unknown').map((a) => a.kind);
  const payoutState = payoutAttempts(entries).at(-1)?.state ?? null;
  const evidence = entries.findLast((e) => e.step === 'evidence-note')?.note ?? null;
  return {
    disputeId: dispute.dispute_id,
    reason: dispute.reason,
    filedAt: dispute.create_time,
    customId: txn.custom ?? null,
    payeeMerchantId: txn.seller?.merchant_id ?? null,
    payerId: txn.buyer?.payer_id ?? null,
    orderId: order?.id ?? capture?.supplementary_data?.related_ids?.order_id ?? null,
    orderCreatedAt: order?.create_time ?? capture?.create_time ?? null,
    captureId: txn.seller_transaction_id ?? null,
    captured: amount(txn.gross_amount),
    flagger: flagger ? { flagged: flagger.flagged, passages: flagger.passages, model: flagger.model, at: flagger.at } : null,
    evidenceNote: evidence ? { text: evidence.text, source: evidence.source, model: evidence.model ?? null } : null,
    payout: payout ? {
      at: payout.at, httpStatus: payout.status, debugId: payout.debug_id ?? null,
      batchId: payout.response?.batch_header?.payout_batch_id ?? null,
      status: payoutAfter?.batch_header?.batch_status ?? payout.response?.batch_header?.batch_status ?? null,
      itemId: payoutAfter?.items?.[0]?.payout_item_id ?? null,
      itemStatus: payoutAfter?.items?.[0]?.transaction_status ?? null,
      amount: amount({ value: payout.request.items[0].amount.value, currency_code: payout.request.items[0].amount.currency }),
      from: 'agent-operator', to: payout.request.items[0].receiver,
    } : null,
    escalated: escalated ? { at: escalated.at, debugId: escalated.debug_id ?? null } : null,
    ...(unknown.length ? { unknown } : {}),
    ...(payoutState ? { payoutState } : {}),
    executed: executed ? { action: executed.step, httpStatus: executed.status, at: executed.at, debugId: executed.debug_id ?? null } : null,
    after: after ? {
      status: after.status,
      outcome: after.dispute_outcome ? { code: after.dispute_outcome.outcome_code, reason: after.dispute_outcome.outcome_reason ?? null, refunded: amount(after.dispute_outcome.amount_refunded) } : null,
      updatedAt: after.update_time ?? null,
      moneyMovements: (after.money_movements ?? []).map((m) => ({ party: m.affected_party, type: m.type, reason: m.reason, amount: amount(m.amount) })),
      refundTransactions: (after.refund_details?.transactions ?? []).map((t) => ({ id: t.id, amount: amount(t.gross_amount) })),
    } : null,
  };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

export const isDecline = (record) => !record?.purchase && record?.decisions?.at(-1)?.action === 'decline';
// When the run ended: the purchase, or for a decline, its decision.
export const endedAt = (record) => record.purchase?.at ?? record.decisions?.at(-1)?.at ?? '';

export function loadCases(root) {
  const byHash = new Map();
  const add = (record, source, paypal = null) => {
    if (!(record?.purchase || isDecline(record)) || !Array.isArray(record.fetches)) return;
    const hash = recordHash(record);
    const prev = byHash.get(hash);
    byHash.set(hash, { hash, record, source: prev?.source ?? source, paypal: paypal ?? prev?.paypal ?? null, ...(isDecline(record) ? { declined: true } : {}) });
  };

  const fixtures = join(root, 'fixtures', 'recorded');
  for (const f of jsonFiles(fixtures).filter((f) => !f.endsWith('.paypal.json'))) {
    const side = join(fixtures, f.replace(/(\.record)?\.json$/, '.paypal.json'));
    add(readJson(join(fixtures, f)), `fixtures/recorded/${f}`, existsSync(side) ? readJson(side) : null);
  }
  for (const f of jsonFiles(join(root, 'records'))) add(readJson(join(root, 'records', f)), `records/${f}`);

  const logs = join(root, 'records', 'executions');
  if (existsSync(logs)) {
    for (const f of readdirSync(logs).filter((f) => f.endsWith('.jsonl'))) {
      const entries = readFileSync(join(logs, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const paypal = paypalFromLog(entries);
      const c = paypal && byHash.get(paypal.customId);
      if (c) c.paypal = paypal;
    }
  }
  return [...byHash.values()].sort((a, b) => endedAt(b.record).localeCompare(endedAt(a.record)));
}

const DEFAULT_REASON = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const signedMerchantId = (record) => {
  const page = record.fetches[record.purchase.page_index];
  return Buffer.from(page.body_b64, 'base64').toString('utf8').match(/<meta name="paypal-merchant-id" content="([^"]+)">/)?.[1] ?? null;
};

// The verdict, exactly as the executor computes it. Without a dispute, the PayPal side is assumed
// to be the honest one (custom_id = record hash, payee = the signed merchant, captured = the price,
// payer = whoever enrolled the passkey that approved the mandate).
// trustBenchKey: only for case-bench cases (bench/cases.mjs), whose rewritten pages carry the TEST-ONLY key.
// A decline has nothing to judge: null.
export function judge({ hash, record, paypal }, { root, enrolment, trustBenchKey = false } = {}) {
  if (isDecline(record)) return null;
  const preview = !paypal;
  const order = preview
    ? { customId: hash, payeeMerchantId: signedMerchantId(record), createdAt: record.purchase.at, capturedCents: record.purchase.price_cents,
        payerId: root && record.mandate_auth ? payerForKey(root, record.mandate_auth.public_key_spki) : null }
    : { customId: paypal.customId, payeeMerchantId: paypal.payeeMerchantId, createdAt: paypal.orderCreatedAt, capturedCents: paypal.captured.cents, payerId: paypal.payerId ?? null };
  const reason = paypal?.reason ?? DEFAULT_REASON;
  const flaggedPassages = paypal?.flagger?.passages ?? [];
  const j = evaluateCase({ record, order, reason, flaggedPassages, enrolment: enrolment ?? (root ? enrolmentFrom(root) : undefined), trustBenchKey });
  // A dispute where the flagger gave no answer (paypal.flaggerUnavailable): the executor keeps the
  // verdict but sends nothing that moves money (executor/core.mjs), so the plan says it is held.
  if (paypal?.flaggerUnavailable && !paypal.flagger && !paypal.executed && movesMoney(j.plan)) j.plan = { ...j.plan, heldWithoutFlagger: true };
  return { preview, reason, order, flagger: paypal?.flagger ?? null, ...j };
}

// The most recent study for each setup (fixtures/study/study-<date>[-<setup>].json), jackets
// first, or [] if there is none. A file without a setup suffix is the jackets study.
export function latestStudies(root) {
  const dir = join(root, 'fixtures', 'study');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^study-\d{4}-\d{2}-\d{2}(-[a-z]+)?\.json$/.test(f)).sort() : [];
  const bySetup = new Map();
  for (const f of files) bySetup.set(f.match(/^study-\d{4}-\d{2}-\d{2}(?:-([a-z]+))?\.json$/)[1] ?? 'jackets', f);
  const order = [...bySetup.keys()].sort((a, b) => (a === 'jackets' ? -1 : b === 'jackets' ? 1 : a.localeCompare(b)));
  return order.map((k) => JSON.parse(readFileSync(join(dir, bySetup.get(k)), 'utf8')));
}
