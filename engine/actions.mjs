// Maps (verdict, PayPal dispute reason) to the one PayPal action Black Box may take.
// This only plans the action; the executor makes the API call and records the response.

import { VERDICT } from './verdict.mjs';

export const IN_SCOPE_REASONS = Object.freeze([
  'UNAUTHORISED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'INCORRECT_AMOUNT',
]);

export const toValue = (cents) => {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`bad amount in cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
};

const none = (note) => ({ action: 'none', note });
const evidence = (note) => ({ action: 'provide-evidence', note });

// ctx = { capturedCents, outOfScopeCents, mandateCapCents, signedPriceCents, currency }
export function planAction(verdict, reason, ctx) {
  if (!IN_SCOPE_REASONS.includes(reason)) {
    return none(`${reason} is out of scope; the normal PayPal process applies.`);
  }
  if (verdict === VERDICT.HUMAN) return none('No automatic action. Both sides get the replay.');

  if (verdict === VERDICT.USER) {
    return reason === 'UNAUTHORISED'
      ? evidence('Evidence offered to PayPal; PayPal runs its own investigation and seller protection.')
      : evidence('Evidence that the item matched the signed listing and the mandate.');
  }

  if (verdict === VERDICT.AGENT) {
    if (reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
      return none('An agent overreach is not an item-description problem. Escalated to a human.');
    }
    const refund = reason === 'INCORRECT_AMOUNT'
      ? Math.max(0, ctx.capturedCents - ctx.mandateCapCents)
      : ctx.outOfScopeCents;
    if (refund <= 0) return none('Nothing out of scope to refund. Escalated to a human.');
    return {
      action: reason === 'UNAUTHORISED' ? 'make-offer' : 'accept-claim-partial',
      refundCents: refund,
      payout: { to: 'merchant', from: 'agent-operator', amountCents: refund },
      note: 'Refund the out-of-scope amount; the agent operator reimburses the merchant via Payouts.',
    };
  }

  if (verdict === VERDICT.MERCHANT) {
    if (reason === 'INCORRECT_AMOUNT') {
      const diff = ctx.capturedCents - ctx.signedPriceCents;
      if (diff <= 0) return none('Captured amount equals the signed price. Escalated to a human.');
      return { action: 'accept-claim-partial', refundCents: diff, note: 'Refund the difference between the captured amount and the signed price.' };
    }
    return { action: 'accept-claim', refundCents: ctx.capturedCents, note: 'Merchant accepts the claim; its own signed page is the evidence.' };
  }

  throw new Error(`unknown verdict ${verdict}`);
}
