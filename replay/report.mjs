// The case report as a PDF, for a PayPal dispute reviewer: the verdict and why, what PayPal did,
// what the buyer allowed, what was bought, what the agent read and decided, every check, and how
// to verify the record. Made from the same judgment as the case page (replay/cases.mjs judge), so
// the two always agree; deterministic, so the same record always gives the same file.
import { FACT_KEYS, VERDICT } from '../engine/verdict.mjs';
import { statementsFor } from '../evidence/evidence.mjs';
import { PdfDoc } from '../lib/pdf.mjs';
import { FACT, label, methodPlain, RULE_SHORT, WHO } from './page.mjs';

const money = (c) => (Number.isInteger(c) ? `$${(c / 100).toFixed(2)}` : '–');
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC') : '–');
const yes = (b) => (b ? 'yes' : 'no');
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const COLORS = {
  [VERDICT.MERCHANT]: ['#fde7dc', '#7a2a05'],
  [VERDICT.AGENT]: ['#fdf1d6', '#6b4a00'],
  [VERDICT.USER]: ['#e3f3e6', '#1d5a2b'],
  [VERDICT.HUMAN]: ['#e7e9f2', '#2b3462'],
};
const ACTION_PLAIN = {
  'accept-claim': 'Accept the buyer’s claim: full refund from the merchant',
  'accept-claim-partial': 'Accept the claim in part: refund the amount over the limit',
  'make-offer': 'Offer the buyer a partial refund of the amount over the limit',
  'provide-evidence': 'Defend the purchase with evidence',
  none: 'No automatic action',
};

export const reportName = (c) => `black-box-${c.paypal?.disputeId ?? c.hash.slice(0, 12)}.pdf`;

// c = a case (hash, record, paypal); j = judge(c). caseUrl: where the case page lives, if public.
export function caseReport(c, j, { caseUrl = null } = {}) {
  const r = c.record;
  const p = c.paypal;
  // A bench case without a live dispute carries a stand-in one (BENCH-<id>): say it is simulated.
  const simulated = /^BENCH-/.test(p?.disputeId ?? '');
  const doc = new PdfDoc({ title: `Black Box case report ${p?.disputeId ?? c.hash.slice(0, 12)}`, footer: () => `Black Box case report · record ${c.hash.slice(0, 16)}…` });

  doc.text('BLACK BOX · FLIGHT RECORDER FOR AI SHOPPING AGENTS', { font: 'bold', size: 8, color: '#b4530d' });
  doc.text(simulated ? `Case report for bench case ${p.disputeId.slice(6)} (simulated dispute)` : p?.disputeId ? `Case report for PayPal dispute ${p.disputeId}` : 'Case report', { font: 'bold', size: 20, leading: 28 });
  doc.text('For the PayPal dispute reviewer. An AI shopping agent made this purchase for the buyer. This report is made from the agent’s sealed record, whose fingerprint is stored in the PayPal order, by fixed rules written as code. Anyone with the record can re-run the rules and get the same result.', { size: 9.5, color: '#444444' });
  doc.space(10);

  // Decline: the agent bought nothing, so there is no order or dispute to report on.
  if (!j) {
    doc.box('The agent bought nothing', `${r.decisions?.at(-1)?.model ?? 'The agent'}: “${r.decisions?.at(-1)?.reason ?? ''}”`);
    return doc.bytes();
  }

  const v = j.verdict;
  const [fill, ink] = COLORS[v.verdict];
  const plan = j.plan;
  doc.box(`${label(v.verdict)} · rule ${v.rule} · ${WHO[v.verdict]}`,
    `${RULE_SHORT[v.rule]} ${v.why}\n\nAction: ${plan.action === 'none' ? plan.note : `${ACTION_PLAIN[plan.action] ?? plan.action}${plan.refundCents ? `, ${money(plan.refundCents)}` : ''}. ${plan.note ?? ''}`}`,
    { fill, color: ink });

  section(doc, '1', 'The dispute');
  if (simulated) {
    doc.text(`A test case from the Black Box bench, not a live PayPal dispute: the dispute (${p.reason}, ${money(p.captured?.cents)} captured) is simulated.`, { size: 9.5 });
  } else if (p) {
    const out = p.after?.outcome;
    doc.rows([
      ['Dispute', `${p.disputeId}, ${p.reason}, filed ${when(p.filedAt)}`],
      ['PayPal order', `${p.orderId ?? '–'}, created ${when(p.orderCreatedAt)}`],
      ['Capture', `${p.captureId ?? '–'}, ${money(p.captured?.cents)} ${p.captured?.currency ?? ''}`],
      ['Buyer (payer ID)', p.payerId ?? '–'],
      ['Merchant (payee ID)', p.payeeMerchantId ?? '–'],
      ['Black Box acted', p.executed ? `${p.executed.action}, HTTP ${p.executed.httpStatus}, ${when(p.executed.at)}${p.trigger ? `, on ${p.trigger}` : ''}` : 'Nothing sent to PayPal'],
      ...(p.escalated ? [['Escalated', `inquiry escalated to a claim, ${when(p.escalated.at)}`]] : []),
      ...(p.payout ? [['Operator payout', `${money(p.payout.amount?.cents)} from the agent operator to the merchant, batch ${p.payout.batchId ?? '–'}, ${p.payout.status ?? ''}`]] : []),
      ['PayPal right after', out ? `${out.outcome_code ?? ''} ${out.outcome_reason ?? ''}`.trim() : `${p.after?.status ?? '–'}${p.after?.moneyMovements?.length ? `; ${p.after.moneyMovements.filter((m) => m.reason === 'DISPUTE_SETTLEMENT').map((m) => `${m.party.toLowerCase()} ${m.type.toLowerCase()} ${money(m.amount?.cents)}`).join(', ')}` : ''}`],
    ]);
  } else {
    doc.text(`No PayPal dispute is attached to this recording. This is the verdict if the buyer disputes it as ${j.reason}.`, { size: 9.5 });
  }

  section(doc, '2', 'What the buyer allowed');
  const m = r.mandate;
  const a = m.item?.attributes ?? {};
  doc.rows([
    ['Mandate', `${[a.color, m.item?.category].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}, total at most ${money(m.maxTotalCents)} ${m.currency}${m.signedShopsOnly ? ', from shops that sign their pages' : ''}`],
    ...(m.notBefore || m.notAfter ? [['Valid', `${when(m.notBefore)} to ${when(m.notAfter)}`]] : []),
    ['Approval', j.mandateAuth?.ok ? (j.mandateAuth.legacy ? `Not passkey-signed: ${j.mandateAuth.reason}` : 'Approved with the passkey the paying PayPal account enrolled; the signature covers this exact mandate') : `NOT VALID: ${j.mandateAuth?.reason ?? 'no approval'}`],
    ...(j.buyerRequest ? [['Buyer’s own words', `“${clip(j.buyerRequest.text, 600)}”${j.buyerRequest.exceeds ? ` — asked for more than the mandate: ${j.buyerRequest.why.join('; ')}` : ''}`]] : []),
  ]);

  section(doc, '3', 'What the agent bought');
  const prod = j.product;
  const over = j.order.capturedCents - m.maxTotalCents;
  doc.rows([
    ['Item', prod ? `${prod.name} (SKU ${prod.sku})${Object.values(prod.attributes ?? {}).filter(Boolean).length ? `, ${Object.entries(prod.attributes).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(', ')}` : ''}` : r.purchase.sku],
    ['Signed price', prod ? `${money(prod.priceCents)} ${prod.currency ?? ''} on the merchant’s signed product page` : '–'],
    ['Charged', `${money(j.order.capturedCents)}${over > 0 ? `, ${money(over)} over the limit` : ', within the limit'}`],
    ['Mandate', j.mandate.broken ? `BROKEN: ${j.mandate.violations.map((x) => (x.code === 'OVER_CAP' ? `charged ${money(j.order.capturedCents)}, over the ${money(m.maxTotalCents)} limit by ${money(over)}` : x.detail)).join('; ')}` : 'kept'],
  ]);

  section(doc, '4', 'What the agent read that people could not see');
  // The texts that decide the case first: those that contradict the listing and reached the model.
  const weight = (f) => (f.contradictsListing && f.inModelInput ? 0 : f.inModelInput ? 1 : 2);
  const hidden = j.findings.filter((f) => f.namesPurchasedItem || f.inModelInput).sort((x, y) => weight(x) - weight(y));
  if (!hidden.length) doc.text('Nothing hidden on the purchased page named this item or reached the agent.', { size: 9.5 });
  for (const f of hidden.slice(0, 6)) {
    doc.text(`Hidden ${methodPlain(f.method)} (${f.channel})`, { font: 'bold', size: 9.5 });
    doc.text(`“${clip(f.text.replace(/\s+/g, ' '), 700)}”`, { size: 9, indent: 12, color: '#333333' });
    doc.text(`Names this item: ${yes(f.namesPurchasedItem)} · contradicts the signed listing: ${yes(f.contradictsListing)} · reached the model: ${yes(f.inModelInput)} · the merchant’s own signed text: ${yes(f.signedByMerchant && f.selfContained && !f.thirdPartySigned)}${f.thirdPartyIssuer ? ` (signed by ${f.thirdPartyIssuer})` : ''}`, { size: 8.5, indent: 12, color: '#555555' });
    doc.space(4);
  }
  if (hidden.length > 6) doc.text(`${hidden.length - 6} more in the record.`, { size: 9, color: '#555555' });
  const flagged = j.flaggedPassages ?? [];
  if (flagged.length) {
    doc.text(`The AI flagger (${j.flagger?.model ?? 'AI'}) also quoted text aimed at AI shoppers; a quote counts only if it names the item bought, and can only send the case to a person:`, { size: 9, color: '#444444' });
    for (const q of flagged.slice(0, 3)) doc.text(`“${clip(q.quote, 400)}” — names this item: ${yes(q.namesPurchasedItem)}`, { size: 8.5, indent: 12, color: '#555555' });
  }

  section(doc, '5', 'What the agent decided');
  const d = (r.decisions ?? []).findLast((x) => x.action === 'buy') ?? r.decisions?.at(-1);
  doc.rows([
    ['Model', d?.model ?? '–'],
    ['Its reason', d?.reason ? `“${clip(d.reason, 600)}”` : '–'],
    ['Pages read', `${r.fetches.length}, ${r.fetches.every((f) => f.verification?.ok) ? 'all' : 'not all'} validly signed by the shop`],
  ]);

  section(doc, '6', `The ${FACT_KEYS.length} checks behind the verdict`);
  doc.rows(FACT_KEYS.map((k) => [FACT[k]?.[0] ?? k, `${j.facts[k] ? 'TRUE' : 'false'} \u2014 ${FACT[k]?.[1] ?? ''}`]), { labelWidth: 130, size: 8.5 });

  section(doc, '7', 'Has the record been changed?');
  const same = j.facts.hashesMatch;
  doc.text(same
    ? 'No. The record’s SHA-256 fingerprint equals the custom_id PayPal stored on the order at checkout, which cannot change after payment, and every stored page still matches its own fingerprint.'
    : 'The record’s fingerprint does not match the one in the PayPal order: it was changed, or it belongs to a different payment. It cannot support any verdict.', { size: 9.5 });
  doc.rows([
    ['Record SHA-256', c.hash, { font: 'mono' }],
    ['PayPal custom_id', j.order.customId ?? '–', { font: 'mono' }],
    ...(j.integrityProblems?.length ? [['Problems', j.integrityProblems.join('; ')]] : []),
  ], { size: 8.5 });

  const statements = statementsFor({ record: r, j, hash: c.hash, reason: j.reason });
  if (statements) {
    section(doc, '8', 'Statements for the evidence');
    for (const s of statements) doc.text(`• ${s}`, { size: 9, indent: 6 });
  }

  section(doc, statements ? '9' : '8', 'How to check this yourself');
  doc.text(`${caseUrl ? `The case, with the pages exactly as the agent and a person saw them, is at ${caseUrl}. ` : ''}Download the record (JSON) there, compute its SHA-256 over the canonical JSON and compare it with the order’s custom_id. The rules are deterministic code: given the same record and PayPal order data, they give the same verdict for the buyer, the merchant or PayPal. Black Box proposes this responsibility policy; it is not PayPal’s current policy.`, { size: 9, color: '#444444' });
  return doc.bytes();
}

function section(doc, n, title) {
  doc.space(6);
  doc.need(60);
  doc.rule();
  doc.text(`${n}  ${title.toUpperCase()}`, { font: 'bold', size: 11, color: '#b4530d', leading: 16 });
  doc.space(2);
}
