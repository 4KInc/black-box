// The case report as a PDF, for a PayPal dispute reviewer. Page 1 is the summary: who pays and
// why, the numbers that matter, and what happened in order. The pages after it are the evidence:
// the hidden text the agent read, its reasoning, every check, the dispute details and the record's
// fingerprint. Made from the same judgment as the case page (replay/cases.mjs judge), so the two
// always agree; deterministic, so the same record always gives the same file.
import { FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, VERDICT } from '../engine/verdict.mjs';
import { statementsFor } from '../evidence/evidence.mjs';
import { boxHeight, measure, PdfDoc } from '../lib/pdf.mjs';
import { FACT, methodPlain, modelName } from './page.mjs';

const money = (c) => (Number.isInteger(c) ? `$${(c / 100).toFixed(2)}` : '–');
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '').slice(0, 16) + ' UTC' : '–');
const clip = (s, k) => (String(s).length > k ? `${String(s).slice(0, k - 1)}…` : String(s));

const C = {
  ink: '#111827', ink2: '#374151', muted: '#6b7280', faint: '#9ca3af', rule: '#e5e7eb', panel: '#f6f7f9',
  dark: '#14161a', brand: '#e8641b', green: '#15803d', red: '#b91c1c', amber: '#b45309', off: '#d1d5db',
};
const THEME = {
  [VERDICT.MERCHANT]: { accent: '#c2410c', bg: '#fff3eb', who: 'The merchant pays' },
  [VERDICT.AGENT]: { accent: '#a16207', bg: '#fefae8', who: 'The agent’s operator pays' },
  [VERDICT.USER]: { accent: '#15803d', bg: '#ecf8f0', who: 'The purchase stands' },
  [VERDICT.HUMAN]: { accent: '#3949ab', bg: '#eef0fb', who: 'A person decides' },
};
const ACTION = {
  'accept-claim': 'Full refund from the merchant',
  'accept-claim-partial': 'Refund of the amount over the limit',
  'make-offer': 'Offer to refund the amount over the limit',
  'provide-evidence': 'Defend the purchase with evidence',
  none: 'No automatic action',
};
const VERDICT_WORD = { [VERDICT.MERCHANT]: 'MERCHANT', [VERDICT.AGENT]: 'AGENT', [VERDICT.USER]: 'USER', [VERDICT.HUMAN]: 'NEEDS A HUMAN' };

export const reportName = (c) => `black-box-${c.paypal?.disputeId ?? c.hash.slice(0, 12)}.pdf`;

// c = a case (hash, record, paypal); j = judge(c). caseUrl: where the case page lives, if public.
export function caseReport(c, j, { caseUrl = null } = {}) {
  const r = c.record;
  const p = c.paypal;
  const simulated = /^BENCH-/.test(p?.disputeId ?? '');
  const live = p && !simulated;
  const id = live ? p.disputeId : simulated ? `bench case ${p.disputeId.slice(6)}` : `record ${c.hash.slice(0, 12)}`;
  const doc = new PdfDoc({
    title: `Black Box case report · ${id}`,
    footer: () => `Black Box · case report for ${id} · record ${c.hash.slice(0, 16)}…`,
    // Pages after the first carry a slim header.
    onPage: (d, page) => {
      if (page === 1) return;
      d.textAt(d.left, 34, 'BLACK BOX', { font: 'bold', size: 7.5, color: C.brand, tracking: 1.2 });
      d.textAt(d.left + d.width, 34, `CASE REPORT · ${id.toUpperCase()}`, { font: 'bold', size: 7.5, color: C.muted, tracking: 0.8, align: 'right' });
      d.line(d.left, 42, d.left + d.width, 42, { color: C.rule });
      d.y = 60;
    },
  });

  header(doc, live ? `Dispute ${p.disputeId}` : simulated ? `Bench case ${p.disputeId.slice(6)}` : 'Case report',
    live ? `${p.reason.replace(/_/g, ' ').toLowerCase()} · filed ${when(p.filedAt)}` : simulated ? 'A test case from the Black Box bench: the dispute is simulated' : 'No PayPal dispute is attached to this recording');

  if (!j) {
    const d = r.decisions?.at(-1);
    verdictCard(doc, { accent: C.muted, bg: C.panel, who: 'The agent bought nothing' }, 'DECLINED', `${d?.model ? modelName(d.model) : 'The agent'}: “${clip(d?.reason ?? '', 400)}”`, null);
    return doc.bytes();
  }

  const v = j.verdict;
  const theme = THEME[v.verdict];
  const plan = j.plan;
  verdictCard(doc, theme, `${VERDICT_WORD[v.verdict]} · RULE ${v.rule}`, v.why,
    plan.action === 'none' ? plan.note : `${ACTION[plan.action] ?? plan.action}${plan.refundCents ? `: ${money(plan.refundCents)}` : ''}. ${plan.note ?? ''}`);

  const m = r.mandate;
  const charged = j.order.capturedCents;
  const over = charged - m.maxTotalCents;
  tiles(doc, [
    { label: 'BUYER’S LIMIT', value: money(m.maxTotalCents), sub: j.mandateAuth?.ok && !j.mandateAuth.legacy ? 'approved with a passkey' : j.mandateAuth?.ok ? 'not passkey-signed' : 'approval not valid', subColor: j.mandateAuth?.ok ? C.muted : C.red },
    { label: 'CHARGED', value: money(charged), sub: over > 0 ? `${money(over)} over the limit` : 'within the limit', subColor: over > 0 ? C.red : C.green },
    { label: plan.refundCents ? 'REFUND' : 'ACTION', value: plan.refundCents ? money(plan.refundCents) : plan.action === 'provide-evidence' ? 'Evidence' : 'None', sub: plan.refundCents ? (live && p.executed ? 'sent to PayPal' : 'planned') : plan.action === 'provide-evidence' ? 'the purchase is defended' : 'left for a person', subColor: C.muted },
    { label: 'RECORD', value: j.facts.hashesMatch ? 'Intact' : 'Changed', valueColor: j.facts.hashesMatch ? C.green : C.red, sub: j.facts.hashesMatch ? 'matches the PayPal order' : 'does not match the order', subColor: C.muted },
  ]);

  sectionTitle(doc, 'What happened');
  const d = (r.decisions ?? []).findLast((x) => x.action === 'buy') ?? r.decisions?.at(-1);
  const a = m.item?.attributes ?? {};
  const item = j.product ? `${j.product.name} (${j.product.sku})` : r.purchase.sku;
  const events = [
    [m.notBefore, 'The buyer set the limit', `${[a.color, m.item?.category].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}, at most ${money(m.maxTotalCents)}${j.mandateAuth?.ok && !j.mandateAuth.legacy ? ', approved with their passkey' : ''}.${j.buyerRequest ? ` In their words: “${clip(j.buyerRequest.text, 160)}”` : ''}`],
    [r.fetches[0]?.fetched_at, 'The AI agent read the shop', `${r.fetches.length} page${r.fetches.length === 1 ? '' : 's'}, ${r.fetches.every((f) => f.verification?.ok) ? 'all signed by the shop' : 'not all validly signed'}.${j.facts.inModelInput && j.facts.namesPurchasedItem ? ' One held text hidden from people, about this item.' : ''}`],
    [d?.at, `${d?.model ? modelName(d.model) : 'The agent'} decided to buy`, `${item}: “${clip(d?.reason ?? '', 180)}”`],
    [live ? p.orderCreatedAt : r.purchase.at, 'The buyer was charged', `${money(charged)} on a ${money(m.maxTotalCents)} limit.${live ? ` PayPal order ${p.orderId ?? ''}.` : ''}`],
    ...(live ? [
      [p.filedAt, 'The buyer disputed it', `${p.reason.replace(/_/g, ' ').toLowerCase()}.`],
      [p.executed?.at ?? null, 'Black Box acted', p.executed ? `${p.executed.action.toLowerCase()}, accepted by PayPal (HTTP ${p.executed.httpStatus}).${p.escalated ? ' The inquiry was escalated to a claim first.' : ''}` : 'Nothing was sent to PayPal: the case is left for a person.'],
      ...(p.payout ? [[p.payout.at, 'The operator repaid the merchant', `${money(p.payout.amount?.cents)} through PayPal Payouts, batch ${p.payout.batchId ?? ''}.`]] : []),
    ] : []),
  ];
  timeline(doc, events, theme.accent);

  // ---------------------------------------------------------------- evidence
  doc.newPage();
  sectionTitle(doc, 'What the AI read that people could not see');
  const weight = (f) => (f.contradictsListing && f.inModelInput ? 0 : f.inModelInput ? 1 : 2);
  const hidden = j.findings.filter((f) => f.namesPurchasedItem || f.inModelInput).sort((x, y) => weight(x) - weight(y));
  if (!hidden.length) note(doc, 'Nothing hidden on the purchased page named this item or reached the agent.');
  for (const f of hidden.slice(0, 4)) {
    const decisive = f.contradictsListing && f.inModelInput;
    quote(doc, `Hidden ${methodPlain(f.method)}`, clip(f.text.replace(/\s+/g, ' '), 600), decisive ? C.brand : C.off);
    chips(doc, [
      ['Names this item', f.namesPurchasedItem],
      ['Contradicts the signed listing', f.contradictsListing],
      ['Reached the AI', f.inModelInput],
      ['The shop’s own signed text', f.signedByMerchant && f.selfContained && !f.thirdPartySigned],
    ]);
  }
  if (hidden.length > 4) note(doc, `${hidden.length - 4} more hidden texts are in the record.`);
  const flagged = (j.flaggedPassages ?? []).filter((q) => q.namesPurchasedItem);
  if (flagged.length) note(doc, `A separate AI check (${j.flagger?.model ? modelName(j.flagger.model) : 'the flagger'}) also quoted text aimed at AI shoppers about this item. It can only send a case to a person, never decide one.`);

  sectionTitle(doc, 'What the AI decided');
  quote(doc, `${d?.model ? modelName(d.model) : 'The agent'} · bought ${item}`, `“${clip(d?.reason ?? '', 700)}”`, C.off);

  sectionTitle(doc, `The ${FACT_KEYS.length} checks behind the verdict`);
  checks(doc, j.facts);

  sectionTitle(doc, 'Dispute details');
  table(doc, [
    ...(live ? [
      ['Dispute', `${p.disputeId} · ${p.reason}`],
      ['Filed', when(p.filedAt)],
      ['PayPal order', `${p.orderId ?? '–'} · created ${when(p.orderCreatedAt)}`],
      ['Capture', `${p.captureId ?? '–'} · ${money(p.captured?.cents)} ${p.captured?.currency ?? ''}`],
      ['Buyer (payer ID)', p.payerId ?? '–'],
      ['Merchant (payee ID)', p.payeeMerchantId ?? '–'],
      ['Black Box sent', p.executed ? `${p.executed.action} · HTTP ${p.executed.httpStatus} · ${when(p.executed.at)}` : 'Nothing'],
      ['PayPal right after', p.after?.outcome ? `${p.after.outcome.outcome_code ?? ''} ${p.after.outcome.outcome_reason ?? ''}`.trim() : (p.after?.status ?? '–')],
    ] : [['Dispute', simulated ? `Simulated: ${p.reason}, ${money(p.captured?.cents)} captured` : `None yet; verdict shown for ${j.reason}`]]),
    ['Mandate', `${[a.color, m.item?.category].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}, at most ${money(m.maxTotalCents)} ${m.currency}${m.signedShopsOnly ? ', signed shops only' : ''}`],
    ...(m.notBefore ? [['Valid', `${when(m.notBefore)} to ${when(m.notAfter)}`]] : []),
    ['Approval', j.mandateAuth?.ok ? (j.mandateAuth.legacy ? `Not passkey-signed: ${j.mandateAuth.reason}` : 'Passkey enrolled by the paying PayPal account; signs this exact mandate') : `Not valid: ${j.mandateAuth?.reason ?? 'no approval'}`],
    ['Item', `${item}${j.product ? ` · signed price ${money(j.product.priceCents)}` : ''}`],
    ['Mandate check', j.mandate.broken ? j.mandate.violations.map((x) => (x.code === 'OVER_CAP' ? `over the limit by ${money(over)}` : x.detail)).join('; ') : 'kept'],
  ]);

  sectionTitle(doc, 'Has the record been changed?');
  fingerprint(doc, c.hash, j.order.customId, j.facts.hashesMatch, j.integrityProblems ?? []);

  const statements = statementsFor({ record: r, j, hash: c.hash, reason: j.reason });
  if (statements) {
    sectionTitle(doc, 'Statements for the evidence');
    for (const s of statements) bullet(doc, s);
  }

  sectionTitle(doc, 'Check it yourself');
  note(doc, `${caseUrl ? `The case, with the pages as the agent and a person saw them, is at ${caseUrl} — ` : ''}download the record (JSON) there, take the SHA-256 of its canonical JSON and compare it with the order’s custom_id. The rules are deterministic code: the same record and PayPal data give the same verdict to the buyer, the merchant or PayPal. This responsibility policy is Black Box’s proposal, not PayPal’s current policy.`);
  return doc.bytes();
}

// ---------------------------------------------------------------- blocks

const measureBox = (text, { font = 'regular', size = 10, width }) => boxHeight(width, text, { font, size });
const textWidth = (text, opts) => measure(text, opts);

function header(doc, title, sub) {
  const h = 118;
  doc.rect(0, 0, 612, h, { fill: C.dark });
  doc.rect(doc.left, 36, 20, 12, { fill: C.brand, radius: 2.5 });
  doc.rect(doc.left + 4.5, 39.5, 4, 5, { fill: C.dark, radius: 1 });
  doc.rect(doc.left + 11.5, 39.5, 4, 5, { fill: C.dark, radius: 1 });
  doc.textAt(doc.left + 28, 46, 'BLACK BOX', { font: 'bold', size: 11, color: '#ffffff', tracking: 1.6 });
  doc.textAt(doc.left + doc.width, 46, 'CASE REPORT FOR THE PAYPAL DISPUTE REVIEWER', { font: 'bold', size: 7, color: '#9ca3af', tracking: 1, align: 'right' });
  doc.textAt(doc.left, 82, title, { font: 'bold', size: 22, color: '#ffffff' });
  doc.textAt(doc.left, 100, sub, { size: 9, color: '#9ca3af' });
  doc.y = h + 22;
}

function verdictCard(doc, theme, chip, body, action) {
  const pad = 18, x = doc.left, w = doc.width, inner = w - 2 * pad - 6;
  const bodyH = measureBox(body, { size: 9.5, width: inner });
  const actionH = action ? measureBox(action, { font: 'bold', size: 9.5, width: inner - 14 }) + 16 : 0;
  const h = pad + 46 + bodyH + actionH + pad - 6;
  doc.need(h + 14);
  const y = doc.y;
  doc.rect(x, y, w, h, { fill: theme.bg, radius: 8 });
  doc.rect(x, y, 6, h, { fill: theme.accent, radius: 3 });
  doc.textAt(x + pad + 6, y + pad + 7, 'VERDICT', { font: 'bold', size: 7.5, color: theme.accent, tracking: 1.4 });
  const cw = textWidth(chip, { font: 'bold', size: 7.5, tracking: 0.8 }) + 16;
  doc.rect(x + w - pad - cw, y + pad - 3, cw, 15, { fill: theme.accent, radius: 7.5 });
  doc.textAt(x + w - pad - cw / 2, y + pad + 7.5, chip, { font: 'bold', size: 7.5, color: '#ffffff', tracking: 0.8, align: 'center' });
  doc.textAt(x + pad + 6, y + pad + 36, theme.who, { font: 'bold', size: 24, color: C.ink });
  let cy = y + pad + 46;
  cy += doc.textBox(x + pad + 6, cy, inner, body, { size: 9.5, color: C.ink2 });
  if (action) {
    cy += 8;
    const ah = measureBox(action, { font: 'bold', size: 9.5, width: inner - 14 }) + 8;
    doc.rect(x + pad + 6, cy, inner, ah, { fill: '#ffffff', radius: 5 });
    doc.textBox(x + pad + 13, cy + 3, inner - 14, action, { font: 'bold', size: 9.5, color: theme.accent });
  }
  doc.y = y + h + 14;
}

function tiles(doc, list) {
  const gap = 10, w = (doc.width - gap * (list.length - 1)) / list.length, h = 66;
  doc.need(h + 10);
  const y = doc.y;
  list.forEach((t, i) => {
    const x = doc.left + i * (w + gap);
    doc.rect(x, y, w, h, { fill: C.panel, radius: 6 });
    doc.textAt(x + 12, y + 18, t.label, { font: 'bold', size: 6.5, color: C.muted, tracking: 1 });
    doc.textAt(x + 12, y + 40, t.value, { font: 'bold', size: 18, color: t.valueColor ?? C.ink });
    doc.textAt(x + 12, y + 55, t.sub, { size: 7.5, color: t.subColor ?? C.muted });
  });
  doc.y = y + h + 12;
}

function sectionTitle(doc, title) {
  doc.need(64);
  doc.space(12);
  doc.textAt(doc.left, doc.y + 9, title.toUpperCase(), { font: 'bold', size: 8.5, color: C.brand, tracking: 1.3 });
  doc.line(doc.left, doc.y + 15, doc.left + doc.width, doc.y + 15, { color: C.rule });
  doc.space(26);
}

function timeline(doc, events, accent) {
  const timeW = 92, dotX = doc.left + timeW + 8, textX = dotX + 16, textW = doc.left + doc.width - textX;
  events.forEach(([at, title, detail], i) => {
    const dh = measureBox(detail, { size: 8.5, width: textW });
    const h = 14 + dh + 12;
    doc.need(h);
    const y = doc.y;
    if (i < events.length - 1) doc.line(dotX, y + 8, dotX, y + h + 2, { color: C.rule, width: 1.5 });
    doc.circle(dotX, y + 6, 4.5, { fill: i === events.length - 1 ? accent : '#ffffff', stroke: accent, lineWidth: 1.5 });
    doc.textAt(doc.left + timeW - 4, y + 9, at ? when(at).replace(' UTC', '') : '', { font: 'mono', size: 7.5, color: C.muted, align: 'right' });
    doc.textAt(textX, y + 9.5, title, { font: 'bold', size: 10, color: C.ink });
    doc.textBox(textX, y + 13, textW, detail, { size: 8.5, color: C.ink2 });
    doc.y = y + h;
  });
  doc.textAt(doc.left + timeW - 4, doc.y + 2, 'times in UTC', { size: 6.5, color: C.faint, align: 'right' });
  doc.space(8);
}

function quote(doc, title, text, bar) {
  const pad = 12, inner = doc.width - 2 * pad - 4;
  const th = measureBox(text, { font: 'italic', size: 9.5, width: inner });
  const h = pad + 12 + th + pad;
  doc.need(h + 30);
  const y = doc.y;
  doc.rect(doc.left, y, doc.width, h, { fill: C.panel, radius: 6 });
  doc.rect(doc.left, y, 4, h, { fill: bar, radius: 2 });
  doc.textAt(doc.left + pad + 4, y + pad + 6, title, { font: 'bold', size: 8.5, color: C.ink });
  doc.textBox(doc.left + pad + 4, y + pad + 12, inner, text, { font: 'italic', size: 9.5, color: C.ink2 });
  doc.y = y + h + 6;
}

function chips(doc, list) {
  let x = doc.left;
  const y = doc.y, h = 17;
  for (const [text, on] of list) {
    const w = textWidth(text, { size: 7.5 }) + 30;
    if (x + w > doc.left + doc.width) break;
    doc.rect(x, y, w, h, { fill: on ? '#ecfdf3' : '#f3f4f6', stroke: on ? '#a7e3bf' : C.rule, radius: 8.5, lineWidth: 0.6 });
    doc.icon(on ? 'check' : 'dash', x + 10, y + h / 2, 5, { fill: on ? C.green : C.faint });
    doc.textAt(x + 19, y + 11.5, text, { size: 7.5, color: on ? '#14532d' : C.muted });
    x += w + 6;
  }
  doc.y = y + h + 14;
}

// Each check as a lamp: record checks are green when they hold and red when they fail; the
// mandate is red when broken; merchant conditions are orange when on (they point at the shop);
// the other signals are amber when on; anything off is grey.
function checks(doc, facts) {
  const groups = [
    ['The record can be trusted', RECORD_CHECKS],
    ['The buyer’s limit', ['mandateBroken']],
    ['The shop’s hidden text (all five make the shop responsible)', MERCHANT_CONDITIONS],
    ['Other signals (can only send the case to a person)', FACT_KEYS.filter((k) => !RECORD_CHECKS.includes(k) && !MERCHANT_CONDITIONS.includes(k) && k !== 'mandateBroken')],
  ];
  const colW = (doc.width - 16) / 2;
  const rowH = (pair) => Math.max(...pair.map((k) => measureBox(FACT[k]?.[1] ?? k, { size: 7.5, width: colW - 34 }) + 24));
  for (const [title, keys] of groups) {
    doc.need(14 + rowH(keys.slice(0, 2)) + 6); // the group's title stays with its first row
    doc.textAt(doc.left, doc.y + 8, title, { font: 'bold', size: 8, color: C.ink2 });
    doc.space(14);
    for (let i = 0; i < keys.length; i += 2) {
      const pair = keys.slice(i, i + 2);
      const h = rowH(pair);
      doc.need(h + 4);
      const y = doc.y;
      pair.forEach((k, col) => {
        const v = facts[k];
        const x = doc.left + col * (colW + 16);
        const [kind, fill] = RECORD_CHECKS.includes(k) ? (v ? ['check', C.green] : ['cross', C.red])
          : k === 'mandateBroken' ? (v ? ['cross', C.red] : ['check', C.green])
            : v ? ['check', MERCHANT_CONDITIONS.includes(k) ? C.brand : C.amber] : ['dash', C.off];
        doc.rect(x, y, colW, h, { fill: '#ffffff', stroke: C.rule, radius: 5, lineWidth: 0.6 });
        doc.icon(kind, x + 13, y + 12, 6, { fill });
        doc.textAt(x + 25, y + 14.5, FACT[k]?.[0] ?? k, { font: 'bold', size: 7.5, color: C.ink, tracking: 0.4 });
        doc.textAt(x + colW - 9, y + 14.5, v ? 'YES' : 'NO', { font: 'bold', size: 7, color: v ? fill : C.faint, align: 'right', tracking: 0.6 });
        doc.textBox(x + 25, y + 17, colW - 34, FACT[k]?.[1] ?? '', { size: 7.5, color: C.muted, leading: 10 });
      });
      doc.y = y + h + 5;
    }
    doc.space(6);
  }
}

function table(doc, rows) {
  const labelW = 130, valueW = doc.width - labelW - 20;
  rows.forEach(([label, value], i) => {
    const h = Math.max(measureBox(value, { size: 8.5, width: valueW }), 10) + 10;
    doc.need(h);
    const y = doc.y;
    if (i % 2 === 0) doc.rect(doc.left, y, doc.width, h, { fill: C.panel, radius: 3 });
    doc.textAt(doc.left + 10, y + 13, label, { font: 'bold', size: 8, color: C.muted });
    doc.textBox(doc.left + labelW + 10, y + 3.5, valueW, value, { size: 8.5, color: C.ink });
    doc.y = y + h;
  });
  doc.space(6);
}

function fingerprint(doc, hash, customId, same, problems) {
  const h = 74;
  doc.need(h + 10);
  const y = doc.y;
  doc.rect(doc.left, y, doc.width, h, { fill: C.dark, radius: 6 });
  doc.textAt(doc.left + 14, y + 20, 'RECORD SHA-256', { font: 'bold', size: 6.5, color: '#9ca3af', tracking: 1 });
  doc.textAt(doc.left + 14, y + 33, hash, { font: 'mono', size: 8.5, color: '#ffffff' });
  doc.textAt(doc.left + 14, y + 51, 'PAYPAL ORDER CUSTOM_ID', { font: 'bold', size: 6.5, color: '#9ca3af', tracking: 1 });
  doc.textAt(doc.left + 14, y + 64, customId ?? '–', { font: 'mono', size: 8.5, color: same ? '#86efac' : '#fca5a5' });
  doc.rect(doc.left + doc.width - 84, y + 12, 70, 16, { fill: same ? C.green : C.red, radius: 8 });
  doc.textAt(doc.left + doc.width - 49, y + 23, same ? 'MATCH' : 'NO MATCH', { font: 'bold', size: 7, color: '#ffffff', tracking: 1, align: 'center' });
  doc.y = y + h + 8;
  note(doc, same
    ? 'The record’s fingerprint equals the custom_id PayPal stored on the order at checkout, which cannot change after payment, and every stored page still matches its own fingerprint. Nobody has edited it since.'
    : `The fingerprint does not match the PayPal order: the record was changed, or it belongs to another payment. ${problems.join('; ')}`);
}

function note(doc, text) {
  doc.text(text, { size: 8.5, color: C.ink2 });
  doc.space(4);
}

function bullet(doc, text) {
  const x = doc.left + 12, w = doc.width - 12;
  const h = measureBox(text, { size: 8.5, width: w });
  doc.need(h + 4);
  doc.circle(doc.left + 3, doc.y + 6, 1.8, { fill: C.brand });
  doc.textBox(x, doc.y, w, text, { size: 8.5, color: C.ink2 });
  doc.y += h + 4;
}
