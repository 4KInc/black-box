// Automatic dispute handling, shared by the webhook receiver and the watcher.
//
// handle(disputeId) resolves a dispute through core.mjs and remembers the outcome:
//   - one dispute is never handled twice at the same time (calls for it are queued)
//   - settled disputes (executed, already done, planned, not ours) are not fetched again
//   - "not ready" (PayPal does not offer the action yet) is retried later, a bounded number of times
//   - "escalated" (an inquiry was escalated so evidence can follow) is retried the same way, with the
//     count starting again
//   - "in-progress" (another run holds the action lock) and "outcome-unknown" (an action was sent
//     but its result is not known) are re-checked later, like "not ready": the next run reads
//     PayPal's dispute and settles the earlier attempt from it, never by sending blindly
//   - "held-for-person" is final: nothing more is sent without a person
//   - "awaiting-documents" and "awaiting-approval" (the evidence desk) wait for the merchant: they
//     are not fetched again until reopen(disputeId), which the desk page calls when the merchant
//     adds a document or approves a package
//   - "held" (the flagger gave no answer, so nothing was sent) is retried with exponential backoff
//     (heldBaseMs, doubling, capped at heldMaxMs), never given up on. Until its next step comes,
//     every trigger for it (webhook, watcher poll) is answered from memory, so the hold is resolved,
//     and logged, once per step
// Whether it acts or only plans is fixed when it is created (execute), never per event.

import { resolveDispute } from './core.mjs';

// The delay before the n-th retry of a held dispute (n = 1, 2, ...).
export const heldDelay = (n, baseMs, maxMs) => Math.min(maxMs, baseMs * 2 ** (n - 1));

// Printed at startup: with no flagger, every money-moving verdict (an AGENT or MERCHANT refund or
// offer) is held for a person; only evidence for an honest purchase is sent.
export function flaggerWarning(env = process.env) {
  if (env.AUTO_EXECUTE !== 'on') return null;
  const why = !env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY is not set' : env.FLAGGER === 'off' ? 'FLAGGER=off' : null;
  return why && `WARNING: ${why}, so the AI flagger cannot run. Every money-moving verdict (AGENT or MERCHANT refunds and offers) will be HELD for a person; only USER evidence is sent.`;
}

// A dispute PayPal does not offer the action on yet is checked again RETRY_MS later, at most
// MAX_RETRIES times (about ten minutes), then left to a person. The watcher's poll (every 30 s)
// also looks at it, so it is never checked more often than that.
export const RETRY_MS = 60_000;
export const MAX_RETRIES = 10;

export function createAutopilot({
  root, execute = false, resolve = resolveDispute,
  retryMs = RETRY_MS, maxRetries = MAX_RETRIES, report = () => {},
  heldBaseMs = 60_000, heldMaxMs = 30 * 60_000, now = () => Date.now(),
}) {
  const queue = new Map();    // disputeId -> promise of the handling in progress
  const settled = new Map();  // disputeId -> final status
  const tries = new Map();
  const held = new Map();     // disputeId -> { n: holds so far, until: time of the next attempt }
  const timers = new Set();

  // retry: this is the retry scheduled for a hold, so it runs even if its timer fired a moment
  // before the hold's end by the clock; only other triggers during a hold are answered from cache.
  async function run(disputeId, source, { retry = false } = {}) {
    if (settled.has(disputeId)) return { disputeId, status: settled.get(disputeId), cached: true };
    const h = held.get(disputeId);
    if (h && !retry && now() < h.until) return { disputeId, status: 'held', cached: true, retryAt: h.until };
    let out;
    try {
      out = await resolve(disputeId, { root, execute, source });
    } catch (e) {
      report({ disputeId, source, status: 'error', error: e.message });
      return { disputeId, status: 'error', error: e.message };
    }
    if (out.status === 'held') {
      const n = (held.get(disputeId)?.n ?? 0) + 1;
      const delay = heldDelay(n, heldBaseMs, heldMaxMs);
      held.set(disputeId, { n, until: now() + delay });
      report({ disputeId, source, status: 'held', why: out.result?.verdict?.why, retryInMs: delay });
      return { ...out, retryInMs: delay };
    }
    held.delete(disputeId);
    report({ disputeId, source, status: out.status, verdict: out.result?.verdict?.verdict, rule: out.result?.verdict?.rule, action: out.result?.plan?.action });
    if (out.status === 'escalated') {
      tries.set(disputeId, 0);
    } else if (['not-ready', 'in-progress', 'outcome-unknown'].includes(out.status)) {
      const n = (tries.get(disputeId) ?? 0) + 1;
      tries.set(disputeId, n);
      if (n >= maxRetries) settled.set(disputeId, 'gave-up');
    } else {
      settled.set(disputeId, out.status);
    }
    return out;
  }

  // Serialises calls per dispute, so a webhook and the watcher can never act on it together.
  function handle(disputeId, source = 'event', opts = {}) {
    const prev = queue.get(disputeId) ?? Promise.resolve();
    const next = prev.then(() => run(disputeId, source, opts));
    queue.set(disputeId, next.finally(() => { if (queue.get(disputeId) === next) queue.delete(disputeId); }));
    return next;
  }

  // For a pushed event: handle now, and if PayPal is not ready yet, try again later.
  async function handleWithRetry(disputeId, source, { retry = false } = {}) {
    const out = await handle(disputeId, source, { retry });
    if (out.status === 'held' && out.cached) return out; // a retry for it is already scheduled
    if (['not-ready', 'escalated', 'held', 'in-progress', 'outcome-unknown'].includes(out.status) && !settled.has(disputeId)) {
      const wait = out.status === 'held' ? out.retryInMs : retryMs;
      const t = setTimeout(() => { timers.delete(t); handleWithRetry(disputeId, `${source} (retry)`, { retry: out.status === 'held' }); }, wait);
      t.unref?.();
      timers.add(t);
    }
    return out;
  }

  return {
    execute,
    handle,
    handleWithRetry,
    status: (id) => settled.get(id) ?? null,
    // The merchant acted on the desk page: look at the dispute again on the next trigger.
    reopen: (id) => { settled.delete(id); tries.delete(id); held.delete(id); },
    stop: () => { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
