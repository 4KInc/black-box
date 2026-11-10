// The execution lifecycle against a scripted PayPal: every action is an attempt logged before the
// call and its result after; an attempt with no known result is settled from the dispute PayPal
// shows on the next run, never resent blindly. No network: the PayPal here is a JavaScript object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionDone, attempts, executionLog, LONGEST_CALL_MS, resolveDispute, STALE_LOCK_MS } from '../core.mjs';
import { createPayPal, PAYPAL_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from '../../lib/paypal.mjs';
import { createAutopilot } from '../autopilot.mjs';
import { payoutDue, reimburse } from '../payout.mjs';
import { payoutAttempts } from '../../replay/cases.mjs';
import { recordHash, saveRecord } from '../../recorder/recorder.mjs';

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'recorded', name), 'utf8'));
const ENROLMENT = fixture('passkey-enrolment.json');
const MERCHANT_LIE = fixture('live-haiku45-merchant-refund.record.json'); // MERCHANT, rule 2: accept-claim $240
const HONEST = fixture('sonnet55-honest-clean.json');                     // USER: provide-evidence
const NAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const ID = 'PP-D-LIFE';
const answer = async () => ({ flagged: false, passages: [], dropped: [], model: 'test', at: '2026-10-15T00:00:00Z' });
const narrate = (statements) => ({ text: statements.join(' '), source: 'template', model: null, rejected: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PayPal for one dispute whose state the test can change. post(path, json) decides what each
// POST does: by default PayPal carries the action out and answers 200.
function world(record, { reason = NAD, links = ['accept_claim'], stage = 'CHARGEBACK' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bb-life-'));
  saveRecord(join(root, 'records'), { record, hash: recordHash(record) });
  mkdirSync(join(root, 'records', 'passkeys'), { recursive: true });
  writeFileSync(join(root, 'records', 'passkeys', `${ENROLMENT.payer_id}.json`), JSON.stringify(ENROLMENT));
  const value = (record.purchase.price_cents / 100).toFixed(2);
  const orderAt = new Date(Date.parse(record.purchase.at) + 60_000).toISOString();
  const dispute = {
    dispute_id: ID, reason, status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: stage,
    dispute_amount: { currency_code: 'USD', value },
    disputed_transactions: [{ custom: recordHash(record), seller_transaction_id: 'CAP1', seller: { merchant_id: 'MCYKQUXGB936U' }, buyer: { payer_id: record.mandate_auth ? ENROLMENT.payer_id : 'PAYER1' }, gross_amount: { currency_code: 'USD', value } }],
    links: links.map((rel) => ({ rel })),
  };
  const posts = [];
  // What PayPal does when an action reaches it.
  const carryOut = (path, json) => {
    if (path.endsWith('/accept-claim')) {
      dispute.money_movements = [{ affected_party: 'BUYER', type: 'CREDIT', reason: 'DISPUTE_SETTLEMENT', amount: json.refund_amount }];
      dispute.links = dispute.links.filter((l) => l.rel !== 'accept_claim');
    }
    if (path.endsWith('/provide-evidence')) dispute.evidences = [{ evidence_type: 'OTHER', source: 'SUBMITTED_BY_SELLER' }];
    if (path.endsWith('/escalate')) { dispute.dispute_life_cycle_stage = 'CHARGEBACK'; dispute.links = [{ rel: 'provide_evidence' }]; }
  };
  const w = {
    root, dispute, posts, carryOut,
    post: async (path, json) => { carryOut(path, json); return { ok: true, status: 200, data: {} }; },
    log: () => executionLog(root, ID).read(),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
  const paypal = async (method, path, json) => {
    if (method === 'POST') { posts.push({ path, json }); return w.post(path, json); }
    if (path.startsWith('/v1/customer/disputes/')) return { ok: true, status: 200, data: structuredClone(dispute) };
    if (path.startsWith('/v2/payments/captures/')) return { ok: true, status: 200, data: { create_time: orderAt, supplementary_data: { related_ids: { order_id: 'ORDER1' } } } };
    return { ok: true, status: 200, data: { id: 'ORDER1', create_time: orderAt } };
  };
  w.client = { paypal, evidence: async (id, form) => { const input = JSON.parse(await form.get('input').text()); posts.push({ path: `/v1/customer/disputes/${id}/provide-evidence`, json: input }); return w.post(`/v1/customer/disputes/${id}/provide-evidence`, input).then((r) => ({ ok: r.ok, status: r.status, text: '{}' })); } };
  w.resolve = (opts = {}) => resolveDispute(ID, { root, execute: true, client: w.client, flag: answer, narrate, ...opts });
  return w;
}

// The attempt is left as a crash leaves it: logged, its result never written, the lock still there.
function crashAfterAttempt(w, { lockAgeMs = STALE_LOCK_MS + 1000 } = {}) {
  const log = executionLog(w.root, ID);
  const lines = readFileSync(log.path, 'utf8').trim().split('\n');
  const attemptAt = lines.findLastIndex((l) => JSON.parse(l).step === 'attempt');
  writeFileSync(log.path, lines.slice(0, attemptAt + 1).join('\n') + '\n');
  const lock = join(w.root, 'records', 'executions', `${ID}.lock`);
  writeFileSync(lock, 'crashed\n');
  const then = new Date(Date.now() - lockAgeMs);
  utimesSync(lock, then, then);
}

test('every action is logged as an attempt, with its payload hash, before its result', async () => {
  const w = world(MERCHANT_LIE);
  try {
    assert.equal((await w.resolve()).status, 'executed');
    const steps = w.log().map((e) => e.step);
    const at = steps.indexOf('attempt');
    assert.ok(at > -1 && steps[at + 1] === 'accept-claim REFUND', steps.join(', '));
    const [a] = attempts(w.log());
    assert.deepEqual([a.actionId, a.kind, a.state], [`${ID}:accept-claim`, 'accept-claim', 'succeeded']);
    assert.match(a.payloadHash, /^[0-9a-f]{64}$/);
  } finally { w.done(); }
});

test('a duplicate webhook acts once', async () => {
  const w = world(MERCHANT_LIE);
  try {
    const ap = createAutopilot({ root: w.root, execute: true, resolve: (id, o) => resolveDispute(id, { ...o, client: w.client, flag: answer, narrate }) });
    const [one, two] = await Promise.all([ap.handle(ID, 'webhook'), ap.handle(ID, 'webhook (redelivered)')]);
    assert.deepEqual([one.status, two.status], ['executed', 'executed']);
    assert.equal(two.cached, true);
    assert.equal((await w.resolve()).status, 'already-done', 'a later run, in another process, finds it done in the log');
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

test('a webhook racing a poll in another process: the lock lets one send, the other waits', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async (path, json) => { await sleep(30); w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    const outs = await Promise.all([w.resolve({ source: 'webhook' }), w.resolve({ source: 'poll' })]);
    assert.deepEqual(outs.map((o) => o.status).sort(), ['executed', 'in-progress']);
    assert.equal(w.posts.length, 1);
    assert.equal((await w.resolve()).status, 'already-done');
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

test('a crash before the call reached PayPal: the dispute shows it did not happen, so it is sent again, same ID and payload', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => new Promise(() => {}); // never answers; the crash below ends the run
    w.resolve();
    await sleep(30);
    crashAfterAttempt(w);
    const first = w.posts[0];
    w.posts.length = 0;
    w.post = async (path, json) => { w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    assert.equal((await w.resolve()).status, 'executed');
    assert.deepEqual(w.posts.map((p) => p.json), [first.json]);
    const tries = w.log().filter((e) => e.step === 'attempt');
    assert.equal(tries.length, 2);
    assert.equal(tries[0].actionId, tries[1].actionId);
    assert.equal(tries[0].payloadHash, tries[1].payloadHash);
  } finally { w.done(); }
});

test('a crash after PayPal accepted: the dispute shows the refund, so it is recorded as done and not sent again', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async (path, json) => { w.carryOut(path, json); throw new Error('socket hang up'); };
    const first = await w.resolve();
    assert.equal(first.status, 'outcome-unknown');
    assert.equal(w.log().findLast((e) => e.step === 'hold').why, 'outcome unknown');
    const second = await w.resolve();
    assert.equal(second.status, 'already-done');
    assert.equal(w.posts.length, 1);
    assert.equal(w.log().filter((e) => e.step === 'reconciled').length, 1);
    assert.equal(attempts(w.log())[0].state, 'succeeded');
  } finally { w.done(); }
});

test('an outcome PayPal cannot settle is held for a person, and nothing is resent', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => ({ ok: false, status: 503, data: { name: 'SERVICE_UNAVAILABLE' } });
    assert.equal((await w.resolve()).status, 'outcome-unknown');
    w.dispute.status = 'OTHER'; // no refund shown, but no longer a state Black Box can read
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.equal(out.why, 'outcome unknown');
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

test('a stale attempt: a fresh lock means another run is sending; once stale, the attempt is settled from PayPal', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => new Promise(() => {});
    w.resolve();
    await sleep(30);
    crashAfterAttempt(w, { lockAgeMs: 1000 });
    w.post = async (path, json) => { w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    assert.equal((await w.resolve()).status, 'in-progress');
    assert.equal(w.posts.length, 1, 'nothing sent while the lock is fresh');
    const lock = join(w.root, 'records', 'executions', `${ID}.lock`);
    const then = new Date(Date.now() - STALE_LOCK_MS - 1000);
    utimesSync(lock, then, then);
    assert.equal((await w.resolve()).status, 'executed');
    assert.equal(w.posts.length, 2);
    assert.ok(w.log().some((e) => e.step === 'stale-lock'));
  } finally { w.done(); }
});

test('a payload that differs from the earlier attempt at the same action is held, never sent', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => ({ ok: false, status: 500, data: {} });
    assert.equal((await w.resolve()).status, 'outcome-unknown');
    w.dispute.dispute_amount.value = '200.00'; // the refund PayPal would now take is different
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.match(out.why, /payload differs/);
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

test('an action PayPal no longer offers, after an unknown outcome, is held', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => ({ ok: false, status: 502, data: {} });
    assert.equal((await w.resolve()).status, 'outcome-unknown');
    w.dispute.links = []; // no refund shown, and accept_claim gone
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.equal(out.why, 'outcome unknown');
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

test('the dispute status is checked before acting: a closed dispute is held, with nothing sent', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.dispute.status = 'RESOLVED';
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.match(out.why, /RESOLVED/);
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('a refusal (4xx) is not an unknown outcome: it throws, and a later run may try again', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => ({ ok: false, status: 422, data: { name: 'UNPROCESSABLE_ENTITY' } });
    await assert.rejects(w.resolve(), /accept-claim REFUND failed \(422/);
    assert.equal(attempts(w.log())[0].state, 'refused');
    w.post = async (path, json) => { w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    assert.equal((await w.resolve()).status, 'executed');
    assert.equal(w.posts.length, 2);
  } finally { w.done(); }
});

test('evidence: an escalation whose outcome is unknown is settled from the dispute stage; then the evidence goes once', async () => {
  const w = world(HONEST, { links: ['escalate'], stage: 'INQUIRY' });
  try {
    w.post = async (path, json) => { w.carryOut(path, json); throw new Error('timeout'); };
    assert.equal((await w.resolve()).status, 'outcome-unknown');
    w.post = async (path, json) => { w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    assert.equal((await w.resolve()).status, 'executed');
    assert.deepEqual(w.posts.map((p) => p.path.split('/').at(-1)), ['escalate', 'provide-evidence']);
    assert.equal((await w.resolve()).status, 'already-done');
    assert.equal(w.posts.length, 2);
  } finally { w.done(); }
});

test('what the dispute says about each action', () => {
  const open = { status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'CHARGEBACK' };
  assert.equal(actionDone('accept-claim', open), false);
  assert.equal(actionDone('accept-claim', { ...open, money_movements: [{ affected_party: 'BUYER', type: 'CREDIT' }] }), true);
  assert.equal(actionDone('accept-claim', { ...open, refund_details: { transactions: [{ id: 'R1' }] } }), true);
  assert.equal(actionDone('accept-claim', { ...open, status: 'RESOLVED' }), null);
  assert.equal(actionDone('make-offer', { ...open, offer: { seller_offered_amount: { value: '90.00' } } }), true);
  assert.equal(actionDone('provide-evidence', { ...open, evidences: [{ source: 'SUBMITTED_BY_BUYER' }] }), false);
  assert.equal(actionDone('escalate', { ...open, dispute_life_cycle_stage: 'INQUIRY' }), false);
  assert.equal(actionDone('escalate', open), true);
  assert.equal(actionDone('escalate', { status: 'OPEN' }), null);
});

// ---------- Payouts ----------

const due = [
  { step: 'get dispute', status: 200, response: { disputed_transactions: [{ seller: { merchant_id: 'MERCH1' } }] } },
  { step: 'verdict', plan: { action: 'accept-claim-partial', refundCents: 9000, payout: { to: 'merchant', from: 'agent-operator', amountCents: 9000 } } },
  { step: 'accept-claim REFUND', status: 200, request: { refund_amount: { currency_code: 'USD', value: '90.00' } } },
];
function payoutWorld() {
  const root = mkdtempSync(join(tmpdir(), 'bb-life-pay-'));
  const log = executionLog(root, 'PP-D-PAY');
  for (const e of due) log.write(e);
  const w = { root, log, posts: [], gets: 0, item: 'PENDING', postWith: null, done: () => rmSync(root, { recursive: true, force: true }) };
  w.client = { paypal: async (method, path, json) => {
    if (method === 'POST') {
      w.posts.push(json);
      if (w.postWith) return w.postWith(json);
      return { ok: true, status: 201, data: { batch_header: { payout_batch_id: `B${w.posts.length}`, batch_status: 'PENDING' } } };
    }
    w.gets++;
    const id = path.split('/').at(-1);
    return { ok: true, status: 200, data: { batch_header: { payout_batch_id: id, batch_status: w.item === 'SUCCESS' ? 'SUCCESS' : 'PENDING' }, items: [{ payout_item_id: `I-${id}`, transaction_status: w.item }] } };
  } };
  w.pay = () => reimburse('PP-D-PAY', { root, client: w.client, execute: true });
  return w;
}

test('payout pending: no new batch; each run looks the batch up first', async () => {
  const w = payoutWorld();
  try {
    assert.equal((await w.pay()).status, 'executed');
    const gets = w.gets;
    const again = await w.pay();
    assert.equal(again.status, 'nothing-due');
    assert.match(again.why, /pending/);
    assert.ok(w.gets > gets, 'the pending batch was looked up again');
    assert.equal(w.posts.length, 1);
    assert.equal(payoutAttempts(w.log.read()).at(-1).state, 'pending');
  } finally { w.done(); }
});

test('payout item failed: one new batch, with its own sender_batch_id', async () => {
  const w = payoutWorld();
  try {
    await w.pay();
    w.item = 'FAILED';
    assert.equal((await w.pay()).status, 'executed');
    assert.deepEqual(w.posts.map((p) => p.sender_batch_header.sender_batch_id), ['blackbox-PP-D-PAY', 'blackbox-PP-D-PAY-2']);
  } finally { w.done(); }
});

test('payout item succeeded: paid, and never sent again', async () => {
  const w = payoutWorld();
  try {
    await w.pay();
    w.item = 'SUCCESS';
    const out = await w.pay();
    assert.equal(out.status, 'nothing-due');
    assert.match(out.why, /already paid/);
    assert.equal(w.posts.length, 1);
    assert.equal(payoutAttempts(w.log.read())[0].state, 'succeeded');
  } finally { w.done(); }
});

test('payout outcome unknown: held for a person, and no new batch is ever made for it', async () => {
  const w = payoutWorld();
  try {
    w.postWith = () => { throw new Error('socket hang up'); };
    assert.equal((await w.pay()).status, 'outcome-unknown');
    w.postWith = null;
    const out = await w.pay();
    assert.equal(out.status, 'held-for-person');
    assert.match(out.why, /outcome unknown/);
    assert.equal(w.posts.length, 1);
    assert.equal(payoutDue(w.log.read()).held, true);
    assert.equal(payoutAttempts(w.log.read())[0].state, 'unknown');
  } finally { w.done(); }
});

test('payout refused (4xx): no batch was made, so the next attempt keeps the same batch ID', async () => {
  const w = payoutWorld();
  try {
    w.postWith = () => ({ ok: false, status: 422, data: { name: 'VALIDATION_ERROR' } });
    assert.equal((await w.pay()).status, 'refused');
    w.postWith = null;
    assert.equal((await w.pay()).status, 'executed');
    assert.deepEqual(w.posts.map((p) => p.sender_batch_header.sender_batch_id), ['blackbox-PP-D-PAY', 'blackbox-PP-D-PAY']);
  } finally { w.done(); }
});

// ---------- only where it fits the dispute reason ----------

test('a reason Black Box does not answer (non-receipt, unknown) is held for a person, with nothing sent', async () => {
  for (const reason of ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'SOMETHING_NEW']) {
    const w = world(HONEST, { reason, links: ['provide_evidence', 'accept_claim'] });
    try {
      const out = await w.resolve();
      assert.equal(out.status, 'held-for-person', reason);
      assert.match(out.why, new RegExp(`${reason} is not one Black Box acts on`));
      assert.equal(out.result.plan.action, 'none');
      assert.equal(w.posts.length, 0);
      assert.equal((await w.resolve({ execute: false })).status, 'planned', 'a dry run only plans');
    } finally { w.done(); }
  }
});

test('evidence on an inquiry PayPal does not let Black Box escalate is held, never sent', async () => {
  const w = world(HONEST, { links: [], stage: 'INQUIRY' });
  try {
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.match(out.why, /inquiry PayPal does not let Black Box escalate/);
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('an action PayPal does not offer yet sends nothing, and is checked again later', async () => {
  const w = world(MERCHANT_LIE, { links: [] });
  try {
    assert.equal((await w.resolve()).status, 'not-ready');
    assert.equal(w.posts.length, 0);
    w.dispute.links = [{ rel: 'accept_claim' }];
    assert.equal((await w.resolve()).status, 'executed');
    assert.equal(w.posts.length, 1);
  } finally { w.done(); }
});

// ---------- request timeouts ----------

// PayPal over a scripted fetch, through the real client (lib/paypal.mjs) and its timeout. hang(path)
// says which calls never answer: they end only when the client's timeout aborts them.
function fetchWorld(w, { timeoutMs = 40 } = {}) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg' } });
  const real = w.client.paypal;
  const f = { calls: [], hang: () => false, signals: 0 };
  f.fetch = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    f.calls.push({ method: init.method, path });
    if (init.signal) f.signals++;
    if (f.hang(path, init.method)) {
      if (init.method === 'POST') w.posts.push({ path, json: JSON.parse(init.body) });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    if (path === '/v1/oauth2/token') return json({ access_token: 'T', expires_in: 3600 });
    const r = await real(init.method, path, init.body ? JSON.parse(init.body) : undefined);
    return json(r.data, r.status);
  };
  f.client = { ...createPayPal({ id: 'id', secret: 'secret' }, { timeoutMs, fetch: f.fetch }), evidence: w.client.evidence };
  return f;
}

test('every PayPal call carries a timeout: 30 s, and 60 s for the evidence upload', async () => {
  assert.equal(PAYPAL_TIMEOUT_MS, 30_000);
  assert.equal(UPLOAD_TIMEOUT_MS, 60_000);
  const w = world(MERCHANT_LIE);
  try {
    const f = fetchWorld(w);
    assert.equal((await w.resolve({ client: f.client })).status, 'executed');
    assert.ok(f.calls.length >= 5);
    assert.equal(f.signals, f.calls.length, 'the token request and every API call are given a signal');
  } finally { w.done(); }
});

test('a hung call times out and is recorded as an unknown outcome; the next run settles it from PayPal', async () => {
  const w = world(MERCHANT_LIE);
  try {
    const f = fetchWorld(w);
    // PayPal carries the refund out, but the answer never comes back.
    f.hang = (path, method) => method === 'POST' && path.endsWith('/accept-claim');
    const origPost = w.post;
    const started = Date.now();
    const first = await w.resolve({ client: f.client });
    assert.ok(Date.now() - started < 2000, 'the client gave up instead of waiting');
    assert.equal(first.status, 'outcome-unknown');
    const result = w.log().findLast((e) => e.step === 'accept-claim REFUND');
    assert.equal(result.status, null);
    assert.match(result.error, /timeout|aborted/i);
    assert.equal(attempts(w.log())[0].state, 'unknown');
    // It had reached PayPal: the dispute now shows the refund.
    w.carryOut('/accept-claim', w.posts[0].json);
    f.hang = () => false;
    w.post = origPost;
    const second = await w.resolve({ client: f.client });
    assert.equal(second.status, 'already-done');
    assert.equal(w.posts.length, 1, 'not sent again');
    assert.ok(w.log().some((e) => e.step === 'reconciled'));
  } finally { w.done(); }
});

test('a hung call that never reached PayPal is sent again on the next run, same ID and payload', async () => {
  const w = world(MERCHANT_LIE);
  try {
    const f = fetchWorld(w);
    f.hang = (path, method) => method === 'POST' && path.endsWith('/accept-claim');
    assert.equal((await w.resolve({ client: f.client })).status, 'outcome-unknown');
    f.hang = () => false;
    assert.equal((await w.resolve({ client: f.client })).status, 'executed');
    const tries = w.log().filter((e) => e.step === 'attempt');
    assert.deepEqual([tries.length, tries[0].payloadHash === tries[1].payloadHash], [2, true]);
  } finally { w.done(); }
});

test('the stale-lock threshold is at least 5 minutes and well over the longest call', () => {
  assert.ok(STALE_LOCK_MS >= 5 * 60_000);
  assert.equal(LONGEST_CALL_MS, PAYPAL_TIMEOUT_MS + UPLOAD_TIMEOUT_MS);
  assert.ok(STALE_LOCK_MS >= 3 * LONGEST_CALL_MS, `${STALE_LOCK_MS} vs ${LONGEST_CALL_MS}`);
});

test('a lock is never taken over before the threshold, however close to it', async () => {
  const w = world(MERCHANT_LIE);
  try {
    w.post = async () => new Promise(() => {});
    w.resolve();
    await sleep(30);
    w.post = async (path, json) => { w.carryOut(path, json); return { ok: true, status: 200, data: {} }; };
    for (const age of [0, LONGEST_CALL_MS, STALE_LOCK_MS - 5000]) {
      crashAfterAttempt(w, { lockAgeMs: age });
      assert.equal((await w.resolve()).status, 'in-progress', `lock ${age} ms old`);
      assert.equal(w.posts.length, 1);
    }
    crashAfterAttempt(w, { lockAgeMs: STALE_LOCK_MS + 1000 });
    assert.equal((await w.resolve()).status, 'executed');
  } finally { w.done(); }
});

test('a payout call that hangs times out and is held, with no second batch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-life-pay-'));
  try {
    const log = executionLog(root, 'PP-D-PAY');
    for (const e of due) log.write(e);
    let posts = 0;
    const hung = async (url, init) => {
      if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
      posts++;
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const client = createPayPal({ id: 'id', secret: 'secret' }, { timeoutMs: 40, fetch: hung });
    assert.equal((await reimburse('PP-D-PAY', { root, client, execute: true })).status, 'outcome-unknown');
    assert.equal((await reimburse('PP-D-PAY', { root, client, execute: true })).status, 'held-for-person');
    assert.equal(posts, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
