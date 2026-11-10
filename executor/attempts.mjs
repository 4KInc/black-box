// What became of each action Black Box attempted on a dispute, read from its execution log
// (records/executions/<dispute>.jsonl). No imports: the executor and the replay both read it.

export const ACTION_STEP = /^(accept-claim|make-offer|provide-evidence)/;
const ok = (e) => e.status >= 200 && e.status < 300;
const refused = (e) => e.status >= 400 && e.status < 500;

// One action ID per kind of action on a dispute; a partial accept-claim is the same endpoint.
export const actionKind = (step) => (step === 'escalate' ? 'escalate' : String(step).match(ACTION_STEP)?.[1] ?? step);

// The latest attempt at each action, with what became of it:
//   'succeeded'  PayPal accepted it, or PayPal later showed it had happened (reconciled)
//   'refused'    PayPal answered 4xx: it did not happen
//   'unknown'    no result logged (a crash or a timeout), a 5xx, or a network error
// Entries from before attempts were logged (a result with no actionId) count as succeeded or refused.
export function attempts(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.step === 'attempt') out.set(e.actionId, { actionId: e.actionId, kind: e.kind, step: e.action, payloadHash: e.payloadHash, at: e.at, state: 'unknown' });
    else if (e.step === 'reconciled' && out.has(e.actionId)) out.get(e.actionId).state = 'succeeded';
    else if ((ACTION_STEP.test(e.step ?? '') || e.step === 'escalate') && e.actionId && out.has(e.actionId)) {
      out.get(e.actionId).state = ok(e) ? 'succeeded' : refused(e) ? 'refused' : 'unknown';
    } else if ((ACTION_STEP.test(e.step ?? '') || e.step === 'escalate') && !e.actionId && (ok(e) || refused(e))) {
      const kind = actionKind(e.step);
      out.set(`legacy:${kind}`, { actionId: null, kind, step: e.step, at: e.at, state: ok(e) ? 'succeeded' : 'refused' });
    }
  }
  return [...out.values()];
}
