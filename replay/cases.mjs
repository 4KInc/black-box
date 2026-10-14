// Where the replay finds its cases:
//   - sealed records in records/ (live runs) and fixtures/recorded/ (committed runs)
//   - the PayPal side of a dispute, from the executor log records/executions/<dispute>.jsonl,
//     or from a committed <name>.paypal.json next to a fixture record
// A case with no PayPal side is shown as a preview: "if this were disputed as not as described".

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCase } from '../engine/case.mjs';
import { recordHash } from '../recorder/recorder.mjs';
import { enrolledKeysFrom, payerForKey } from '../mandate/server.mjs';

const cents = (v) => Math.round(Number(v) * 100);
const amount = (a) => (a ? { cents: cents(a.value), currency: a.currency_code } : null);

// The PayPal facts the replay needs, taken from an executor log. Only IDs, amounts, times and
// statuses are kept: no buyer or seller names or emails.
export function paypalFromLog(entries) {
  const ok = (step) => entries.filter((e) => e.step === step && e.status < 300).map((e) => e.response);
  const dispute = ok('get dispute').at(-1);
  if (!dispute) return null;
  const txn = dispute.disputed_transactions?.[0] ?? {};
  const order = ok('get order').at(-1);
  const capture = ok('get capture').at(-1);
  const executed = entries.find((e) => /^(accept-claim|make-offer|provide-evidence)/.test(e.step));
  const after = ok('get dispute (after)').at(-1);
  const flagger = entries.findLast((e) => e.step === 'flagger' && e.result)?.result ?? null;
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

export function loadCases(root) {
  const byHash = new Map();
  const add = (record, source, paypal = null) => {
    if (!record?.purchase || !Array.isArray(record.fetches)) return;
    const hash = recordHash(record);
    const prev = byHash.get(hash);
    byHash.set(hash, { hash, record, source: prev?.source ?? source, paypal: paypal ?? prev?.paypal ?? null });
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
  return [...byHash.values()].sort((a, b) => (b.record.purchase.at ?? '').localeCompare(a.record.purchase.at ?? ''));
}

const DEFAULT_REASON = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const signedMerchantId = (record) => {
  const page = record.fetches[record.purchase.page_index];
  return Buffer.from(page.body_b64, 'base64').toString('utf8').match(/<meta name="paypal-merchant-id" content="([^"]+)">/)?.[1] ?? null;
};

// The verdict, exactly as the executor computes it. Without a dispute, the PayPal side is assumed
// to be the honest one (custom_id = record hash, payee = the signed merchant, captured = the price,
// payer = whoever enrolled the passkey that approved the mandate).
export function judge({ hash, record, paypal }, { root, enrolledKeys } = {}) {
  const preview = !paypal;
  const order = preview
    ? { customId: hash, payeeMerchantId: signedMerchantId(record), createdAt: record.purchase.at, capturedCents: record.purchase.price_cents,
        payerId: root && record.mandate_auth ? payerForKey(root, record.mandate_auth.public_key_spki) : null }
    : { customId: paypal.customId, payeeMerchantId: paypal.payeeMerchantId, createdAt: paypal.orderCreatedAt, capturedCents: paypal.captured.cents, payerId: paypal.payerId ?? null };
  const reason = paypal?.reason ?? DEFAULT_REASON;
  const flaggedPassages = paypal?.flagger?.passages ?? [];
  return { preview, reason, order, flagger: paypal?.flagger ?? null, ...evaluateCase({ record, order, reason, flaggedPassages, enrolledKeys: enrolledKeys ?? (root ? enrolledKeysFrom(root) : undefined) }) };
}
