// The lab: change one thing about a real recorded case, or set the facts by hand, and watch the
// engine decide again on the server, on this request. Plain HTML forms, no client script.
//   /lab                  pick a case, the dispute reason and what to tamper with
//   /lab/run?case=R03&t=edit-page&...   the case page for the changed case, with a banner
//   /lab/facts?on=...     the six rules on facts you choose

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCase, CASES, ENROLMENT } from '../bench/cases.mjs';
import { judge } from '../replay/cases.mjs';
import { casePage, layout } from '../replay/page.mjs';
import { decide, FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, RULES, VERDICT } from '../engine/verdict.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const label = (v) => (v === VERDICT.HUMAN ? 'NEEDS A HUMAN' : v);
const money = (c) => `$${(c / 100).toFixed(2)}`;

export const BASES = CASES.filter((d) => d.kind !== 'attack');

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

// Each tamper is something a party to the dispute might try. `record` changes the sealed record;
// `order` changes what PayPal reports. Neither can re-sign anything: the lab has no keys.
export const TAMPERS = [
  { id: 'edit-page', who: 'Merchant', what: 'Edit one letter of the stored product page, to cover its tracks', record: editPage },
  { id: 'raise-cap', who: 'Agent operator', what: 'Raise the budget in the record to $300 after the buyer approved it', record: (r) => { r.mandate.maxTotalCents = 30000; } },
  { id: 'strip-passkey', who: 'Agent operator', what: "Remove the buyer's passkey approval from the record", record: (r) => { delete r.mandate_auth; }, applies: (r) => Boolean(r.mandate_auth) },
  { id: 'other-payee', who: 'Merchant', what: 'Have PayPal pay a different merchant account than the signed page names', order: { payeeMerchantId: 'LABOTHERPAYEE' } },
  { id: 'backdate-order', who: 'Agent operator', what: 'Claim the order was placed before the pages were signed', order: { createdAt: '2026-01-01T00:00:00Z' } },
  { id: 'swap-record', who: 'Buyer or operator', what: 'Present a record from a different purchase as the record of this order', order: (base) => ({ customIdFrom: base.record === 'sonnet55-honest.json' ? 'llama1b-control-overspend.json' : 'sonnet55-honest.json' }) },
];

const load = (root) => (name) => JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', name), 'utf8'));

function enrolmentFor(root) {
  const e = load(root)(ENROLMENT);
  return (payerId) => (payerId === e.payer_id ? e.credentials : []);
}

// query: URLSearchParams with case, reason, t (repeatable), before (custom_id made from the changed record).
export function runLab(root, query) {
  const base = BASES.find((d) => d.id === query.get('case')) ?? BASES[0];
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
  if (chosen.length) { delete changed.paypal.executed; delete changed.paypal.after; }
  return {
    base, reason, chosen, before, noEffect,
    was: judge(original, { enrolment }),
    c: changed,
    j: judge(changed, { enrolment }),
  };
}

const option = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

export function labForm(query = new URLSearchParams()) {
  const picked = query.get('case') ?? BASES[0].id;
  const t = new Set(query.getAll('t'));
  return `<form class="panel lab" method="get" action="/lab/run">
<label>Case<select name="case">${BASES.map((d) => option(d.id, `${d.id} · ${d.title}`, d.id === picked)).join('')}</select></label>
<label>The buyer disputes it as<select name="reason">${option('', 'the case’s own reason', !query.get('reason'))}${REASONS.map(([r, text]) => option(r, text, r === query.get('reason'))).join('')}</select></label>
<fieldset><legend>Tamper with it</legend>${TAMPERS.map((x) => `<label class="chk"><input type="checkbox" name="t" value="${x.id}"${t.has(x.id) ? ' checked' : ''}><span><b>${esc(x.who)}</b> ${esc(x.what)}</span></label>`).join('')}
<label class="chk"><input type="checkbox" name="before" value="1"${query.get('before') === '1' ? ' checked' : ''}><span><b>Stronger attacker</b> The record was changed before payment, so PayPal’s custom_id matches the changed record</span></label></fieldset>
<button type="submit">Run the engine</button></form>`;
}

export function labPage() {
  return layout('Black Box · lab', `<section class="hero"><div><div class="eyebrow"><b>●</b> Lab · live engine, nothing precomputed</div>
<h1>Try to <em>cheat it.</em></h1></div>
<div><p>Pick a real recorded case, choose how the buyer disputes it, and change something a merchant, buyer or agent operator might try.
The server rebuilds the case and runs the same engine the autopilot uses, on this request. The lab holds no signing keys, so it can change bytes
but cannot forge a signature, just like an attacker. It never calls PayPal.</p>
<p>Or skip the record and <a href="/lab/facts">set the facts by hand</a> to see which of the six rules fires.</p></div></section>
<section class="sec">${labForm()}</section>`, { active: 'lab' });
}

export function labResult(root, query) {
  const { base, reason, chosen, before, noEffect, was, c, j } = runLab(root, query);
  const verdictOf = (x) => `${label(x.verdict.verdict)} · rule ${x.verdict.rule} · ${x.plan.action}${x.plan.refundCents ? ` ${money(x.plan.refundCents)}` : ''}`;
  const broken = RECORD_CHECKS.filter((k) => !j.facts[k]);
  const banner = `<section class="sec labbar"><div class="panel"><div class="eyebrow"><b>●</b> Lab run · engine re-ran on this request</div>
<p><b>${esc(base.id)}</b> ${esc(base.title)}, disputed as <span class="mono">${esc(reason)}</span>.
${chosen.length ? `Changed: ${chosen.map((t) => esc(t.what.charAt(0).toLowerCase() + t.what.slice(1))).join('; ')}${before ? ' (before payment)' : ''}.` : 'Nothing changed.'}${noEffect.length ? ` No effect here: this record has nothing to ${noEffect.map((t) => esc(t.what.split(' ')[0].toLowerCase())).join(', ')} (it was placed before the buyer enrolled a passkey).` : ''}</p>
<p>Unchanged: <b>${esc(verdictOf(was))}</b><br>Now: <b>${esc(verdictOf(j))}</b>${broken.length ? ` · failed checks: <span class="mono">${esc(broken.join(', '))}</span>` : ''}</p>
<details><summary>Change something else</summary>${labForm(query)}</details></div></section>`;
  return casePage({ ...c, source: `lab: ${c.source}` }, j).replace('<main id="main">', `<main id="main">${banner}`);
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
<div><p>${esc(v.why)}</p><p>These are the ${FACT_KEYS.length} yes/no facts the engine decides from. Tick any combination: exactly one of the six rules fires for each of the ${(2 ** FACT_KEYS.length).toLocaleString('en-US')} combinations, which the test suite checks one by one. On a real case, code computes the facts from the record and PayPal; here you set them.</p></div></section>
<section class="sec"><form class="panel lab" method="get" action="/lab/facts"><input type="hidden" name="set" value="1">${boxes}<button type="submit">Decide</button></form>
<ol class="ladder">${RULES.map((r) => `<li class="${r.verdict}${r.n === v.rule ? ' fired' : ''}"><span class="n">${r.n}</span><span class="tag">${label(r.verdict)}</span><span>${esc(r.why)}</span></li>`).join('')}</ol></section>`, { active: 'lab' });
}
