// One dispute, end to end, shared by the CLI (resolve.mjs), the webhook receiver and the watcher:
//   1. reads the dispute from PayPal (reason, amount, custom_id = record hash, payee merchant ID)
//   2. reads the capture and its order to learn when the order was created
//   3. loads the stored record by its hash, asks the AI flagger once (it can only lead to
//      NEEDS A HUMAN; its answer is logged and reused) and evaluates the case (engine/case.mjs)
//   4. with execute: true, carries out the planned PayPal action and records the response
// Every PayPal call is appended to records/executions/<dispute>.jsonl.
//
// Safe to call repeatedly for the same dispute: it acts at most once (a logged, successful action
// means "done"), only when PayPal currently offers that action, and only for orders that carry
// a Black Box record.

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessToken, API, paypal } from '../lib/paypal.mjs';
import { loadRecord } from '../recorder/recorder.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { toValue } from '../engine/actions.mjs';
import { enrolmentFrom } from '../mandate/server.mjs';
import { flagInjection } from '../flagger/flagger.mjs';
import { evidenceFile, evidenceNote, statementsFor, templateNote } from '../evidence/evidence.mjs';

const cents = (v) => Math.round(Number(v) * 100);
const ACTION_STEP = /^(accept-claim|make-offer|provide-evidence)/;

// The dispute link PayPal shows when an action is currently allowed.
const LINK_FOR = {
  'accept-claim': 'accept_claim',
  'accept-claim-partial': 'accept_claim',
  'make-offer': 'make_offer',
  'provide-evidence': 'provide_evidence',
};

// How to accept a claim for the planned refund. A buyer who disputed only the overage (an
// "incorrect amount" claim for $90) gets the planned amount by accepting in full; PayPal refuses
// PARTIAL_REFUND there.
export function claimAcceptance(plan, disputedCents) {
  const full = plan.action === 'accept-claim' || plan.refundCents >= disputedCents;
  return { type: full ? 'REFUND' : 'PARTIAL_REFUND', refundCents: Math.min(plan.refundCents, disputedCents) };
}

export function executionLog(root, disputeId) {
  if (!/^[A-Z0-9-]{6,64}$/.test(disputeId)) throw new TypeError(`not a dispute ID: ${disputeId}`);
  const dir = join(root, 'records', 'executions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${disputeId}.jsonl`);
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const lockPath = join(dir, `${disputeId}.lock`);
  return {
    path,
    read,
    // Taken just before an action is sent; exclusive across processes. Released only when PayPal
    // definitely refused the action; after a success, or an unknown outcome, it stays.
    lock: () => { try { writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); return true; } catch { return false; } },
    unlock: () => { try { unlinkSync(lockPath); } catch { /* already gone */ } },
    write: (entry) => appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'),
    alreadyExecuted: () => read().some((e) => ACTION_STEP.test(e.step ?? '') && e.status >= 200 && e.status < 300),
  };
}

// outcome.status is one of:
//   'planned'        dry run, or the plan has no PayPal action
//   'executed'       the action was sent and PayPal accepted it
//   'already-done'   an earlier run already executed an action for this dispute
//   'not-ready'      PayPal does not offer the planned action yet (try again later)
//   'escalated'      the plan is provide-evidence but the dispute was still an inquiry, where PayPal
//                    takes no evidence; it was escalated to a claim, and evidence follows once
//                    PayPal offers it (try again later)
//   'not-ours'       the disputed order carries no Black Box record
// The flagger runs when an Anthropic key is set and FLAGGER is not "off". Without it, the verdict
// is the code-only one (no flagged passages).
const defaultFlag = (record) => (process.env.ANTHROPIC_API_KEY && process.env.FLAGGER !== 'off' ? flagInjection(record) : null);
// The evidence note is worded by an AI when a key is set and NARRATOR is not "off"; otherwise, or
// when the AI's note fails the check, it is the code-built statements themselves.
const defaultNarrate = (statements) => (process.env.ANTHROPIC_API_KEY && process.env.NARRATOR !== 'off'
  ? evidenceNote(statements)
  : { text: templateNote(statements), source: 'template', model: null, rejected: null });

export async function resolveDispute(disputeId, { root, execute = false, source = 'cli', flag = defaultFlag, narrate = defaultNarrate }) {
  const log = executionLog(root, disputeId);
  async function must(step, method, path, json) {
    const r = await paypal(method, path, json);
    log.write({ step, source, method, path, status: r.status, debug_id: r.debugId, request: json ?? null, response: r.data });
    if (!r.ok) throw Object.assign(new Error(`${step} failed (${r.status}, debug ${r.debugId}): ${JSON.stringify(r.data).slice(0, 400)}`), { refused: true });
    return r.data;
  }

  const dispute = await must('get dispute', 'GET', `/v1/customer/disputes/${disputeId}`);
  const txn = dispute.disputed_transactions?.[0];
  const links = (dispute.links ?? []).map((l) => l.rel);
  const base = { disputeId, dispute, links };

  let record;
  try { record = txn?.custom ? loadRecord(join(root, 'records'), txn.custom) : null; } catch { record = null; }
  if (!record) {
    log.write({ step: 'skip', source, why: txn?.custom ? `no stored record ${txn.custom}` : 'no custom_id on the disputed transaction' });
    return { ...base, status: 'not-ours' };
  }

  const capture = await must('get capture', 'GET', `/v2/payments/captures/${txn.seller_transaction_id}`);
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  const order = orderId ? await must('get order', 'GET', `/v2/checkout/orders/${orderId}`) : null;

  // One flagger answer per record: retries and re-runs replay the logged one.
  let flagger = log.read().findLast((e) => e.step === 'flagger' && e.custom === txn.custom)?.result ?? null;
  if (!flagger) {
    try {
      const r = await flag(record);
      if (r) { flagger = { flagged: r.flagged, passages: r.passages, dropped: r.dropped, model: r.model, at: r.at }; log.write({ step: 'flagger', source, custom: txn.custom, result: flagger }); }
    } catch (e) {
      log.write({ step: 'flagger', source, custom: txn.custom, error: e.message });
    }
  }

  const result = evaluateCase({
    record,
    flaggedPassages: flagger?.passages ?? [],
    order: {
      customId: txn.custom,
      payeeMerchantId: txn.seller?.merchant_id,
      createdAt: order?.create_time ?? capture.create_time,
      capturedCents: cents(txn.gross_amount.value),
      payerId: txn.buyer?.payer_id ?? null,
    },
    reason: dispute.reason,
    enrolment: enrolmentFrom(root),
  });
  log.write({ step: 'verdict', source, verdict: result.verdict, plan: result.plan, facts: result.facts });
  const out = { ...base, record, txn, result, flagger };

  const p = result.plan;
  if (!execute || p.action === 'none') return { ...out, status: 'planned' };
  if (log.alreadyExecuted()) return { ...out, status: 'already-done' };
  if (!links.includes(LINK_FOR[p.action])) {
    // An honest purchase is defended with evidence, and PayPal takes evidence only on a claim. An
    // inquiry is escalated once, by the same rule; the evidence goes on a later run.
    const escalated = log.read().some((e) => e.step === 'escalate' && e.status >= 200 && e.status < 300);
    if (p.action !== 'provide-evidence' || escalated || !links.includes('escalate')) return { ...out, status: 'not-ready' };
    await must('escalate', 'POST', `/v1/customer/disputes/${disputeId}/escalate`, { note: `Black Box verdict ${result.verdict.verdict} (rule ${result.verdict.rule}): the purchase was within the buyer's mandate. Escalating so PayPal can review the evidence. Record ${txn.custom}.` });
    return { ...out, status: 'escalated' };
  }
  if (!log.lock()) return { ...out, status: 'already-done' };
  try {
    await act();
  } catch (e) {
    if (e.refused) log.unlock();
    throw e;
  }
  const after = await must('get dispute (after)', 'GET', `/v1/customer/disputes/${disputeId}`);
  return { ...out, status: 'executed', after };

  // The one PayPal call the plan allows. Hoisted, so it reads in plan order above.
  async function act() {
    const note = `Black Box verdict ${result.verdict.verdict} (rule ${result.verdict.rule}). Record ${txn.custom}.`;
    const amount = (c) => ({ currency_code: txn.gross_amount.currency_code, value: toValue(c) });

    if (p.action === 'accept-claim' || p.action === 'accept-claim-partial') {
      const { type, refundCents } = claimAcceptance(p, cents(dispute.dispute_amount?.value ?? txn.gross_amount.value));
      await must(`accept-claim ${type}`, 'POST', `/v1/customer/disputes/${disputeId}/accept-claim`, { note, accept_claim_type: type, refund_amount: amount(refundCents) });
    } else if (p.action === 'make-offer') {
      await must('make-offer REFUND', 'POST', `/v1/customer/disputes/${disputeId}/make-offer`, { note, offer_type: 'REFUND', offer_amount: amount(p.refundCents) });
    } else if (p.action === 'provide-evidence') {
      const statements = statementsFor({ record, j: { ...result, order: { capturedCents: cents(txn.gross_amount.value) } }, hash: txn.custom, reason: dispute.reason });
      // One note per record, like the flagger: a retry sends the note already logged.
      let evidence = log.read().findLast((e) => e.step === 'evidence-note' && e.custom === txn.custom)?.note ?? null;
      if (!evidence) {
        evidence = await narrate(statements);
        log.write({ step: 'evidence-note', source, custom: txn.custom, statements, note: evidence });
      }
      const form = new FormData();
      form.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: `${evidence.text}\n\n${note}`, documents: [{ name: 'blackbox-evidence.txt' }] }] })], { type: 'application/json' }));
      // PayPal accepts JPG, GIF, PNG, PDF or TXT evidence, so the note, statements and record go up as text.
      form.append('file1', new Blob([evidenceFile({ note: evidence, statements, record })], { type: 'text/plain' }), 'blackbox-evidence.txt');
      const r = await fetch(`${API}/v1/customer/disputes/${disputeId}/provide-evidence`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}` }, body: form });
      log.write({ step: 'provide-evidence', source, status: r.status, response: await r.text() });
      if (!r.ok) throw Object.assign(new Error(`provide-evidence failed (${r.status})`), { refused: true });
    }
  }
}
