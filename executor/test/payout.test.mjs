import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPayout, payoutDue, refreshPayout, reimburse } from '../payout.mjs';
import { paypalFromLog } from '../../replay/cases.mjs';
import { executionLog } from '../core.mjs';

const dispute = { step: 'get dispute', status: 200, response: { disputed_transactions: [{ seller: { merchant_id: 'MERCH1' } }] } };
const verdict = (payout) => ({ step: 'verdict', plan: payout ? { action: 'accept-claim-partial', refundCents: 9000, payout: { to: 'merchant', from: 'agent-operator', amountCents: 9000 } } : { action: 'accept-claim' } });
const refund = (status) => ({ step: 'accept-claim REFUND', status, request: { refund_amount: { currency_code: 'USD', value: '90.00' } } });

test('a payout is due only after an AGENT verdict whose refund PayPal accepted, and only once', () => {
  assert.deepEqual(payoutDue([dispute, verdict(true), refund(200)]), { amountCents: 9000, currency: 'USD', merchantId: 'MERCH1' });
  assert.match(payoutDue([dispute, verdict(false), refund(200)]).why, /no payout/);
  assert.match(payoutDue([dispute, verdict(true), refund(400)]).why, /not been refunded/);
  assert.match(payoutDue([dispute, verdict(true), refund(200), { step: 'payout', status: 201 }]).why, /already paid/);
  // A payout whose item PayPal failed paid nothing, so it is still due; a pending one is not.
  const sent = { step: 'payout', status: 201, response: { batch_header: { payout_batch_id: 'B1' } } };
  const looked = (item) => ({ step: 'get payout', status: 200, response: { batch_header: { payout_batch_id: 'B1' }, items: [{ transaction_status: item }] } });
  assert.equal(payoutDue([dispute, verdict(true), refund(200), sent, looked('FAILED')]).amountCents, 9000);
  assert.match(payoutDue([dispute, verdict(true), refund(200), sent, looked('PENDING')]).why, /already paid/);
  assert.match(payoutDue([dispute, verdict(true), refund(200), sent, looked('FAILED'), looked('SUCCESS')]).why, /already paid/);
});

test('after a failed payout is logged by --refresh, the next attempt gets its own lock and batch ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-payout-'));
  try {
    const log = executionLog(root, 'PP-D-902');
    for (const e of [dispute, verdict(true), refund(200)]) log.write(e);
    let item = 'PENDING';
    const posts = [];
    const client = { paypal: async (method, path, json) => {
      if (method === 'POST') { posts.push(json); return { ok: true, status: 201, data: { batch_header: { payout_batch_id: `B${posts.length}`, batch_status: 'PENDING' } } }; }
      const id = path.split('/').at(-1);
      return { ok: true, status: 200, data: { batch_header: { payout_batch_id: id, batch_status: 'PENDING' }, items: [{ payout_item_id: `I-${id}`, transaction_status: item }] } };
    } };
    assert.equal((await reimburse('PP-D-902', { root, client, execute: true })).status, 'executed');
    // Still pending: the lock holds and nothing more is sent.
    assert.equal((await reimburse('PP-D-902', { root, client, execute: true })).status, 'nothing-due');
    item = 'FAILED';
    assert.deepEqual(await refreshPayout('PP-D-902', { root, client }), { status: 'refreshed', batchId: 'B1', batchStatus: 'PENDING', itemStatus: 'FAILED' });
    assert.equal(paypalFromLog(log.read()).payout, null, 'a failed payout is not shown as the payout');
    assert.equal((await reimburse('PP-D-902', { root, client })).attempt, 2);
    item = 'SUCCESS';
    assert.equal((await reimburse('PP-D-902', { root, client, execute: true })).status, 'executed');
    assert.deepEqual(posts.map((p) => p.sender_batch_header.sender_batch_id), ['blackbox-PP-D-902', 'blackbox-PP-D-902-2']);
    assert.deepEqual([paypalFromLog(log.read()).payout.batchId, paypalFromLog(log.read()).payout.itemStatus], ['B2', 'SUCCESS']);
    assert.equal((await reimburse('PP-D-902', { root, client, execute: true })).status, 'nothing-due');
    assert.equal(posts.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reimburse pays the merchant by PayPal ID with the operator client, once, and logs it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-payout-'));
  try {
    const log = executionLog(root, 'PP-D-901');
    for (const e of [dispute, verdict(true), refund(200)]) log.write(e);
    const calls = [];
    const client = { paypal: async (method, path, json) => { calls.push({ method, path, json }); return method === 'POST'
      ? { ok: true, status: 201, data: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } }
      : { ok: true, status: 200, data: { batch_header: { payout_batch_id: 'B1', batch_status: 'SUCCESS' } } }; } };
    assert.equal((await reimburse('PP-D-901', { root, client })).status, 'planned');
    assert.equal(calls.length, 0, 'a dry run sends nothing');
    const out = await reimburse('PP-D-901', { root, client, execute: true });
    assert.equal(out.status, 'executed');
    const item = calls[0].json.items[0];
    assert.deepEqual([item.recipient_type, item.receiver, item.amount], ['PAYPAL_ID', 'MERCH1', { currency: 'USD', value: '90.00' }]);
    assert.equal(calls[0].json.sender_batch_header.sender_batch_id, 'blackbox-PP-D-901');
    assert.equal((await reimburse('PP-D-901', { root, client, execute: true })).status, 'nothing-due');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    assert.match(readFileSync(log.path, 'utf8'), /"step":"payout"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a logged payout is copied into the committed PayPal fixture, and nothing else changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-payout-'));
  try {
    const name = 'live-agent-partial-refund';
    const src = join(import.meta.dirname, '..', '..', 'fixtures', 'recorded', `${name}.paypal.json`);
    const original = JSON.parse(readFileSync(src, 'utf8'));
    mkdirSync(join(root, 'fixtures', 'recorded'), { recursive: true });
    writeFileSync(join(root, 'fixtures', 'recorded', `${name}.paypal.json`), JSON.stringify(original));
    const id = original.disputeId;
    assert.equal(exportPayout(root, id, name).status, 'no-payout');
    const log = executionLog(root, id);
    for (const e of [dispute, verdict(true), refund(200)]) log.write(e);
    const client = { paypal: async (method) => (method === 'POST'
      ? { ok: true, status: 201, data: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } }
      : { ok: true, status: 200, data: { batch_header: { payout_batch_id: 'B1', batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'I1', transaction_status: 'SUCCESS' }] } }) };
    await reimburse(id, { root, client, execute: true });
    const out = exportPayout(root, id, name);
    assert.equal(out.status, 'exported');
    const after = JSON.parse(readFileSync(out.path, 'utf8'));
    assert.deepEqual([after.payout.batchId, after.payout.status, after.payout.itemStatus, after.payout.amount.cents], ['B1', 'SUCCESS', 'SUCCESS', 9000]);
    const { payout, ...rest } = after;
    assert.deepEqual(rest, original);
    assert.throws(() => exportPayout(root, 'PP-D-OTHER', name), /not PP-D-OTHER/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
