// Where the money stands on a dispute, kept apart from the verdict: what Black Box has done and
// what PayPal has confirmed. No imports, so the case page, the explorer and the replay all read it.
// p is the PayPal side of a case (paypalFromLog, or a committed
// .paypal.json); verdict is the case's verdict. Pure: it reads only p.
//   state 'open'               nothing sent to PayPal (a person decides, or not yet)
//         'unknown'            an action or payout was sent and its outcome is not known
//         'refund-pending'     Black Box accepted the claim or offered a refund; PayPal has not
//                              yet shown the buyer credited
//         'repayment-pending'  the buyer was refunded; the shopping app's repayment to the shop
//                              is not yet SUCCESS
//         'repayment-failed'   PayPal failed the repayment item; nothing was paid to the shop
//         'settled'            everything Black Box owed is done (for USER: the evidence is sent,
//                              and PayPal decides)
//   buyer:    'done' | 'pending' | null          the buyer's refund
//   merchant: 'done' | 'pending' | 'failed' | null  the shopping app's repayment (AGENT only)
// Amounts are sandbox money; text says so.
export function settlement(p, verdict) {
  if (!p || /^BENCH-/.test(p.disputeId ?? '')) return null;
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;
  const credit = (p.after?.moneyMovements ?? []).find((m) => m.party === 'BUYER' && m.type === 'CREDIT');
  const action = p.executed?.action ?? '';
  const refunds = /^(accept-claim|make-offer)/.test(action);
  const buyer = credit ? 'done' : refunds ? 'pending' : null;
  const owed = verdict === 'AGENT' && buyer !== null;
  const item = p.payout?.itemStatus ?? null;
  const merchant = !owed ? null
    : p.payoutState === 'succeeded' || item === 'SUCCESS' ? 'done'
      : p.payoutState === 'failed' ? 'failed'
        : 'pending';
  const repaid = p.payout?.amount?.cents;
  const out = (state, text) => ({ state, buyer, merchant, text });
  if (p.unknown?.length || p.payoutState === 'unknown') return out('unknown', 'Outcome unknown: a person checks PayPal before anything more is sent');
  if (!p.executed) return out('open', 'Not settled: nothing sent to PayPal');
  if (/^provide-evidence/.test(action)) return out('settled', 'Evidence sent, no money moves: PayPal decides the dispute');
  if (buyer === 'pending') return out('refund-pending', 'Buyer refund pending: PayPal has not yet shown the buyer credited');
  const refunded = `${fmt(credit.amount.cents)} refunded to the buyer (sandbox)`;
  if (merchant === 'failed') return out('repayment-failed', `${refunded}; the repayment to the shop failed, nothing was paid`);
  if (merchant === 'pending') return out('repayment-pending', `${refunded}; the shopping app's repayment to the shop is pending`);
  return out('settled', `Fully settled: ${refunded}${merchant === 'done' ? `; ${fmt(repaid)} repaid to the shop by the shopping app (sandbox)` : ''}`);
}
