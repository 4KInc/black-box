import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimAcceptance, executionLog, HELD_WHY, resolveDispute } from '../core.mjs';
import { recordHash, saveRecord } from '../../recorder/recorder.mjs';

test('a claim for only the overage is accepted in full, for the planned amount', () => {
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 9000), { type: 'REFUND', refundCents: 9000 });
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 24000), { type: 'PARTIAL_REFUND', refundCents: 9000 });
  assert.deepEqual(claimAcceptance({ action: 'accept-claim', refundCents: 24000 }, 24000), { type: 'REFUND', refundCents: 24000 });
  // Never more than the buyer disputed.
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 5000), { type: 'REFUND', refundCents: 5000 });
});

// ---------- the flagger fails closed ----------


const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'recorded', name), 'utf8'));

// A scripted PayPal for one dispute over a stored record; every call is kept.
function fakePayPal(record, { reason, orderCreatedAt }) {
  const calls = [];
  const custom = recordHash(record);
  const dispute = {
    dispute_id: 'PP-D-FLAG', reason, status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_amount: { currency_code: 'USD', value: '240.00' },
    disputed_transactions: [{ custom, seller_transaction_id: 'CAP1', seller: { merchant_id: 'MCYKQUXGB936U' }, buyer: { payer_id: 'PAYER1' }, gross_amount: { currency_code: 'USD', value: '240.00' } }],
    links: [{ rel: 'accept_claim' }, { rel: 'make_offer' }],
  };
  const paypal = async (method, path, json) => {
    calls.push({ method, path, json });
    if (method === 'POST') return { ok: true, status: 200, data: {} };
    if (path.startsWith('/v1/customer/disputes/')) return { ok: true, status: 200, data: dispute };
    if (path.startsWith('/v2/payments/captures/')) return { ok: true, status: 200, data: { create_time: orderCreatedAt, supplementary_data: { related_ids: { order_id: 'ORDER1' } } } };
    return { ok: true, status: 200, data: { id: 'ORDER1', create_time: orderCreatedAt } };
  };
  return { client: { paypal }, calls };
}

async function resolveWith(fixtureName, { reason, flag, execute = true }) {
  const root = mkdtempSync(join(tmpdir(), 'bb-flag-'));
  try {
    const record = fixture(fixtureName);
    saveRecord(join(root, 'records'), { record, hash: recordHash(record) });
    const { client, calls } = fakePayPal(record, { reason, orderCreatedAt: '2026-10-15T00:00:00Z' });
    const out = await resolveDispute('PP-D-FLAG', { root, execute, flag, client });
    return { out, posts: calls.filter((c) => c.method === 'POST'), log: executionLog(root, 'PP-D-FLAG').read() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const broken = async () => { throw new Error('flagger down'); };
const MERCHANT_LIE = 'live-haiku45-merchant-refund.record.json'; // the agent read the shop's hidden $119 note
const CLEAN = 'llama1b-control-overspend.json';                   // nothing hidden on the page

test('flagger throws, merchant hidden text read: no PayPal call, NEEDS A HUMAN, reason logged', async () => {
  const { out, posts, log } = await resolveWith(MERCHANT_LIE, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', flag: broken });
  assert.equal(out.status, 'held');
  assert.equal(out.result.verdict.verdict, 'NEEDS_A_HUMAN');
  assert.equal(out.result.plan.action, 'none');
  assert.equal(posts.length, 0);
  const hold = log.find((e) => e.step === 'hold');
  assert.equal(hold.why, HELD_WHY);
  assert.equal(hold.codeVerdict.verdict, 'MERCHANT');
  assert.equal(log.findLast((e) => e.step === 'verdict').verdict.verdict, 'NEEDS_A_HUMAN');
});

test('no flagger at all (no key, or FLAGGER=off) holds the same case, and a dry run says so too', async () => {
  for (const execute of [true, false]) {
    const { out, posts } = await resolveWith(MERCHANT_LIE, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', flag: () => null, execute });
    assert.equal(out.status, 'held', `execute ${execute}`);
    assert.equal(out.result.verdict.verdict, 'NEEDS_A_HUMAN');
    assert.equal(posts.length, 0);
  }
});

test('flagger throws on a clean page: the code verdict and its action are unchanged', async () => {
  const { out, posts, log } = await resolveWith(CLEAN, { reason: 'INCORRECT_AMOUNT', flag: broken });
  assert.equal(out.status, 'executed');
  assert.equal(out.result.verdict.verdict, 'AGENT');
  assert.equal(out.result.verdict.rule, 5);
  assert.deepEqual(posts.map((c) => c.path), ['/v1/customer/disputes/PP-D-FLAG/accept-claim']);
  assert.equal(posts[0].json.refund_amount.value, '90.00');
  assert.equal(log.some((e) => e.step === 'hold'), false);
});

test('a failed flagger run is not cached: the next run asks again and, with an answer, proceeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-flag-'));
  try {
    const record = fixture(MERCHANT_LIE);
    saveRecord(join(root, 'records'), { record, hash: recordHash(record) });
    const { client, calls } = fakePayPal(record, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', orderCreatedAt: '2026-10-15T00:00:00Z' });
    let asked = 0;
    const first = await resolveDispute('PP-D-FLAG', { root, execute: true, client, flag: async () => { asked++; throw new Error('flagger down'); } });
    assert.equal(first.status, 'held');
    const answer = { flagged: false, passages: [], dropped: [], model: 'test', at: '2026-10-15T00:00:00Z' };
    const second = await resolveDispute('PP-D-FLAG', { root, execute: true, client, flag: async () => { asked++; return answer; } });
    assert.equal(asked, 2);
    assert.equal(second.status, 'executed');
    assert.equal(second.result.verdict.verdict, 'MERCHANT');
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.json.accept_claim_type), ['REFUND']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
