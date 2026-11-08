// The lab: change one thing about a real recorded case, or set the facts by hand, and watch the
// engine decide again on the server, on this request. Plain HTML forms, no client script.
//   /lab                  pick a case, the dispute reason and what to tamper with
//   /lab/run?case=R03&t=edit-page&...   the case page for the changed case, with a banner
//   /lab/page?...         the changed record's purchased page, served like any recorded page
//   /lab/facts?on=...     the six rules on facts you choose

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCase, CASES, ENROLMENT } from '../bench/cases.mjs';
import { judge } from '../replay/cases.mjs';
import { casePage, layout, RULE_SHORT } from '../replay/page.mjs';
import { decide, FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, RULES, VERDICT } from '../engine/verdict.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const label = (v) => (v === VERDICT.HUMAN ? 'NEEDS A HUMAN' : v);
const money = (c) => `$${(c / 100).toFixed(2)}`;

export const BASES = CASES.filter((d) => d.kind !== 'attack');
// The lab opens on the newest live case: the agent paid by itself, and Black Box refunded the buyer.
const DEFAULT_CASE = BASES.find((d) => d.id === 'P09') ?? BASES[0];

// The case list, grouped so a first-time visitor can find a case: the live PayPal disputes first.
const CASE_GROUPS = [
  ['Live disputes in the PayPal sandbox', (d) => Boolean(d.paypal)],
  ['Recorded agent runs', (d) => d.kind === 'recorded'],
  ['Approved with the buyer’s passkey', (d) => d.kind === 'passkey'],
  ['Honest price data the shop is not blamed for', (d) => d.kind === 'honest-data'],
  ['The lie reworded to slip past the checks', (d) => d.kind === 'evasion'],
  ['The AI flagger', (d) => d.kind === 'flagger'],
];
const groupOf = (d) => CASE_GROUPS.find(([, has]) => has(d))[0];
// One case for each verdict, to start from.
const PICKS = [
  ['P09', 'The shop hid a lie', 'Live: the agent paid $240 on a $150 budget, refunded'],
  ['P06', 'The agent overspent by itself', 'Live: nothing misled it, the buyer got the $90 back'],
  ['R01', 'An honest purchase', 'The buyer disputes anyway; the shop keeps the money'],
  ['R06', 'A lie in someone else’s review', 'Not the shop’s own words, so a person decides'],
].map(([id, head, sub]) => ({ d: BASES.find((b) => b.id === id), head, sub })).filter((p) => p.d);

export const REASONS = [
  ['MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'Not as described'],
  ['INCORRECT_AMOUNT', 'Charged the wrong amount'],
  ['UNAUTHORISED', 'I did not authorise this'],
  ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'Not received'],
];

const editPage = (r) => {
  const page = r.fetches[r.purchase.page_index];
  const html = Buffer.from(page.body_b64, 'base64').toString('utf8');
  page.body_b64 = Buffer.from(html.replace(/<h1>(.)/, (_, c) => `<h1>${c === 'X' ? 'Y' : 'X'}`), 'utf8').toString('base64');
};

// The operator's claim that the buyer asked for the overspend: words put into the buyer's request
// and into the model input that carries it, as if the buyer had typed them.
const BUYER_WORDS = 'I can go up to $300 if it is the best one.';
const claimBuyerAsked = (r) => {
  r.buyer_request = BUYER_WORDS;
  const mi = r.model_inputs[0];
  mi.text = mi.text.replace(/(The user asked for: [^\n]*\n)(In the user's own words: [^\n]*\n)?/, `$1In the user's own words: ${BUYER_WORDS}\n`);
  mi.sha256 = createHash('sha256').update(mi.text).digest('hex');
};

// Each tamper is something a party to the dispute might try. `record` changes the sealed record;
// `order` changes what PayPal reports. Neither can re-sign anything: the lab has no keys.
export const TAMPERS = [
  { id: 'edit-page', who: 'Merchant', what: 'Edit one letter of the stored product page, to cover its tracks', record: editPage },
  { id: 'raise-cap', who: 'Agent operator', what: 'Raise the budget in the record to $300 after the buyer approved it', record: (r) => { r.mandate.maxTotalCents = 30000; } },
  { id: 'strip-passkey', who: 'Agent operator', what: "Remove the buyer's passkey approval from the record", record: (r) => { delete r.mandate_auth; }, applies: (r) => Boolean(r.mandate_auth) },
  { id: 'other-payee', who: 'Merchant', what: 'Have PayPal pay a different merchant account than the signed page names', order: { payeeMerchantId: 'LABOTHERPAYEE' } },
  { id: 'backdate-order', who: 'Agent operator', what: 'Claim the order was placed before the pages were signed', order: { createdAt: '2026-01-01T00:00:00Z' } },
  { id: 'buyer-asked', who: 'Agent operator', what: `Claim the buyer asked for the overspend: add “${BUYER_WORDS}” to the buyer’s own words in the record`, record: claimBuyerAsked },
  { id: 'swap-record', who: 'Buyer or operator', what: 'Present a record from a different purchase as the record of this order', order: (base) => ({ customIdFrom: base.record === 'sonnet55-honest.json' ? 'llama1b-control-overspend.json' : 'sonnet55-honest.json' }) },
];

const load = (root) => (name) => JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', name), 'utf8'));

function enrolmentFor(root) {
  const e = load(root)(ENROLMENT);
  return (payerId) => (payerId === e.payer_id ? e.credentials : []);
}

// query: URLSearchParams with case, reason, t (repeatable), before (custom_id made from the changed record).
export function runLab(root, query) {
  const base = BASES.find((d) => d.id === query.get('case')) ?? DEFAULT_CASE;
  const reason = REASONS.some(([r]) => r === query.get('reason')) ? query.get('reason') : base.reason;
  const chosen = TAMPERS.filter((t) => query.getAll('t').includes(t.id));
  const before = query.get('before') === '1';
  const order = Object.assign({}, ...chosen.map((t) => (typeof t.order === 'function' ? t.order(base) : t.order ?? {})));
  const records = chosen.filter((t) => t.record);
  const def = {
    ...base, id: 'LAB', reason,
    mutate: records.length ? (r) => records.forEach((t) => t.record(r)) : undefined,
    // By default PayPal keeps the custom_id of the record as it was at payment, so any change
    // to the record shows. "before" models a record changed before payment.
    keepOriginalCustomId: records.length > 0 && !before,
    order: Object.keys(order).length ? order : undefined,
  };
  const enrolment = enrolmentFor(root);
  const original = buildCase({ ...base, reason }, load(root));
  const noEffect = chosen.filter((t) => t.applies && !t.applies(original.record));
  const changed = buildCase(def, load(root));
  // What PayPal did belongs to the real case; a changed case has not been through PayPal.
  if (chosen.length) { delete changed.paypal.executed; delete changed.paypal.after; delete changed.paypal.trigger; changed.paypal.labRun = true; }
  return {
    base, reason, chosen, before, noEffect,
    was: judge(original, { enrolment, trustBenchKey: true }),
    c: changed,
    j: judge(changed, { enrolment, trustBenchKey: true }),
  };
}

const option = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

export function labForm(query = new URLSearchParams()) {
  const picked = query.get('case') ?? DEFAULT_CASE.id;
  const t = new Set(query.getAll('t'));
  return `<form class="panel lab" method="get" action="/lab/run">
<label>Case<select name="case">${CASE_GROUPS.map(([name]) => `<optgroup label="${esc(name)}">${BASES.filter((d) => groupOf(d) === name)
    .map((d) => option(d.id, `${d.id} · ${d.title} → ${label(d.expect.verdict)}`, d.id === picked)).join('')}</optgroup>`).join('')}</select></label>
<label>The buyer disputes it as<select name="reason">${option('', 'the case’s own reason', !query.get('reason'))}${REASONS.map(([r, text]) => option(r, text, r === query.get('reason'))).join('')}</select></label>
<fieldset><legend>Tamper with it</legend>${TAMPERS.map((x) => `<label class="chk"><input type="checkbox" name="t" value="${x.id}"${t.has(x.id) ? ' checked' : ''}><span><b>${esc(x.who)}</b> ${esc(x.what)}</span></label>`).join('')}
<label class="chk"><input type="checkbox" name="before" value="1"${query.get('before') === '1' ? ' checked' : ''}><span><b>Stronger attacker</b> The record was changed before payment, so PayPal’s custom_id matches the changed record</span></label></fieldset>
<button type="submit">Run the engine</button></form>`;
}

function picks(picked) {
  return `<nav class="picks" aria-label="Start from a case">${PICKS.map(({ d, head, sub }) => `<a class="pick ${d.expect.verdict}" href="/lab?case=${d.id}"${d.id === picked ? ' aria-current="true"' : ''}>
<span class="top"><i></i>${esc(label(d.expect.verdict))}<small>${d.id}</small></span><b>${esc(head)}</b><span>${esc(sub)}</span></a>`).join('')}</nav>`;
}

export function labPage(query = new URLSearchParams()) {
  const picked = BASES.some((d) => d.id === query.get('case')) ? query.get('case') : DEFAULT_CASE.id;
  return layout('Black Box · lab', `<section class="hero"><div><div class="eyebrow"><b>●</b> Lab · live engine</div>
<h1>Try to <em>cheat it.</em></h1></div>
<div><p>Pick a real case, choose how the buyer disputes it, and tamper with it the way a shop, buyer or agent operator might.
The server re-runs the real engine on your request. Like an attacker, it has no signing keys. It never calls PayPal.</p>
<p>Or <a href="/lab/facts">set the facts by hand</a> and see which rule applies.</p></div></section>
<section class="sec"><div class="eyebrow">Start from one of these, or pick any of the ${BASES.length} cases below</div>${picks(picked)}${labForm(new URLSearchParams({ case: picked }))}</section>`, { active: 'lab' });
}

export function labResult(root, query) {
  const { base, reason, chosen, before, noEffect, was, c, j } = runLab(root, query);
  const verdictOf = (x) => `${label(x.verdict.verdict)} · rule ${x.verdict.rule} · ${x.plan.action}${x.plan.refundCents ? ` ${money(x.plan.refundCents)}` : ''}`;
  const broken = RECORD_CHECKS.filter((k) => !j.facts[k]);
  const banner = `<section class="sec labbar"><div class="panel"><div class="eyebrow"><b>●</b> Lab run</div>
<p><b>${esc(base.id)}</b> ${esc(base.title)}, disputed as <span class="mono">${esc(reason)}</span>.
${chosen.length ? `Changed: ${chosen.map((t) => esc(t.what.charAt(0).toLowerCase() + t.what.slice(1))).join('; ')}${before ? ' (before payment)' : ''}.` : 'Nothing changed.'}${noEffect.length ? ` No effect here: this record has nothing to ${noEffect.map((t) => esc(t.what.split(' ')[0].toLowerCase())).join(', ')} (it was placed before the buyer enrolled a passkey).` : ''}</p>
<p>Unchanged: <b>${esc(verdictOf(was))}</b><br>Now: <b>${esc(verdictOf(j))}</b>${broken.length ? ` · failed checks: <span class="mono">${esc(broken.join(', '))}</span>` : ''}</p>
<details><summary>Change something else</summary>${labForm(query)}</details></div></section>`;
  return casePage({ ...c, source: `lab: ${c.source}`, recordHref: null, nav: 'lab', pageSrc: `/lab/page?${esc(query.toString())}` }, j).replace('<main id="main">', `<main id="main">${banner}`);
}

const FACT_GROUPS = [
  ['Record integrity (all must hold)', RECORD_CHECKS],
  ['Mandate', ['mandateBroken']],
  [`Merchant responsible (all ${MERCHANT_CONDITIONS.length}, for one hidden text)`, MERCHANT_CONDITIONS],
  ['Other signals', FACT_KEYS.filter((k) => !RECORD_CHECKS.includes(k) && !MERCHANT_CONDITIONS.includes(k) && k !== 'mandateBroken')],
];

export function factsPage(query) {
  const submitted = query.get('set') === '1';
  const on = new Set(submitted ? query.getAll('on') : RECORD_CHECKS);
  const facts = Object.fromEntries(FACT_KEYS.map((k) => [k, on.has(k)]));
  const v = decide(facts);
  const boxes = FACT_GROUPS.map(([title, keys]) => `<fieldset><legend>${esc(title)}</legend>${keys.map((k) => `<label class="chk"><input type="checkbox" name="on" value="${k}"${facts[k] ? ' checked' : ''}><span class="mono">${k}</span></label>`).join('')}</fieldset>`).join('');
  return layout('Black Box · lab · facts', `<section class="hero"><div><div class="eyebrow"><b>●</b> Lab · the rules alone</div>
<h1>${esc(label(v.verdict))} <em>· rule ${v.rule}</em></h1></div>
<div><p>${esc(RULE_SHORT[v.rule])}</p><p>The engine decides from these ${FACT_KEYS.length} yes/no facts. Tick any combination: exactly one rule applies, and the tests check all ${(2 ** FACT_KEYS.length).toLocaleString('en-US')} combinations.</p></div></section>
<section class="sec"><form class="panel lab" method="get" action="/lab/facts"><input type="hidden" name="set" value="1">${boxes}<button type="submit">Decide</button></form>
<ol class="ladder">${RULES.map((r) => `<li class="${r.verdict}${r.n === v.rule ? ' fired' : ''}"><span class="n">${r.n}</span><span class="tag">${label(r.verdict)}</span><span>${esc(RULE_SHORT[r.n])}</span></li>`).join('')}</ol></section>`, { active: 'lab' });
}
