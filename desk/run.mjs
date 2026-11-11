// The evidence desk inside the executor (executor/core.mjs calls it for a dispute the
// responsibility engine does not take: no Black Box record, or a reason it does not answer).
//
//   1. loads the documents the merchant added (records/desk/<dispute>/docs/)
//   2. reads each message once with the AI (logged by the file's hash and reused, so the decision
//      replays without it); every reading is checked against the file by code (sources.mjs)
//   3. decides by code (desk.mjs) and logs the decision when it changes
//   4. sends the evidence only when the decision is send AND the merchant approved this exact
//      package (records/desk/<dispute>/approved.json holds its hash), or DESK_AUTO=on
// Sending goes through the executor's attempt, lock and reconcile path, so a timeout or a second
// run never sends twice. Concede and person send nothing: no money moves from the desk.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONABLE_STATUS, payloadHash, reconcile, sendOnce, uploadEvidence } from '../executor/core.mjs';
import { attempts } from '../executor/attempts.mjs';
import { decide, deskFile, deskNote, DECISION } from './desk.mjs';
import { deskDir, loadDocs, paypalFacts, recordFacts } from './sources.mjs';
import { extractDoc, readReply } from './extract.mjs';

export const defaultExtract = () => (process.env.ANTHROPIC_API_KEY && process.env.DESK_READER !== 'off' ? extractDoc : null);
export const autoSend = (env = process.env) => env.DESK_AUTO === 'on';

// The package's identity: what would be sent. Approval is for this hash; a new document or a new
// PayPal fact makes a new package, which needs approving again.
export const packageHash = (result, docs) => payloadHash({ evidence: result.evidence, statements: result.statements, docs: docs.map((d) => d.hash) });

const approvalFile = (root, id) => join(deskDir(root, id), 'approved.json');
export function approvedHash(root, disputeId) {
  try { return JSON.parse(readFileSync(approvalFile(root, disputeId), 'utf8')).packageHash ?? null; } catch { return null; }
}
export function approve(root, disputeId, hash) {
  mkdirSync(deskDir(root, disputeId), { recursive: true });
  writeFileSync(approvalFile(root, disputeId), JSON.stringify({ packageHash: hash, at: new Date().toISOString() }, null, 2));
}

// Everything the desk knows about a dispute, from what is logged and on disk: no PayPal call and
// no AI call. Documents not yet read stay unread. Used by the desk page and by resolveDesk.
export function deskState(root, disputeId, entries, { dispute, order } = {}) {
  dispute ??= entries.findLast((e) => e.step === 'get dispute' && e.status >= 200 && e.status < 300)?.response;
  order ??= entries.findLast((e) => e.step === 'get order' && e.status >= 200 && e.status < 300)?.response ?? null;
  if (!dispute) return null;
  const pp = paypalFacts({ dispute, order });
  const docs = loadDocs(root, disputeId);
  const read = docs.map((doc) => {
    if (doc.kind === 'records') {
      try { return { doc, facts: recordFacts(doc.name, JSON.parse(doc.text)), dropped: [], instructions: [] }; } catch { return { doc, facts: [], dropped: [], instructions: [], unread: 'not valid JSON' }; }
    }
    const logged = entries.findLast((e) => e.step === 'desk-read' && e.hash === doc.hash && e.raw !== undefined);
    return logged ? { doc, ...readReply(doc, logged.raw, logged.model) } : { doc, facts: [], dropped: [], instructions: [], unread: 'not read yet' };
  });
  let result = decide(pp, read.flatMap((r) => r.facts), { instructions: read.flatMap((r) => r.instructions.map((quote) => ({ doc: r.doc.name, quote }))) });
  // A message not read yet could say anything (returned to sender), so nothing is sent until it is.
  const unread = read.filter((r) => r.unread);
  if (unread.length && result.decision === DECISION.SEND) {
    result = { ...result, decision: DECISION.MISSING, why: `Not read yet: ${unread.map((r) => r.doc.name).join(', ')}. Nothing is sent until every document is read.`, evidence: null, statements: null,
      checks: [...result.checks, { id: 'read', label: 'Every document read', state: 'missing', detail: unread.map((r) => `${r.doc.name}: ${r.unread}`).join('; '), sources: [] }] };
  }
  const hash = result.decision === DECISION.SEND ? packageHash(result, docs) : null;
  const sent = attempts(entries).find((a) => a.kind === 'provide-evidence' && a.state === 'succeeded') ?? null;
  return { disputeId, pp, docs, read, result, packageHash: hash, approved: Boolean(hash) && approvedHash(root, disputeId) === hash, sent, dispute, order };
}

export async function resolveDesk({ root, disputeId, dispute, order, log, source, execute, client, extract = defaultExtract(), auto = autoSend(), base }) {
  // 2. Read each message the merchant added, once per exact file.
  for (const doc of loadDocs(root, disputeId).filter((d) => d.kind === 'document')) {
    if (log.read().some((e) => e.step === 'desk-read' && e.hash === doc.hash && e.raw !== undefined) || !extract) continue;
    try {
      const r = await extract(doc);
      log.write({ step: 'desk-read', source, doc: doc.name, hash: doc.hash, model: r.model ?? null, raw: r.raw ?? '' });
    } catch (e) {
      log.write({ step: 'desk-read', source, doc: doc.name, hash: doc.hash, error: e.message });
    }
  }

  // 3. Decide, and log the decision when it changes.
  const st = deskState(root, disputeId, log.read(), { dispute, order });
  const last = log.read().findLast((e) => e.step === 'desk-decision');
  if (!last || last.decision !== st.result.decision || last.packageHash !== st.packageHash || last.why !== st.result.why) {
    log.write({ step: 'desk-decision', source, decision: st.result.decision, why: st.result.why, packageHash: st.packageHash, checks: st.result.checks.map(({ id, state, detail }) => ({ id, state, detail })) });
  }
  const out = { ...base, desk: st };
  const links = (dispute.links ?? []).map((l) => l.rel);

  // 4. Act only on send, and only when approved (or automatic).
  if (st.result.decision === DECISION.MISSING) return { ...out, status: 'awaiting-documents' };
  if (st.result.decision !== DECISION.SEND) {
    if (execute) log.write({ step: 'hold', source, why: `evidence desk: ${st.result.decision}`, detail: st.result.why });
    return { ...out, status: 'held-for-person', why: st.result.why };
  }
  if (!execute) return { ...out, status: 'planned' };
  const unsettled = reconcile(log, ['escalate', 'provide-evidence'], { dispute, links, source });
  if (unsettled) { log.write({ step: 'hold', source, why: 'outcome unknown', ...unsettled }); return { ...out, status: 'held-for-person', why: 'outcome unknown' }; }
  if (log.alreadyExecuted()) return { ...out, status: 'already-done' };
  if (!st.approved && !auto) return { ...out, status: 'awaiting-approval' };
  if (!ACTIONABLE_STATUS.has(dispute.status)) {
    log.write({ step: 'hold', source, why: `the dispute is ${dispute.status}; the desk sends evidence only on an open dispute` });
    return { ...out, status: 'held-for-person', why: `the dispute is ${dispute.status}` };
  }

  const mapped = (a) => ({ busy: 'in-progress', done: 'already-done', held: 'held-for-person', unknown: 'outcome-unknown' })[a.status];
  // A claim PayPal already has under review takes the same package as supporting info.
  const supporting = !links.includes('provide_evidence') && links.includes('provide_supporting_info');
  if (!links.includes('provide_evidence') && !supporting) {
    // PayPal takes evidence only on a claim: an approved package on an inquiry escalates it first.
    const escalated = attempts(log.read()).some((a) => a.kind === 'escalate' && a.state === 'succeeded');
    if (escalated || !links.includes('escalate')) return { ...out, status: 'not-ready' };
    const note = `The merchant has evidence for this ${st.result.evidence.evidence_type === 'PROOF_OF_REFUND' ? 'refund' : 'delivery'} and escalates so PayPal can review it.`;
    const a = await sendOnce(log, { disputeId, source, kind: 'escalate', step: 'escalate', payload: { note }, call: () => client.paypal('POST', `/v1/customer/disputes/${disputeId}/escalate`, { note }) });
    return { ...out, status: a.status === 'sent' ? 'escalated' : mapped(a), ...(a.why ? { why: a.why } : {}) };
  }

  const note = deskNote(st.result.statements);
  const endpoint = supporting ? 'provide-supporting-info' : 'provide-evidence';
  const input = JSON.stringify(supporting ? { notes: note } : { evidences: [{ ...st.result.evidence, notes: note, documents: [{ name: 'blackbox-evidence.txt' }] }] });
  const file = deskFile({ note, statements: st.result.statements, docs: st.docs });
  const a = await sendOnce(log, {
    disputeId, source, kind: 'provide-evidence', step: endpoint, payload: input + '\n' + file,
    call: () => {
      const form = new FormData();
      form.append('input', new Blob([input], { type: 'application/json' }));
      form.append('file1', new Blob([file], { type: 'text/plain' }), 'blackbox-evidence.txt');
      return (client.evidence ?? uploadEvidence)(disputeId, form, endpoint);
    },
  });
  if (a.status !== 'sent') return { ...out, status: mapped(a), ...(a.why ? { why: a.why } : {}) };
  const after = await client.paypal('GET', `/v1/customer/disputes/${disputeId}`);
  log.write({ step: 'get dispute (after)', source, method: 'GET', path: `/v1/customer/disputes/${disputeId}`, status: after.status, debug_id: after.debugId, request: null, response: after.data });
  return { ...out, status: 'executed', after: after.data };
}

export const isDeskDispute = (entries) => entries.some((e) => e.step === 'desk-decision');
export const deskLogExists = (root, id) => existsSync(join(root, 'records', 'executions', `${id}.jsonl`));
