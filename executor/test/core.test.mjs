import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAcceptance } from '../core.mjs';

test('a claim for only the overage is accepted in full, for the planned amount', () => {
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 9000), { type: 'REFUND', refundCents: 9000 });
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 24000), { type: 'PARTIAL_REFUND', refundCents: 9000 });
  assert.deepEqual(claimAcceptance({ action: 'accept-claim', refundCents: 24000 }, 24000), { type: 'REFUND', refundCents: 24000 });
  // Never more than the buyer disputed.
  assert.deepEqual(claimAcceptance({ action: 'accept-claim-partial', refundCents: 9000 }, 5000), { type: 'REFUND', refundCents: 5000 });
});
