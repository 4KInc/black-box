// Automatic dispute handling, shared by the webhook receiver and the watcher.
//
// handle(disputeId) resolves a dispute through core.mjs and remembers the outcome:
//   - one dispute is never handled twice at the same time (calls for it are queued)
//   - settled disputes (executed, already done, planned, not ours) are not fetched again
//   - "not ready" (PayPal does not offer the action yet) is retried later, a bounded number of times
//   - "escalated" (an inquiry was escalated so evidence can follow) is retried the same way, with the
//     count starting again
//   - "held" (the flagger gave no answer, so nothing was sent) is retried with exponential backoff
//     (heldBaseMs, doubling, capped at heldMaxMs), never given up on. Until its next step comes,
//     every trigger for it (webhook, watcher poll) is answered from memory, so the hold is resolved,
//     and logged, once per step
// Whether it acts or only plans is fixed when it is created (execute), never per event.

import { resolveDispute } from './core.mjs';

// The delay before the n-th retry of a held dispute (n = 1, 2, ...).
export const heldDelay = (n, baseMs, maxMs) => Math.min(maxMs, baseMs * 2 ** (n - 1));

// Printed at startup: with no flagger, every case where the agent read the merchant's hidden text
// about the item is held for a person, so MERCHANT outcomes never execute.
export function flaggerWarning(env = process.env) {
  if (env.AUTO_EXECUTE !== 'on') return null;
  const why = !env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY is not set' : env.FLAGGER === 'off' ? 'FLAGGER=off' : null;
  return why && `WARNING: ${why}, so the AI flagger cannot run. Disputes where the agent read the merchant's hidden text about the item (MERCHANT-type cases) will be HELD for a person, not refunded.`;
}

export function createAutopilot({
  root, execute = false, resolve = resolveDispute,
  retryMs = 60_000, maxRetries = 10, report = () => {},
  heldBaseMs = 60_000, heldMaxMs = 30 * 60_000, now = () => Date.now(),
}) {
  const queue = new Map();    // disputeId -> promise of the handling in progress
  const settled = new Map();  // disputeId -> final status
  const tries = new Map();
  const held = new Map();     // disputeId -> { n: holds so far, until: time of the next attempt }
  const timers = new Set();

  async function run(disputeId, source) {
    if (settled.has(disputeId)) return { disputeId, status: settled.get(disputeId), cached: true };
    const h = held.get(disputeId);
    if (h && now() < h.until) return { disputeId, status: 'held', cached: true, retryAt: h.until };
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
    } else if (out.status === 'not-ready') {
      const n = (tries.get(disputeId) ?? 0) + 1;
      tries.set(disputeId, n);
      if (n >= maxRetries) settled.set(disputeId, 'gave-up');
    } else {
      settled.set(disputeId, out.status);
    }
    return out;
  }

  // Serialises calls per dispute, so a webhook and the watcher can never act on it together.
  function handle(disputeId, source = 'event') {
    const prev = queue.get(disputeId) ?? Promise.resolve();
    const next = prev.then(() => run(disputeId, source));
    queue.set(disputeId, next.finally(() => { if (queue.get(disputeId) === next) queue.delete(disputeId); }));
    return next;
  }

  // For a pushed event: handle now, and if PayPal is not ready yet, try again later.
  async function handleWithRetry(disputeId, source) {
    const out = await handle(disputeId, source);
    if (out.status === 'held' && out.cached) return out; // a retry for it is already scheduled
    if (['not-ready', 'escalated', 'held'].includes(out.status) && !settled.has(disputeId)) {
      const wait = out.status === 'held' ? out.retryInMs : retryMs;
      const t = setTimeout(() => { timers.delete(t); handleWithRetry(disputeId, `${source} (retry)`); }, wait);
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
    stop: () => { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
