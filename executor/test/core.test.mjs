import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const ENROLMENT = fixture('passkey-enrolment.json');

// Stores the record, and the buyer's passkey as the site would have it.
function store(root, record) {
  saveRecord(join(root, 'records'), { record, hash: recordHash(record) });
  mkdirSync(join(root, 'records', 'passkeys'), { recursive: true });
  writeFileSync(join(root, 'records', 'passkeys', `${ENROLMENT.payer_id}.json`), JSON.stringify(ENROLMENT));
}
// Each record is paid a minute after the agent bought: a passkey-approved one by the enrolled
// buyer, an unsigned one by a payer with no passkey.
const orderTime = (record) => new Date(Date.parse(record.purchase.at) + 60_000).toISOString();
const payerOf = (record) => (record.mandate_auth ? ENROLMENT.payer_id : 'PAYER1');

// A scripted PayPal for one dispute over a stored record; every call is kept.
function fakePayPal(record, { reason, orderCreatedAt, links = ['accept_claim', 'make_offer'] }) {
  const calls = [];
  const custom = recordHash(record);
  const value = (record.purchase.price_cents / 100).toFixed(2);
  const dispute = {
    dispute_id: 'PP-D-FLAG', reason, status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_amount: { currency_code: 'USD', value },
    disputed_transactions: [{ custom, seller_transaction_id: 'CAP1', seller: { merchant_id: 'MCYKQUXGB936U' }, buyer: { payer_id: payerOf(record) }, gross_amount: { currency_code: 'USD', value } }],
    links: links.map((rel) => ({ rel })),
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

async function resolveWith(fixtureName, { reason, flag, execute = true, links }) {
  const root = mkdtempSync(join(tmpdir(), 'bb-flag-'));
  try {
    const record = fixture(fixtureName);
    store(root, record);
    const { client, calls } = fakePayPal(record, { reason, orderCreatedAt: orderTime(record), links });
    // The evidence upload, kept like any other call; the note is the code-built template.
    client.evidence = async (disputeId) => { calls.push({ method: 'POST', path: `/v1/customer/disputes/${disputeId}/provide-evidence` }); return { ok: true, status: 200, text: '{}' }; };
    const narrate = (statements) => ({ text: statements.map((x) => x.text ?? x).join(' '), source: 'template', model: null, rejected: null });
    const out = await resolveDispute('PP-D-FLAG', { root, execute, flag, client, narrate });
    return { out, posts: calls.filter((c) => c.method === 'POST'), log: executionLog(root, 'PP-D-FLAG').read() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const broken = async () => { throw new Error('flagger down'); };
const MERCHANT_LIE = 'live-haiku45-merchant-refund.record.json'; // the agent read the shop's hidden $119 note
const CLEAN = 'llama1b-control-overspend.json';                   // nothing hidden on the page

const HONEST = 'sonnet55-honest-clean.json';                       // within the mandate, nothing hidden
const answer = { flagged: false, passages: [], dropped: [], model: 'test', at: '2026-10-15T00:00:00Z' };

test('no flagger answer + MERCHANT: held, the code verdict kept, no PayPal call, the reason logged', async () => {
  const { out, posts, log } = await resolveWith(MERCHANT_LIE, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', flag: broken });
  assert.equal(out.status, 'held');
  assert.deepEqual([out.result.verdict.verdict, out.result.verdict.rule], ['MERCHANT', 2]);
  assert.equal(out.result.plan.action, 'accept-claim');
  assert.equal(out.result.plan.heldWithoutFlagger, true);
  assert.equal(posts.length, 0);
  const hold = log.find((e) => e.step === 'hold');
  assert.equal(hold.why, 'flagger unavailable; money-moving verdict held');
  assert.equal(HELD_WHY, hold.why);
  assert.equal(hold.codeVerdict.verdict, 'MERCHANT');
  assert.equal(log.findLast((e) => e.step === 'verdict').verdict.verdict, 'MERCHANT');
});

test('no flagger answer + AGENT: held, with no PayPal call (no key, FLAGGER=off or an error)', async () => {
  for (const flag of [() => null, broken]) {
    for (const execute of [true, false]) {
      const { out, posts } = await resolveWith(CLEAN, { reason: 'INCORRECT_AMOUNT', flag, execute });
      assert.equal(out.status, 'held', `execute ${execute}`);
      assert.deepEqual([out.result.verdict.verdict, out.result.verdict.rule, out.result.plan.action], ['AGENT', 5, 'accept-claim-partial']);
      assert.equal(out.result.plan.heldWithoutFlagger, true);
      assert.equal(posts.length, 0);
    }
  }
});

test('no flagger answer + USER: the evidence is still sent, since it moves no money', async () => {
  const { out, posts, log } = await resolveWith(HONEST, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', flag: () => null, links: ['provide_evidence'] });
  assert.equal(out.status, 'executed');
  assert.deepEqual([out.result.verdict.verdict, out.result.plan.action], ['USER', 'provide-evidence']);
  assert.equal(out.result.plan.heldWithoutFlagger, undefined);
  assert.deepEqual(posts.map((c) => c.path), ['/v1/customer/disputes/PP-D-FLAG/provide-evidence']);
  assert.equal(log.some((e) => e.step === 'hold'), false);
});

test('with a flagger answer, AGENT and MERCHANT execute as before', async () => {
  const merchant = await resolveWith(MERCHANT_LIE, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', flag: async () => answer });
  assert.equal(merchant.out.status, 'executed');
  assert.deepEqual(merchant.posts.map((c) => c.json.accept_claim_type), ['REFUND']);
  const agent = await resolveWith(CLEAN, { reason: 'INCORRECT_AMOUNT', flag: async () => answer });
  assert.equal(agent.out.status, 'executed');
  assert.deepEqual(agent.posts.map((c) => c.path), ['/v1/customer/disputes/PP-D-FLAG/accept-claim']);
  assert.equal(agent.posts[0].json.refund_amount.value, '90.00');
  assert.equal(agent.log.some((e) => e.step === 'hold'), false);
});

test('a failed flagger run is not cached: the next run asks again and, with an answer, proceeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-flag-'));
  try {
    const record = fixture(MERCHANT_LIE);
    store(root, record);
    const { client, calls } = fakePayPal(record, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', orderCreatedAt: orderTime(record) });
    let asked = 0;
    const first = await resolveDispute('PP-D-FLAG', { root, execute: true, client, flag: async () => { asked++; throw new Error('flagger down'); } });
    assert.equal(first.status, 'held');
    const second = await resolveDispute('PP-D-FLAG', { root, execute: true, client, flag: async () => { asked++; return answer; } });
    assert.equal(asked, 2);
    assert.equal(second.status, 'executed');
    assert.equal(second.result.verdict.verdict, 'MERCHANT');
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.json.accept_claim_type), ['REFUND']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
