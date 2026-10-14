import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot } from '../autopilot.mjs';
import { executionLog } from '../core.mjs';
import { createWebhookReceiver } from '../webhook.mjs';
import { pollOnce } from '../watch.mjs';

const root = mkdtempSync(join(tmpdir(), 'autopilot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('the action lock is exclusive across callers and released only on a definite refusal', () => {
  const a = executionLog(root, 'PP-D-888');
  const b = executionLog(root, 'PP-D-888');
  assert.equal(a.lock(), true);
  assert.equal(b.lock(), false);
  a.unlock();
  assert.equal(b.lock(), true);
});
