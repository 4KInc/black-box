import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, flaggerWarning, heldDelay, MAX_RETRIES, RETRY_MS } from '../autopilot.mjs';
import { executionLog } from '../core.mjs';
import { createWebhookReceiver } from '../webhook.mjs';
import { pollOnce } from '../watch.mjs';

const root = mkdtempSync(join(tmpdir(), 'autopilot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until check() is true (or gives up after timeoutMs), instead of a fixed sleep that a slow
// machine can outrun.
const until = async (check, timeoutMs = 2000) => { const end = Date.now() + timeoutMs; while (!check() && Date.now() < end) await sleep(5); };

// A stand-in for core.resolveDispute that returns scripted outcomes and counts calls.
function fakeResolve(...outcomes) {
  const calls = [];
  const fn = async (id, opts) => { calls.push({ id, ...opts }); await sleep(5); return { status: outcomes[Math.min(calls.length, outcomes.length) - 1] }; };
  fn.calls = calls;
  return fn;
}

async function withReceiver({ verify, resolve }, fn) {
  const autopilot = createAutopilot({ root, execute: true, resolve, retryMs: 10 });
  const server = createWebhookReceiver({ autopilot, verify });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (body, path = '/paypal/webhook') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try { await fn(post); } finally { server.close(); autopilot.stop(); }
}

const event = (id, type = 'CUSTOMER.DISPUTE.CREATED', dispute = 'PP-D-111') => ({ id, event_type: type, resource: { dispute_id: dispute } });

test('an event PayPal does not verify is rejected and never acted on', async () => {
  const resolve = fakeResolve('executed');
  await withReceiver({ verify: async () => false, resolve }, async (post) => {
    const r = await post(event('WH-1'));
    assert.equal(r.status, 401);
    await sleep(30);
    assert.equal(resolve.calls.length, 0);
  });
});

test('a verified dispute event is resolved once, and a redelivery is ignored', async () => {
  const resolve = fakeResolve('executed');
  await withReceiver({ verify: async () => true, resolve }, async (post) => {
    assert.equal((await post(event('WH-2'))).status, 200);
    assert.equal(await (await post(event('WH-2'))).text(), 'duplicate');
    await sleep(30);
    assert.deepEqual(resolve.calls.map((c) => [c.id, c.execute]), [['PP-D-111', true]]);
  });
});

test('other event types and malformed dispute IDs are accepted but not acted on', async () => {
  const resolve = fakeResolve('executed');
  await withReceiver({ verify: async () => true, resolve }, async (post) => {
    await post(event('WH-3', 'PAYMENT.CAPTURE.COMPLETED'));
    await post(event('WH-4', 'CUSTOMER.DISPUTE.CREATED', '../../etc/passwd'));
    assert.equal((await post(event('WH-5'), '/elsewhere')).status, 404);
    await sleep(30);
    assert.equal(resolve.calls.length, 0);
  });
});

test('two triggers for the same dispute at once lead to one resolution', async () => {
  const resolve = fakeResolve('executed');
  const ap = createAutopilot({ root, execute: true, resolve });
  const [a, b] = await Promise.all([ap.handle('PP-D-222', 'webhook'), ap.handle('PP-D-222', 'watcher')]);
  assert.equal(resolve.calls.length, 1);
  assert.equal(a.status, 'executed');
  assert.equal(b.cached, true);
});

test('"not ready" is retried until PayPal allows the action, and gives up after the limit', async () => {
  const ready = fakeResolve('not-ready', 'not-ready', 'executed');
  const ap = createAutopilot({ root, execute: true, resolve: ready, retryMs: 5 });
  await ap.handleWithRetry('PP-D-333', 'webhook');
  await sleep(80);
  assert.equal(ready.calls.length, 3);
  assert.equal(ap.status('PP-D-333'), 'executed');

  const never = fakeResolve('not-ready');
  const ap2 = createAutopilot({ root, execute: true, resolve: never, retryMs: 2, maxRetries: 4 });
  await ap2.handleWithRetry('PP-D-444', 'webhook');
  await sleep(80);
  assert.equal(never.calls.length, 4);
  assert.equal(ap2.status('PP-D-444'), 'gave-up');
});

test('an unknown outcome or a busy lock is checked again later; a hold for a person is final', async () => {
  const later = fakeResolve('outcome-unknown', 'in-progress', 'already-done');
  const ap = createAutopilot({ root, execute: true, resolve: later, retryMs: 5 });
  await ap.handleWithRetry('PP-D-555', 'webhook');
  await until(() => later.calls.length >= 3);
  await sleep(20);
  assert.equal(later.calls.length, 3);
  assert.equal(ap.status('PP-D-555'), 'already-done');

  const person = fakeResolve('held-for-person');
  const ap2 = createAutopilot({ root, execute: true, resolve: person, retryMs: 2 });
  await ap2.handleWithRetry('PP-D-556', 'webhook');
  await ap2.handleWithRetry('PP-D-556', 'poll');
  await sleep(30);
  assert.equal(person.calls.length, 1);
  assert.equal(ap2.status('PP-D-556'), 'held-for-person');
});

test('"not ready" re-checks are spaced by the retry interval, ten at most, never a tight loop', async () => {
  assert.deepEqual([RETRY_MS, MAX_RETRIES], [60_000, 10]); // about ten minutes, then a person
  const times = [];
  const never = async () => { times.push(Date.now()); return { status: 'not-ready' }; };
  const ap = createAutopilot({ root, execute: true, resolve: never, retryMs: 40, maxRetries: 4 });
  await ap.handleWithRetry('PP-D-557', 'webhook');
  await sleep(20);
  assert.equal(times.length, 1, 'no re-check before the interval');
  await until(() => times.length >= 4, 2000);
  await sleep(60);
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 35, `re-check ${i} came ${times[i] - times[i - 1]} ms after the last`);
  assert.equal(ap.status('PP-D-557'), 'gave-up');
});

test('an escalated inquiry is retried with a fresh count until the evidence is sent', async () => {
  const resolve = fakeResolve('not-ready', 'escalated', 'not-ready', 'not-ready', 'executed');
  const ap = createAutopilot({ root, execute: true, resolve, retryMs: 2, maxRetries: 3 });
  await ap.handleWithRetry('PP-D-345', 'webhook');
  await sleep(80);
  assert.equal(resolve.calls.length, 5);
  assert.equal(ap.status('PP-D-345'), 'executed');
});

test('a held dispute is retried with growing intervals, and proceeds once the flagger answers', async () => {
  let t = 0;
  const resolve = fakeResolve('held', 'held', 'held', 'executed');
  const ap = createAutopilot({ root, execute: true, resolve, heldBaseMs: 1000, heldMaxMs: 30_000, now: () => t });
  const at = async (time) => { t = time; return ap.handle('PP-D-356', 'watcher'); };
  assert.equal((await at(0)).retryInMs, 1000);
  assert.equal((await at(999)).cached, true);          // polled again too soon: answered from memory
  assert.equal((await at(1000)).retryInMs, 2000);
  assert.equal((await at(2999)).cached, true);
  assert.equal((await at(3000)).retryInMs, 4000);
  assert.equal((await at(6999)).cached, true);
  assert.equal(resolve.calls.length, 3);               // resolved, and its hold logged, once per step
  assert.equal((await at(7000)).status, 'executed');
  assert.equal(ap.status('PP-D-356'), 'executed');
  assert.equal(resolve.calls.length, 4);
});

test('the hold backoff doubles and is capped at about 30 minutes', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => heldDelay(n, 60_000, 30 * 60_000)), [60_000, 120_000, 240_000, 480_000]);
  assert.equal(heldDelay(6, 60_000, 30 * 60_000), 30 * 60_000);
  assert.equal(heldDelay(50, 60_000, 30 * 60_000), 30 * 60_000);
});

test('a pushed event for a held dispute schedules one retry per step, however often it is triggered', async () => {
  const resolve = fakeResolve('held', 'held', 'executed');
  const ap = createAutopilot({ root, execute: true, resolve, heldBaseMs: 10, heldMaxMs: 20 });
  await ap.handleWithRetry('PP-D-357', 'webhook');
  await ap.handleWithRetry('PP-D-357', 'webhook');      // a redelivery during the hold
  await ap.handleWithRetry('PP-D-357', 'watcher');
  await until(() => ap.status('PP-D-357') === 'executed');
  await sleep(60);                                       // time for any extra retry to fire, if one were scheduled
  assert.equal(resolve.calls.length, 3);
  assert.equal(ap.status('PP-D-357'), 'executed');
});

test('a scheduled retry of a held dispute runs even if its timer fires before the hold ends by the clock', async () => {
  // A frozen clock: by Date.now() every hold is still running. A timer can fire a little early,
  // and a retry must not mistake itself for a duplicate trigger, or the retries stop.
  const resolve = fakeResolve('held', 'held', 'executed');
  const ap = createAutopilot({ root, execute: true, resolve, heldBaseMs: 10, heldMaxMs: 20, now: () => 0 });
  await ap.handleWithRetry('PP-D-358', 'webhook');
  await ap.handleWithRetry('PP-D-358', 'webhook');      // a redelivery during the hold is still ignored
  await until(() => ap.status('PP-D-358') === 'executed');
  assert.equal(resolve.calls.length, 3);
  assert.equal(ap.status('PP-D-358'), 'executed');
});

test('at startup, acting without a flagger prints a warning that money-moving verdicts will be held', () => {
  assert.match(flaggerWarning({ AUTO_EXECUTE: 'on' }), /ANTHROPIC_API_KEY is not set.*HELD/);
  assert.match(flaggerWarning({ AUTO_EXECUTE: 'on', ANTHROPIC_API_KEY: 'k', FLAGGER: 'off' }), /FLAGGER=off.*HELD/);
  assert.equal(flaggerWarning({ AUTO_EXECUTE: 'on', ANTHROPIC_API_KEY: 'k' }), null);
  assert.equal(flaggerWarning({}), null); // a dry run acts on nothing
});

test('dry run is fixed when the autopilot is created', async () => {
  const resolve = fakeResolve('planned');
  await createAutopilot({ root, resolve }).handle('PP-D-555');
  assert.equal(resolve.calls[0].execute, false);
});

test('the watcher hands every open dispute to the autopilot, once each', async () => {
  const resolve = fakeResolve('planned');
  const ap = createAutopilot({ root, resolve });
  await pollOnce(ap, async () => ['PP-D-601', 'PP-D-602']);
  await pollOnce(ap, async () => ['PP-D-601', 'PP-D-602']);
  assert.deepEqual(resolve.calls.map((c) => c.id), ['PP-D-601', 'PP-D-602']);
});

test('execution logs only accept real dispute IDs, and an executed action counts as done', () => {
  assert.throws(() => executionLog(root, '../../x'), /not a dispute ID/);
  const log = executionLog(root, 'PP-D-777');
  assert.equal(log.alreadyExecuted(), false);
  log.write({ step: 'accept-claim REFUND', status: 500 });
  assert.equal(log.alreadyExecuted(), false);
  log.write({ step: 'accept-claim REFUND', status: 200 });
  assert.equal(log.alreadyExecuted(), true);
});

test('the action lock is exclusive across callers on this machine', () => {
  const a = executionLog(root, 'PP-D-888');
  const b = executionLog(root, 'PP-D-888');
  assert.equal(a.lock(), true);
  assert.equal(b.lock(), false);
  a.unlock();
  assert.equal(b.lock(), true);
});
