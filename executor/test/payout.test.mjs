import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payoutDue, reimburse } from '../payout.mjs';
import { executionLog } from '../core.mjs';

const dispute = { step: 'get dispute', status: 200, response: { disputed_transactions: [{ seller: { merchant_id: 'MERCH1' } }] } };
const verdict = (payout) => ({ step: 'verdict', plan: payout ? { action: 'accept-claim-partial', refundCents: 9000, payout: { to: 'merchant', from: 'agent-operator', amountCents: 9000 } } : { action: 'accept-claim' } });
const refund = (status) => ({ step: 'accept-claim REFUND', status, request: { refund_amount: { currency_code: 'USD', value: '90.00' } } });

test('a payout is due only after an AGENT verdict whose refund PayPal accepted, and only once', () => {
  assert.deepEqual(payoutDue([dispute, verdict(true), refund(200)]), { amountCents: 9000, currency: 'USD', merchantId: 'MERCH1' });
  assert.match(payoutDue([dispute, verdict(false), refund(200)]).why, /no payout/);
  assert.match(payoutDue([dispute, verdict(true), refund(400)]).why, /not been refunded/);
  assert.match(payoutDue([dispute, verdict(true), refund(200), { step: 'payout', status: 201 }]).why, /already paid/);
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
