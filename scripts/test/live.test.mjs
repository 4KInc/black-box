import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureStatus, preflight } from '../live.mjs';

const ok = async () => 'ok';
const ENV = { ANTHROPIC_API_KEY: 'k', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' };

test('preflight passes only with a working Anthropic key, a PayPal token and the flagger on', async () => {
  assert.deepEqual(await preflight({ env: ENV, askModel: ok, paypalToken: ok }), []);
  const missing = await preflight({ env: {}, askModel: ok, paypalToken: ok });
  assert.equal(missing.length, 2);
  assert.match(missing[0], /ANTHROPIC_API_KEY is not set.*HELD/);
  assert.match(missing[1], /PAYPAL_CLIENT_ID/);
  const broken = await preflight({ env: { ...ENV, FLAGGER: 'off' }, askModel: async () => { throw new Error('401 invalid x-api-key'); }, paypalToken: async () => { throw new Error('invalid_client'); } });
  assert.deepEqual(broken.map((p) => p.split(' ').slice(0, 3).join(' ')), ['the Anthropic key', 'FLAGGER=off: MERCHANT cases', 'the PayPal sandbox']);
});

test('captureStatus reads the disputed capture', async () => {
  const client = { paypal: async (_, path) => (path.startsWith('/v1/')
    ? { ok: true, data: { status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' }, disputed_transactions: [{ seller_transaction_id: 'CAP1' }] } }
    : { ok: true, data: { status: 'REFUNDED' } }) };
  assert.deepEqual(await captureStatus('PP-D-1', { client }), { captureId: 'CAP1', status: 'REFUNDED', disputeStatus: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR' });
});
