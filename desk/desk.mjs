// The evidence desk's decision, made by code from facts with sources (sources.mjs). For a dispute
// the responsibility engine does not take (an ordinary order, or a reason such as "not received"),
// it answers one question: does the evidence on hand prove what this dispute reason needs?
//
//   send     every requirement is met: the package below goes to PayPal (on approval)
//   missing  something is not shown by any source: the page lists what to add; nothing is sent
//   concede  a source shows the defence is wrong (returned to sender, no refund on this payment):
//            the desk recommends accepting the claim and sends nothing
//   person   out of scope, or two sources disagree: a person decides
//
// It never fills a gap. Delivery is proven only by the carrier's own message, quoted: PayPal's
// tracker status is whatever the merchant set (SHIPPED), and the merchant's own export says what
// the merchant believes. Both are shown, neither proves delivery.

import { carrierIn, compact, sameTracking, samePostcode } from './sources.mjs';

export const DESK_REASONS = Object.freeze(['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'CREDIT_NOT_PROCESSED', 'DUPLICATE_TRANSACTION']);
export const DECISION = Object.freeze({ SEND: 'send', MISSING: 'missing', CONCEDE: 'concede', PERSON: 'person' });
export const REASON_TEXT = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'item not received',
  CREDIT_NOT_PROCESSED: 'refund not received',
  DUPLICATE_TRANSACTION: 'charged twice',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'not as described',
  UNAUTHORISED: 'unauthorised',
  INCORRECT_AMOUNT: 'incorrect amount',
};

const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const PAYPAL_CARRIERS = new Set(['UPS', 'USPS', 'FEDEX', 'DHL']);
const CARRIER_NAME = { UPS: 'UPS', USPS: 'USPS', FEDEX: 'FedEx', DHL: 'DHL' };
const carrierName = (c) => CARRIER_NAME[c] ?? c;

// pp = paypalFacts(); facts = grounded facts from records and documents; instructions = [{ doc, quote }].
export function decide(pp, facts = [], { instructions = [] } = {}) {
  const checks = [];
  const check = (id, label, state, detail, sources = []) => { checks.push({ id, label, state, detail, sources }); return state; };
  const of = (key, kinds) => facts.filter((f) => f.key === key && (!kinds || kinds.includes(f.source.kind)));
  const paypal = (what) => ({ key: 'paypal', value: what, quote: null, source: { kind: 'paypal', name: 'PayPal' } });
  const out = (decision, why, rest = {}) => ({ decision, why, reason: pp.reason, checks, flagged: instructions, evidence: null, statements: null, concede: null, ...rest });

  if (!DESK_REASONS.includes(pp.reason)) {
    check('reason', 'A reason the desk answers', 'missing', `PayPal's reason is ${REASON_TEXT[pp.reason] ?? pp.reason ?? 'unknown'}, which needs a person's judgement.`);
    return out(DECISION.PERSON, `The desk does not answer "${REASON_TEXT[pp.reason] ?? pp.reason}" disputes: a person decides.`);
  }

  // A refund on this very payment that covers the dispute answers any of the three reasons.
  const completed = pp.refunds.filter((r) => r.status === 'COMPLETED');
  const refunded = completed.reduce((s, r) => s + r.cents, 0);
  const pending = pp.refunds.filter((r) => r.status === 'PENDING');
  const claimed = of('refund_id');
  const strays = claimed.filter((f) => !pp.refunds.some((r) => r.id === f.value));
  for (const f of strays) check(`refund-${f.value}`, `Refund ${f.value}`, 'info', `${f.source.name} names refund ${f.value}, but PayPal shows no such refund on this payment.`, [f]);

  if (refunded > 0 && refunded >= pp.disputedCents) {
    check('refund', 'A refund on this payment covers the dispute', 'met', `PayPal shows ${completed.map((r) => `${r.id} (${fmt(r.cents)})`).join(', ')}, completed, on payment ${pp.captureId}: ${fmt(refunded)} of the ${fmt(pp.disputedCents)} disputed.`, [paypal('refunds')]);
    requested('PROOF_OF_REFUND');
    const statements = [
      `The disputed payment is PayPal capture ${pp.captureId}, for ${fmt(pp.disputedCents)}.`,
      ...completed.map((r) => `PayPal shows refund ${r.id} on this payment: ${fmt(r.cents)}, status COMPLETED${r.at ? `, made ${String(r.at).slice(0, 10)}` : ''}.`),
      `Together the refunds come to ${fmt(refunded)}, which covers the ${fmt(pp.disputedCents)} in dispute.`,
      'Every fact above was read from PayPal\'s own records for this payment.',
    ];
    return out(DECISION.SEND, `PayPal itself shows this payment refunded: ${fmt(refunded)}.`, {
      evidence: { evidence_type: 'PROOF_OF_REFUND', evidence_info: { refund_ids: completed.map((r) => r.id) } },
      statements,
    });
  }

  if (pp.reason === 'CREDIT_NOT_PROCESSED' || pp.reason === 'DUPLICATE_TRANSACTION') {
    if (pending.length) {
      check('refund', 'A refund on this payment covers the dispute', 'missing', `PayPal shows ${pending.map((r) => `${r.id} (${fmt(r.cents)})`).join(', ')} still pending. Check again once it completes.`, [paypal('refunds')]);
      return out(DECISION.MISSING, 'A refund is pending at PayPal: nothing is sent until it completes.');
    }
    if (pp.reason === 'DUPLICATE_TRANSACTION') {
      check('refund', 'A refund on this payment', 'missing', refunded ? `PayPal shows ${fmt(refunded)} refunded of ${fmt(pp.disputedCents)}.` : 'PayPal shows no refund on this payment.', [paypal('refunds')]);
      return out(DECISION.PERSON, 'Telling two charges apart needs a person: the desk only answers a duplicate that was refunded.');
    }
    const owed = pp.disputedCents - refunded;
    check('refund', 'A refund on this payment covers the dispute', 'against', refunded ? `PayPal shows only ${fmt(refunded)} refunded (${completed.map((r) => r.id).join(', ')}); ${fmt(owed)} of the ${fmt(pp.disputedCents)} was not.` : 'PayPal shows no refund on this payment.', [paypal('refunds'), ...strays]);
    return out(DECISION.CONCEDE, refunded ? `Only ${fmt(refunded)} was refunded: the desk recommends refunding the other ${fmt(owed)}.` : 'PayPal shows no refund on this payment, whatever a document says: the desk recommends accepting the claim.', { concede: { refundCents: owed } });
  }

  // Item not received: a tracked shipment, delivered by the carrier to the order's address.
  const trackers = pp.trackers.filter((t) => t.status !== 'CANCELLED' && t.number);
  const numbers = [...new Map([...of('tracking_number').map((f) => [compact(f.value), f]), ...trackers.map((t) => [t.number, paypal(`tracker ${t.id}`)])]).entries()];
  let tracking = null;
  if (!numbers.length) check('tracking', 'A tracking number', 'missing', 'No source gives a tracking number. Add the shipping confirmation or the carrier\'s email.');
  else if (numbers.length > 1) check('tracking', 'A tracking number', 'conflict', `The sources give different tracking numbers: ${numbers.map(([n]) => n).join(', ')}.`, numbers.map(([, f]) => f));
  else {
    tracking = numbers[0][0];
    check('tracking', 'A tracking number', 'met', tracking, [...of('tracking_number').filter((f) => sameTracking(f.value, tracking)), ...(trackers.length ? [paypal('tracker')] : [])]);
  }
  if (tracking) check('registered', 'Registered with PayPal', trackers.some((t) => t.number === tracking) ? 'met' : 'info',
    trackers.some((t) => t.number === tracking) ? `PayPal has tracker ${trackers.find((t) => t.number === tracking).id} on this payment (status ${trackers.find((t) => t.number === tracking).status}, which the merchant sets).` : 'Not added to the PayPal order. Optional: the evidence carries the number anyway.');

  const carriers = [...new Set(of('carrier').map((f) => carrierIn(f.value) ?? String(f.value)))];
  let carrier = null;
  if (!carriers.length) check('carrier', 'The carrier', 'missing', 'No source names the carrier.');
  else if (carriers.length > 1) check('carrier', 'The carrier', 'conflict', `The sources name different carriers: ${carriers.join(', ')}.`, of('carrier'));
  else { carrier = carriers[0]; check('carrier', 'The carrier', 'met', carrierName(carrier), of('carrier')); }

  // Delivery, from the carrier's message only. A document about another parcel does not count.
  const aboutParcel = (f) => !tracking || !of('tracking_number', ['document']).some((t) => t.source.name === f.source.name) || of('tracking_number', ['document']).some((t) => t.source.name === f.source.name && sameTracking(t.value, tracking));
  const docStatus = of('delivery_status', ['document']).filter(aboutParcel);
  const otherParcel = of('delivery_status', ['document']).filter((f) => !aboutParcel(f));
  const has = (s) => docStatus.filter((f) => f.value === s);
  const own = of('delivery_status', ['records']).filter((f) => f.value === 'DELIVERED');
  let delivered = false;
  if (otherParcel.length) check('parcel', 'The message is about this parcel', 'conflict', `${otherParcel.map((f) => f.source.name).join(', ')} gives a different tracking number from ${tracking}.`, otherParcel);
  if (has('DELIVERED').length && has('RETURNED').length) check('delivered', 'Delivered, says the carrier', 'conflict', 'One message says delivered, another says returned to sender.', [...has('DELIVERED'), ...has('RETURNED')]);
  else if (has('RETURNED').length) check('delivered', 'Delivered, says the carrier', 'against', 'The carrier\'s message says the parcel went back to the sender.', has('RETURNED'));
  else if (has('DELIVERED').length) { delivered = true; check('delivered', 'Delivered, says the carrier', 'met', 'The carrier\'s message says delivered.', [...has('DELIVERED'), ...has('EXCEPTION')]); }
  else if (has('EXCEPTION').length) check('delivered', 'Delivered, says the carrier', 'against', 'The carrier\'s message says the delivery failed.', has('EXCEPTION'));
  else if (has('IN_TRANSIT').length) check('delivered', 'Delivered, says the carrier', 'missing', 'The messages only show the parcel on its way. Add the carrier\'s delivery confirmation.', has('IN_TRANSIT'));
  else if (own.length) check('delivered', 'Delivered, says the carrier', 'missing', 'Only your own records say delivered. That is what you believe, not proof: add the carrier\'s delivery confirmation.', own);
  else check('delivered', 'Delivered, says the carrier', 'missing', 'No carrier message shows delivery. Add the carrier\'s delivery confirmation.');

  const deliveredDocs = new Set(has('DELIVERED').map((f) => f.source.name));
  const postcodes = of('delivery_postcode', ['document']).filter((f) => deliveredDocs.has(f.source.name) || !deliveredDocs.size);
  const shipTo = pp.shipTo?.postcode ?? null;
  if (!shipTo) check('address', 'Delivered to the order\'s address', 'missing', 'PayPal has no shipping address on this order, so delivery to the buyer cannot be checked.');
  else if (!postcodes.length) check('address', 'Delivered to the order\'s address', 'missing', `The order ships to postcode ${shipTo}, but no carrier message gives the delivery postcode.`, [paypal('shipping address')]);
  else if (postcodes.some((f) => !samePostcode(f.value, shipTo))) check('address', 'Delivered to the order\'s address', 'conflict', `The carrier delivered to ${postcodes.map((f) => f.value).join(', ')}, but the order ships to ${shipTo}.`, [paypal('shipping address'), ...postcodes]);
  else check('address', 'Delivered to the order\'s address', 'met', `Postcode ${shipTo}, as on the PayPal order.`, [paypal('shipping address'), ...postcodes]);

  const deliveredAt = of('delivered_at', ['document']).filter((f) => deliveredDocs.has(f.source.name)).map((f) => f.value).sort()[0] ?? null;
  const early = [...of('shipped_at'), ...of('delivered_at')].filter((f) => pp.orderedAt && f.value < pp.orderedAt);
  if (early.length) check('dates', 'After the order was placed', 'conflict', `${early.map((f) => `${f.key === 'shipped_at' ? 'Shipped' : 'Delivered'} ${f.value}`).join(', ')}, before the order on ${pp.orderedAt}.`, early);
  else if (deliveredAt) check('dates', 'After the order was placed', 'met', `Ordered ${pp.orderedAt}, delivered ${deliveredAt}.`, of('delivered_at').filter((f) => f.value === deliveredAt));

  requested('PROOF_OF_FULFILLMENT');
  const state = (s) => checks.some((c) => c.state === s);
  if (state('conflict')) return out(DECISION.PERSON, 'The sources disagree, so a person decides. Nothing is sent.');
  if (state('against')) return out(DECISION.CONCEDE, has('RETURNED').length ? 'The carrier says the parcel was returned to you: the desk recommends refunding the buyer.' : 'The carrier says the delivery failed: the desk recommends refunding the buyer.', { concede: { refundCents: pp.disputedCents } });
  if (state('missing')) return out(DECISION.MISSING, `Not proven yet: ${checks.filter((c) => c.state === 'missing').map((c) => c.label.toLowerCase()).join('; ')}. Nothing is sent.`);

  const quote = has('DELIVERED')[0];
  const statements = [
    `The disputed payment is PayPal capture ${pp.captureId}, for ${fmt(pp.disputedCents)}, on order ${pp.orderId} placed ${pp.orderedAt} for delivery to postcode ${shipTo}.`,
    `It was shipped with ${carrierName(carrier)}, tracking number ${tracking}${trackers.some((t) => t.number === tracking) ? ', which the merchant also added to this PayPal order' : ''}.`,
    `The carrier's message "${quote.source.name}" says: "${quote.quote}"`,
    `It shows the parcel delivered${deliveredAt ? ` on ${deliveredAt}` : ''} to postcode ${postcodes[0].value}, the shipping postcode on the PayPal order.`,
    'Each fact is read from PayPal or quoted word for word from the attached documents, which are attached in full.',
  ];
  return out(DECISION.SEND, `The carrier's own message shows delivery to the order's address${deliveredAt ? ` on ${deliveredAt}` : ''}.`, {
    evidence: { evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [PAYPAL_CARRIERS.has(carrier) ? { carrier_name: carrier, tracking_number: tracking } : { carrier_name: 'OTHER', carrier_name_other: String(carrier).slice(0, 64), tracking_number: tracking }] } },
    statements,
  });

  // What PayPal asked for, if it asked: shown, so a mismatch is visible before sending.
  function requested(type) {
    if (!pp.requested?.length) return;
    check('requested', 'What PayPal asked for', pp.requested.includes(type) ? 'met' : 'info', pp.requested.includes(type) ? `PayPal asked for ${type}.` : `PayPal asked for ${pp.requested.join(', ')}; the desk can show ${type}.`);
  }
}

export const NOTE_MAX = 1500;
export const deskNote = (statements) => statements.join(' ').slice(0, NOTE_MAX);

// The text file PayPal receives: the statements, then every document in full.
export function deskFile({ note, statements, docs }) {
  return [
    'BLACK BOX EVIDENCE DESK',
    '',
    note,
    '',
    'Established by code (every statement is read from PayPal or quoted from a document below):',
    ...statements.map((s, i) => `${i + 1}. ${s}`),
    '',
    ...docs.flatMap((d) => [`--- ${d.name} (sha256 ${d.hash}) ---`, d.text, '']),
  ].join('\n');
}
