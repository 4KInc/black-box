// One dispute, end to end, shared by the CLI (resolve.mjs), the webhook receiver and the watcher:
//   1. reads the dispute from PayPal (reason, amount, custom_id = record hash, payee merchant ID)
//   2. reads the capture and its order to learn when the order was created
//   3. loads the stored record by its hash, asks the AI flagger once (it can only lead to
//      NEEDS A HUMAN; its answer is logged and reused) and evaluates the case (engine/case.mjs)
//   4. with execute: true, carries out the planned PayPal action and records the response
// Every PayPal call is appended to records/executions/<dispute>.jsonl.
//
// Safe to call repeatedly for the same dispute. Every money-moving or evidence call (escalate,
// accept-claim, make-offer, provide-evidence) is an attempt with a stable action ID and a hash of its
// exact payload: the attempt is logged before the call and its result after. A later run that finds
// an attempt with no known result (a crash, a timeout, a 5xx) does not send it again blindly: it
// reads the dispute PayPal reports now and
//   - records the action as done when PayPal shows it happened,
//   - sends it again, same action ID and payload, only when PayPal shows it did not happen and still
//     offers the action,
//   - otherwise holds the dispute for a person ("outcome unknown").
// It acts only when the dispute is open and PayPal offers the action, and only for orders that
// carry a Black Box record. The lock that keeps two runs from sending at once is a file on this
// machine: the service must run as one instance.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessToken, API, PAYPAL_TIMEOUT_MS, paypal, UPLOAD_TIMEOUT_MS } from '../lib/paypal.mjs';
import { loadRecord } from '../recorder/recorder.mjs';
import { evaluateCase } from '../engine/case.mjs';
import { HELD_WHY, IN_SCOPE_REASONS, movesMoney, toValue } from '../engine/actions.mjs';
import { enrolmentFrom } from '../mandate/server.mjs';
import { flagInjection } from '../flagger/flagger.mjs';
import { evidenceFile, evidenceNote, statementsFor, templateNote } from '../evidence/evidence.mjs';
import { actionKind, attempts } from './attempts.mjs';

export { actionKind, attempts };

const cents = (v) => Math.round(Number(v) * 100);

// A lock older than this belonged to a run that died between its attempt and its result. It is well
// above the longest a call can take (a token request, then the evidence upload, each with its
// timeout), so a lock is never taken over while its call may still be in flight.
export const STALE_LOCK_MS = 5 * 60_000;
export const LONGEST_CALL_MS = PAYPAL_TIMEOUT_MS + UPLOAD_TIMEOUT_MS;
// PayPal dispute statuses in which the seller may still act; any other status is held.
export const ACTIONABLE_STATUS = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW']);

export const payloadHash = (payload) => createHash('sha256').update(typeof payload === 'string' ? payload : JSON.stringify(payload)).digest('hex');
export const actionId = (disputeId, kind) => `${disputeId}:${kind}`;

// What PayPal's current dispute says about an action: true (it happened), false (it clearly did
// not), or null (it cannot tell).
export function actionDone(kind, dispute) {
  const closed = !ACTIONABLE_STATUS.has(dispute?.status);
  if (kind === 'accept-claim') {
    const credited = (dispute?.money_movements ?? []).some((m) => m.affected_party === 'BUYER' && m.type === 'CREDIT');
    if (credited || (dispute?.refund_details?.transactions ?? []).length || Number(dispute?.dispute_outcome?.amount_refunded?.value) > 0) return true;
    return closed ? null : false;
  }
  if (kind === 'make-offer') return dispute?.offer?.seller_offered_amount ? true : closed ? null : false;
  // A claim already under review takes it as supporting info instead (the evidence desk).
  if (kind === 'provide-evidence') return [...(dispute?.evidences ?? []), ...(dispute?.supporting_info ?? [])].some((e) => e.source === 'SUBMITTED_BY_SELLER') ? true : closed ? null : false;
  if (kind === 'escalate') {
    const stage = dispute?.dispute_life_cycle_stage;
    return !stage ? null : stage !== 'INQUIRY' ? true : closed ? null : false;
  }
  return null;
}

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
    // Held from an action's attempt to its result; exclusive across processes on this machine.
    // A lock left by a run that died is stale after STALE_LOCK_MS and may be taken over.
    lock: () => { try { writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); return true; } catch { return false; } },
    lockAge: (now = Date.now()) => { try { return now - statSync(lockPath).mtimeMs; } catch { return null; } },
    unlock: () => { try { unlinkSync(lockPath); } catch { /* already gone */ } },
    write: (entry) => appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'),
    alreadyExecuted: () => attempts(read()).some((a) => a.kind !== 'escalate' && a.state === 'succeeded'),
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
//   'held'           the flagger gave no answer and the plan moves money (an AGENT or MERCHANT
//                    refund or offer): nothing sent, the code verdict kept, plan.heldWithoutFlagger
//                    set (try again once the flagger works)
//   'in-progress'    another run holds the action lock (try again later)
//   'outcome-unknown' the action was sent but its result is not known (a timeout, a 5xx): nothing
//                    more is sent; the next run reads PayPal's dispute to settle it
//   'held-for-person' nothing sent, and nothing will be without a person: the dispute is closed or
//                    in a state Black Box does not act in, an earlier attempt's outcome cannot be
//                    told from PayPal, or the payload differs from that attempt's (why says which)
// With the evidence desk (desk: resolveDesk from desk/run.mjs), a dispute the engine does not take
// goes there instead of 'not-ours' or a hold, and may also end:
//   'awaiting-documents' the evidence does not prove the reason yet; nothing sent
//   'awaiting-approval'  the evidence package is ready and waits for the merchant's approval
// The flagger runs when an Anthropic key is set and FLAGGER is not "off". It is the only check for
// agent-directed lies code cannot see, so it fails closed: with no flagger answer, no money moves.
// A hiding method code does not list leaves no finding at all, so code alone would make the agent's
// operator pay a merchant that lied. provide-evidence (USER) moves no money and still goes.
const defaultFlag = (record) => (process.env.ANTHROPIC_API_KEY && process.env.FLAGGER !== 'off' ? flagInjection(record) : null);
// The evidence note is worded by an AI when a key is set and NARRATOR is not "off"; otherwise, or
// when the AI's note fails the check, it is the code-built statements themselves.
const defaultNarrate = (statements) => (process.env.ANTHROPIC_API_KEY && process.env.NARRATOR !== 'off'
  ? evidenceNote(statements)
  : { text: templateNote(statements), source: 'template', model: null, rejected: null });

export { HELD_WHY };

// Settles earlier attempts at these kinds of action from the dispute PayPal reports now: one PayPal
// shows happened is logged as reconciled. Returns null when nothing is in doubt, or what to hold on
// when an attempt's outcome is still unknown and PayPal does not clearly offer it again.
export function reconcile(log, kinds, { dispute, links, source }) {
  for (const k of kinds) {
    const last = attempts(log.read()).findLast((a) => a.kind === k);
    if (!last || last.state === 'succeeded' || !last.actionId) continue;
    const done = actionDone(k, dispute);
    if (done === true) log.write({ step: 'reconciled', source, actionId: last.actionId, kind: k, result: 'succeeded', why: 'PayPal shows it happened' });
    else if (last.state === 'unknown' && !(done === false && links.includes(LINK_FOR[k] ?? k))) {
      return { actionId: last.actionId, paypalStatus: dispute.status ?? null };
    }
  }
  return null;
}

// One attempt at an action: the payload's hash is checked against the last attempt's, the attempt
// is logged, the call made, and its result logged, all under the lock. Returns { status }:
//   'sent' PayPal accepted it; 'busy' another run holds the lock; 'done' it already succeeded;
//   'held' (with why) the payload differs from an earlier attempt; 'unknown' no known result.
// A 4xx is a refusal and throws.
export async function sendOnce(log, { disputeId, source, kind, step, payload, call }) {
  const id = actionId(disputeId, kind);
  const hash = payloadHash(payload);
  if (!log.lock()) {
    const age = log.lockAge();
    if (age !== null && age < STALE_LOCK_MS) return { status: 'busy' };
    log.write({ step: 'stale-lock', source, actionId: id, ageMs: age });
    log.unlock();
    if (!log.lock()) return { status: 'busy' };
  }
  try {
    // Re-read under the lock: another run may have finished it since.
    const last = attempts(log.read()).findLast((a) => a.actionId === id);
    if (last?.state === 'succeeded') return { status: 'done' };
    if (last && last.payloadHash !== hash) {
      const why = 'the payload differs from the earlier attempt at this action';
      log.write({ step: 'hold', source, why, actionId: id, earlier: last.payloadHash, now: hash });
      return { status: 'held', why };
    }
    log.write({ step: 'attempt', source, actionId: id, kind, action: step, payloadHash: hash });
    let r;
    try { r = await call(); } catch (e) { r = { ok: false, status: null, error: e.message }; }
    log.write({ step, source, actionId: id, payloadHash: hash, status: r.status ?? null, debug_id: r.debugId ?? null, request: typeof payload === 'string' ? null : payload, response: r.data ?? r.text ?? null, ...(r.error ? { error: r.error } : {}) });
    if (r.ok) return { status: 'sent' };
    if (r.status >= 400 && r.status < 500) throw Object.assign(new Error(`${step} failed (${r.status}, debug ${r.debugId}): ${JSON.stringify(r.data ?? r.text).slice(0, 400)}`), { refused: true });
    log.write({ step: 'hold', source, why: 'outcome unknown', actionId: id, status: r.status ?? null, error: r.error ?? null });
    return { status: 'unknown' };
  } finally {
    log.unlock();
  }
}

// The evidence upload is multipart, so it does not go through lib/paypal.mjs's JSON client.
export async function uploadEvidence(disputeId, form, endpoint = 'provide-evidence') {
  const path = endpoint === 'provide-supporting-info' ? `/v1/customer/disputes/${disputeId}/provide-supporting-info` : `/v1/customer/disputes/${disputeId}/provide-evidence`;
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}` }, body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

export async function resolveDispute(disputeId, { root, execute = false, source = 'cli', flag = defaultFlag, narrate = defaultNarrate, client = { paypal }, desk = null }) {
  const log = executionLog(root, disputeId);
  async function must(step, method, path, json) {
    const r = await client.paypal(method, path, json);
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
  // The evidence desk (desk/run.mjs), when given, takes what the engine does not: an order with no
  // Black Box record, or a reason the engine does not answer.
  if (desk && (!record || !IN_SCOPE_REASONS.includes(dispute.reason))) {
    if (!txn?.seller_transaction_id) { log.write({ step: 'skip', source, why: 'no disputed transaction' }); return { ...base, status: 'not-ours' }; }
    const capture = await must('get capture', 'GET', `/v2/payments/captures/${txn.seller_transaction_id}`);
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    const order = orderId ? await must('get order', 'GET', `/v2/checkout/orders/${orderId}`) : null;
    return desk({ root, disputeId, dispute, order, log, source, execute, client, base });
  }
  if (!record) {
    log.write({ step: 'skip', source, why: txn?.custom ? `no stored record ${txn.custom}` : 'no custom_id on the disputed transaction' });
    return { ...base, status: 'not-ours' };
  }

  const capture = await must('get capture', 'GET', `/v2/payments/captures/${txn.seller_transaction_id}`);
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  const order = orderId ? await must('get order', 'GET', `/v2/checkout/orders/${orderId}`) : null;

  // One flagger answer per record: retries and re-runs replay the logged one. A failure is logged
  // but is not an answer, so a later run asks again.
  let flagger = log.read().findLast((e) => e.step === 'flagger' && e.custom === txn.custom && e.result)?.result ?? null;
  if (!flagger) {
    try {
      const r = await flag(record);
      if (r) { flagger = { flagged: r.flagged, passages: r.passages, dropped: r.dropped, model: r.model, at: r.at }; log.write({ step: 'flagger', source, custom: txn.custom, result: flagger }); }
    } catch (e) {
      log.write({ step: 'flagger', source, custom: txn.custom, error: e.message });
    }
  }

  let result = evaluateCase({
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
  const held = !flagger && movesMoney(result.plan);
  if (held) {
    log.write({ step: 'hold', source, why: HELD_WHY, codeVerdict: result.verdict, codePlan: result.plan });
    result = { ...result, plan: { ...result.plan, heldWithoutFlagger: true } };
  }
  log.write({ step: 'verdict', source, verdict: result.verdict, plan: result.plan, facts: result.facts });
  const out = { ...base, record, txn, result, flagger };

  if (held) return { ...out, status: 'held' };

  const p = result.plan;
  const hold = (why, extra = {}) => { log.write({ step: 'hold', source, why, ...extra }); return { ...out, status: 'held-for-person', why }; };
  // A reason Black Box does not answer (non-receipt, duplicates, unknown ones) goes to a person.
  if (execute && !IN_SCOPE_REASONS.includes(dispute.reason)) return hold(`the dispute reason ${dispute.reason ?? '(none)'} is not one Black Box acts on`);
  if (!execute || p.action === 'none') return { ...out, status: 'planned' };

  // Earlier attempts at the planned action (and at escalating, for evidence) come first: one that
  // succeeded means done; one whose outcome is unknown is settled from what PayPal shows now.
  const kind = p.action === 'accept-claim-partial' ? 'accept-claim' : p.action;
  const unsettled = reconcile(log, kind === 'provide-evidence' ? ['escalate', kind] : [kind], { dispute, links, source });
  if (unsettled) return hold('outcome unknown', unsettled);
  if (log.alreadyExecuted()) return { ...out, status: 'already-done' };
  if (!ACTIONABLE_STATUS.has(dispute.status)) return hold(`the dispute is ${dispute.status ?? 'in an unknown state'}; Black Box acts only on an open dispute`);

  if (!links.includes(LINK_FOR[p.action])) {
    // An honest purchase is defended with evidence, and PayPal takes evidence only on a claim. An
    // inquiry is escalated once, by the same rule; the evidence goes on a later run, once PayPal
    // offers it. Until PayPal offers an action, nothing is sent ('not-ready', re-checked a bounded
    // number of times, then left to a person).
    const escalated = attempts(log.read()).some((a) => a.kind === 'escalate' && a.state === 'succeeded');
    if (p.action !== 'provide-evidence' || escalated) return { ...out, status: 'not-ready' };
    if (dispute.dispute_life_cycle_stage === 'INQUIRY' && !links.includes('escalate')) return hold('an inquiry PayPal does not let Black Box escalate, so it cannot take evidence');
    if (!links.includes('escalate')) return { ...out, status: 'not-ready' };
    const note = `Black Box verdict ${result.verdict.verdict} (rule ${result.verdict.rule}): the purchase was within the buyer's mandate. Escalating so PayPal can review the evidence. Record ${txn.custom}.`;
    const sent = await send('escalate', 'escalate', { note }, () => client.paypal('POST', `/v1/customer/disputes/${disputeId}/escalate`, { note }));
    return sent.status === 'sent' ? { ...out, status: 'escalated' } : sent.result;
  }

  const sent = await act();
  if (sent.status !== 'sent') return sent.result;
  const after = await must('get dispute (after)', 'GET', `/v1/customer/disputes/${disputeId}`);
  return { ...out, status: 'executed', after };

  async function send(k, step, payload, call) {
    const a = await sendOnce(log, { disputeId, source, kind: k, step, payload, call });
    if (a.status === 'busy') return { status: 'busy', result: { ...out, status: 'in-progress' } };
    if (a.status === 'done') return { status: 'done', result: { ...out, status: 'already-done' } };
    if (a.status === 'held') return { status: 'held', result: { ...out, status: 'held-for-person', why: a.why } };
    if (a.status === 'unknown') return { status: 'unknown', result: { ...out, status: 'outcome-unknown', why: 'outcome unknown' } };
    return a;
  }

  // The one PayPal call the plan allows. Hoisted, so it reads in plan order above.
  async function act() {
    const note = `Black Box verdict ${result.verdict.verdict} (rule ${result.verdict.rule}). Record ${txn.custom}.`;
    const amount = (c) => ({ currency_code: txn.gross_amount.currency_code, value: toValue(c) });

    if (p.action === 'accept-claim' || p.action === 'accept-claim-partial') {
      const { type, refundCents } = claimAcceptance(p, cents(dispute.dispute_amount?.value ?? txn.gross_amount.value));
      const body = { note, accept_claim_type: type, refund_amount: amount(refundCents) };
      return send('accept-claim', `accept-claim ${type}`, body, () => client.paypal('POST', `/v1/customer/disputes/${disputeId}/accept-claim`, body));
    }
    if (p.action === 'make-offer') {
      const body = { note, offer_type: 'REFUND', offer_amount: amount(p.refundCents) };
      return send('make-offer', 'make-offer REFUND', body, () => client.paypal('POST', `/v1/customer/disputes/${disputeId}/make-offer`, body));
    }
    // provide-evidence
    const statements = statementsFor({ record, j: { ...result, order: { capturedCents: cents(txn.gross_amount.value) } }, hash: txn.custom, reason: dispute.reason });
    // One note per record, like the flagger: a retry sends the note already logged.
    let evidence = log.read().findLast((e) => e.step === 'evidence-note' && e.custom === txn.custom)?.note ?? null;
    if (!evidence) {
      evidence = await narrate(statements);
      log.write({ step: 'evidence-note', source, custom: txn.custom, statements, note: evidence });
    }
    const input = JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: `${evidence.text}\n\n${note}`, documents: [{ name: 'blackbox-evidence.txt' }] }] });
    // PayPal accepts JPG, GIF, PNG, PDF or TXT evidence, so the note, statements and record go up as text.
    const file = evidenceFile({ note: evidence, statements, record });
    return send('provide-evidence', 'provide-evidence', input + '\n' + file, () => {
      const form = new FormData();
      form.append('input', new Blob([input], { type: 'application/json' }));
      form.append('file1', new Blob([file], { type: 'text/plain' }), 'blackbox-evidence.txt');
      return (client.evidence ?? uploadEvidence)(disputeId, form);
    });
  }
}
