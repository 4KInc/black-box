// Automatic dispute handling, shared by the webhook receiver and the watcher.
//
// handle(disputeId) resolves a dispute through core.mjs and remembers the outcome:
//   - one dispute is never handled twice at the same time (calls for it are queued)
//   - settled disputes (executed, already done, planned, not ours) are not fetched again
//   - "not ready" (PayPal does not offer the action yet) is retried later, a bounded number of times
//   - "escalated" (an inquiry was escalated so evidence can follow) is retried the same way, with the
//     count starting again
// Whether it acts or only plans is fixed when it is created (execute), never per event.

import { resolveDispute } from './core.mjs';

export function createAutopilot({
  root, execute = false, resolve = resolveDispute,
  retryMs = 60_000, maxRetries = 10, report = () => {},
}) {
  const queue = new Map();    // disputeId -> promise of the handling in progress
  const settled = new Map();  // disputeId -> final status
  const tries = new Map();
  const timers = new Set();

  async function run(disputeId, source) {
    if (settled.has(disputeId)) return { disputeId, status: settled.get(disputeId), cached: true };
    let out;
    try {
      out = await resolve(disputeId, { root, execute, source });
    } catch (e) {
      report({ disputeId, source, status: 'error', error: e.message });
      return { disputeId, status: 'error', error: e.message };
    }
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
    if ((out.status === 'not-ready' || out.status === 'escalated') && !settled.has(disputeId)) {
      const t = setTimeout(() => { timers.delete(t); handleWithRetry(disputeId, `${source} (retry)`); }, retryMs);
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
