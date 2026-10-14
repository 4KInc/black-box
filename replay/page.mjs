// HTML for the replay. No scripts at all: the server sends `script-src 'none'`, and the page the
// agent bought from is shown in a sandboxed iframe, so nothing recorded can run here.

import { toValue } from '../engine/actions.mjs';
import { FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, RULES, VERDICT } from '../engine/verdict.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c, cur = 'USD') => (Number.isInteger(c) ? `$${toValue(c)}${cur === 'USD' ? '' : ' ' + cur}` : '–');
const time = (iso) => (iso ? esc(String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')) : '–');
const short = (h, n = 12) => `${esc(String(h).slice(0, n))}…`;
const label = (v) => (v === VERDICT.HUMAN ? 'NEEDS A HUMAN' : v);

const WHO = {
  [VERDICT.MERCHANT]: 'The merchant pays',
  [VERDICT.AGENT]: 'The agent operator pays',
  [VERDICT.USER]: 'The purchase stands',
  [VERDICT.HUMAN]: 'A person decides',
};

const FACT_TEXT = {
  hashesMatch: 'Record hash equals the PayPal custom_id, and every stored page matches its hash',
  signaturesValid: 'Every page signature verifies (RFC 9421, Ed25519)',
  keyOnShopDomain: "The signing key was published on the shop's own domain",
  payeeMatches: 'The signed merchant ID equals the PayPal payee',
  signedBeforeOrder: 'Every page was signed before the PayPal order existed',
  mandateBroken: "The purchase breaks the user's mandate",
  concealedInReadChannel: 'Text hidden from people, inside what the agent reads',
  namesPurchasedItem: 'That hidden text names the item that was bought',
  inModelInput: 'That hidden text reached the model',
  merchantOwned: "That hidden text is the merchant's own (signed, self-contained, no third party)",
  aiInjectionFlag: 'An AI flagger marked agent-directed text (can only lead to NEEDS A HUMAN)',
  unattributedHiddenText: 'Hidden text the agent read that cannot be pinned on the merchant',
};

const CSS = `
:root{--ink:#16202b;--muted:#5d6b7b;--line:#dfe4ea;--bg:#f4f6f9;--card:#fff;--code:#f7f8fa;--mark:#ffe08a;--ok:#13795b;--bad:#b42318;
--merchant:#b45309;--agent:#6d28d9;--user:#1d4ed8;--human:#475569}
@media (prefers-color-scheme:dark){:root{--ink:#e6ebf1;--muted:#9aa7b6;--line:#2b3542;--bg:#0f141a;--card:#161d25;--code:#11171e;--mark:#7a5b00;--ok:#4ade80;--bad:#f87171;
--merchant:#f59e0b;--agent:#a78bfa;--user:#60a5fa;--human:#94a3b8}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}header.top{display:flex;gap:12px;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header.top b{font-size:16px}header.top span{color:var(--muted);font-size:13px}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.verdict{border-left:6px solid var(--c);display:grid;grid-template-columns:1fr minmax(240px,380px);gap:20px}
.verdict .v{font-size:34px;font-weight:800;color:var(--c);line-height:1.1}.verdict .who{font-size:18px;font-weight:600;margin:6px 0}
.verdict .why{color:var(--muted);margin:0}.verdict .pp{border-left:1px solid var(--line);padding-left:20px}
.PASS{--c:var(--ok)}.FAIL{--c:var(--bad)}.MERCHANT{--c:var(--merchant)}.AGENT{--c:var(--agent)}.USER{--c:var(--user)}.NEEDS_A_HUMAN{--c:var(--human)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;color:var(--c);border:1px solid var(--c)}
.k{color:var(--muted);font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}
.big{font-size:22px;font-weight:700}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
iframe{width:100%;height:560px;border:1px solid var(--line);border-radius:8px;background:#fff}
pre.input{margin:0;height:560px;overflow:auto;white-space:pre-wrap;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12.5px}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px;scroll-margin:40px}
blockquote{margin:12px 0 0;padding:10px 14px;border-left:3px solid var(--line);color:var(--ink)}
.finding{margin-top:12px}.finding p{margin:6px 0}
ul.checks{list-style:none;padding:0;margin:8px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 16px}
.yes::before{content:"✓ ";color:var(--ok);font-weight:700}.no::before{content:"✗ ";color:var(--bad);font-weight:700}
.no{color:var(--muted)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;border-top:0}
.t{font-weight:700;color:var(--ok)}.f{font-weight:700;color:var(--bad)}
.rule{opacity:.45}.rule.fired{opacity:1;outline:2px solid var(--c);outline-offset:-2px;border-radius:8px}
.rules td:first-child{width:36px;font-weight:700}
ol.tl{list-style:none;margin:0;padding:0}ol.tl li{display:grid;grid-template-columns:170px 1fr;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
ol.tl li:first-child{border-top:0}ol.tl .when{color:var(--muted);font-size:12.5px}
.cases tr:hover td{background:var(--code)}.cases a{text-decoration:none;font-weight:600}
.problems{color:var(--bad)}
@media (max-width:820px){.verdict,.two{grid-template-columns:1fr}.verdict .pp{border-left:0;border-top:1px solid var(--line);padding:12px 0 0}
ol.tl li{grid-template-columns:1fr;gap:0}iframe,pre.input{height:420px}.hide-sm{display:none}}
`;

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><b><a href="/" style="text-decoration:none">Black Box</a></b><span>replay of an AI agent's purchase, judged by code</span>
<nav style="margin-left:auto;display:flex;gap:14px;font-size:14px"><a href="/">Purchases</a><a href="/bench">Case bench</a></nav></header>
<main>${body}</main></body></html>`;
}

// Raw model input, escaped, with each hidden text marked. Whitespace may differ between the
// page and the model input, so the match is word by word.
export function highlight(text, needles) {
  const ranges = [];
  for (const n of needles) {
    const words = String(n).trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) continue;
    for (const m of text.matchAll(new RegExp(words.join('\\s+'), 'g'))) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  let out = '';
  let at = 0;
  merged.forEach(([s, e], i) => {
    out += esc(text.slice(at, s)) + `<mark${i === 0 ? ' id="hidden"' : ''}>${esc(text.slice(s, e))}</mark>`;
    at = e;
  });
  return { html: out + esc(text.slice(at)), count: merged.length };
}

export const pageHtml = (record) => Buffer.from(record.fetches[record.purchase.page_index].body_b64, 'base64').toString('utf8');
const decisionOf = (record) => record.decisions.at(-1) ?? {};
const yesNo = (v, text) => `<li class="${v ? 'yes' : 'no'}">${esc(text)}</li>`;

const paypalStatus = (p) => {
  const credit = p.after?.moneyMovements.find((m) => m.party === 'BUYER' && m.type === 'CREDIT');
  if (credit) return `${money(credit.amount.cents, credit.amount.currency)} refunded to the buyer`;
  return p.executed ? `${p.executed.action} sent` : `${p.after?.status ?? 'open'}, not yet acted on`;
};

const expectText = (e) => `${label(e.verdict)}, rule ${e.rule}, ${e.action}${e.refundCents ? ' ' + money(e.refundCents) : ''}${e.broken?.length ? `; breaks ${e.broken.join(', ')}` : ''}`;

export function benchPage(results) {
  const passed = results.filter((r) => r.pass).length;
  const row = (r) => `<tr><td><a href="/bench/${esc(r.def.id)}">${esc(r.def.id)}</a></td>
<td><b>${esc(r.def.title)}</b><div class="k">${esc(r.def.story)}</div></td>
<td class="hide-sm mono">${esc(r.def.reason)}</td>
<td><span class="pill ${r.got.verdict}">${label(r.got.verdict)}</span> <span class="k">rule ${r.got.rule}</span>
<div class="k">${esc(r.got.action)}${r.got.refundCents ? ' ' + money(r.got.refundCents) : ''}</div>
${r.got.broken ? `<div class="k mono">broken: ${esc(r.got.broken)}</div>` : ''}</td>
<td><span class="pill ${r.pass ? 'PASS' : 'FAIL'}">${r.pass ? 'PASS' : 'FAIL'}</span>${r.mismatches.map((m) => `<div class="problems k">${esc(m)}</div>`).join('')}</td></tr>`;
  const section = (kind, title, note) => `<h2>${title}</h2><p class="k" style="margin:-4px 0 10px">${note}</p><div class="card" style="padding:0;overflow-x:auto"><table class="cases">
<tr><th>Case</th><th>What happened</th><th class="hide-sm">PayPal reason</th><th>Code decided</th><th>Expected?</th></tr>
${results.filter((r) => r.def.kind === kind).map(row).join('')}</table></div>`;
  return layout('Black Box case bench', `<section class="card verdict ${passed === results.length ? 'PASS' : 'FAIL'}"><div>
<div class="k">Case bench · runs offline from recorded agent runs, no API keys</div>
<div class="v">${passed}/${results.length}</div><div class="who">cases get exactly the expected verdict, rule and PayPal action</div>
<p class="why">Every verdict and every rule is covered. Re-run it with <span class="mono">npm run bench</span>.</p></div></section>
${section('recorded', 'Recorded runs', "Real agent runs, sealed by the recorder, with the model's own output.")}
${section('attack', 'Attacks on the record', 'A real record with one thing forged or swapped. Each must fail exactly the checks named.')}`);
}

export function indexPage(rows) {
  const body = rows.length ? rows.map(({ c, j }) => {
    const d = decisionOf(c.record);
    return `<tr><td class="hide-sm">${time(c.record.purchase.at)}</td>
<td><a href="/case/${c.hash}">${esc(d.model ?? 'unknown model')}</a><div class="k mono">${short(c.hash, 16)}</div></td>
<td>${esc(c.record.purchase.sku)}<div class="k">${money(c.record.purchase.price_cents)} · cap ${money(c.record.mandate.maxTotalCents)}</div></td>
<td><span class="pill ${j.verdict.verdict}">${label(j.verdict.verdict)}</span> <span class="k">rule ${j.verdict.rule}</span></td>
<td>${c.paypal ? `${esc(c.paypal.disputeId)}<div class="k">${esc(paypalStatus(c.paypal))}</div>` : '<span class="k">preview</span>'}</td>
<td class="hide-sm k mono">${esc(c.source)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="k">No records yet. Run the agent (node agent/run.mjs) to make one.</td></tr>';
  return layout('Black Box replay', `<h2>Recorded purchases</h2><div class="card" style="padding:0;overflow-x:auto"><table class="cases">
<tr><th class="hide-sm">Bought</th><th>Agent</th><th>Item</th><th>Verdict</th><th>PayPal dispute</th><th class="hide-sm">Source</th></tr>${body}</table></div>`);
}

function paypalPanel(c, j) {
  const p = c.paypal;
  if (!p) {
    return `<div class="k">PREVIEW: no dispute filed</div><div>If disputed as <span class="mono">${esc(j.reason)}</span>, Black Box would:</div>
<div class="big">${j.plan.action === 'none' ? 'No automatic action' : esc(j.plan.action)}${j.plan.refundCents ? ' ' + money(j.plan.refundCents) : ''}</div><div class="k">${esc(j.plan.note)}</div>`;
  }
  const buyer = p.after?.moneyMovements.find((m) => m.party === 'BUYER' && m.type === 'CREDIT');
  const refund = p.after?.refundTransactions[0];
  return `<div class="k">PayPal dispute <span class="mono">${esc(p.disputeId)}</span></div>
${p.executed ? `<div class="big">${buyer ? `${money(buyer.amount.cents, buyer.amount.currency)} back to the buyer` : esc(p.executed.action)}</div>
<div class="k">Executed <span class="mono">${esc(p.executed.action)}</span> → HTTP ${esc(p.executed.httpStatus)} at ${time(p.executed.at)}</div>
${refund ? `<div class="k">Refund transaction <span class="mono">${esc(refund.id)}</span></div>` : ''}`
    : `<div class="big">${j.plan.action === 'none' ? 'No automatic action' : esc(j.plan.action)}${j.plan.refundCents ? ' ' + money(j.plan.refundCents) : ''}</div><div class="k">Planned, not yet executed.</div>`}`;
}

function timeline(c, j) {
  const r = c.record;
  const items = [];
  r.fetches.forEach((f) => items.push([f.fetched_at, `Fetched <span class="mono">${esc(f.path)}</span> from ${esc(f.authority)} · signature ${f.verification?.ok ? `<span class="t">valid</span> <span class="k mono">key ${short(f.verification.keyid)}</span>` : `<span class="f">invalid</span>`}`]));
  r.model_inputs.forEach((m) => items.push([m.at, `Sent ${m.text.length.toLocaleString('en-US')} characters to the model <span class="k mono">sha256 ${short(m.sha256)}</span>`]));
  r.decisions.forEach((d) => items.push([d.at, `<b>${esc(d.model)}</b> decided: ${esc(d.action)} <span class="mono">${esc(d.sku ?? '')}</span>`]));
  items.push([r.purchase.at, `Record sealed and sent to checkout: ${money(r.purchase.price_cents)} <span class="k mono">custom_id ${short(c.hash)}</span>`]);
  const p = c.paypal;
  if (p) {
    if (p.orderCreatedAt) items.push([p.orderCreatedAt, `PayPal order <span class="mono">${esc(p.orderId)}</span> created; capture <span class="mono">${esc(p.captureId)}</span> ${money(p.captured?.cents)}`]);
    items.push([p.filedAt, `${c.bench ? 'Bench dispute' : 'Buyer filed dispute'} <span class="mono">${esc(p.disputeId)}</span>: ${esc(p.reason)}`]);
    if (p.executed) items.push([p.executed.at, `Black Box: <b>${label(j.verdict.verdict)}</b> (rule ${j.verdict.rule}) → <span class="mono">${esc(p.executed.action)}</span>`]);
    for (const m of p.after?.moneyMovements ?? []) items.push([p.executed?.at, `<span class="k">Money:</span> ${esc(m.party)} ${esc(m.type)} ${money(m.amount?.cents)} <span class="k">${esc(m.reason)}</span>`]);
  }
  return `<ol class="tl">${items.map(([at, h]) => `<li><span class="when">${time(at)}</span><span>${h}</span></li>`).join('')}</ol>`;
}

export function casePage(c, j) {
  const r = c.record;
  const d = decisionOf(r);
  const v = j.verdict.verdict;
  const needles = j.findings.filter((f) => f.inModelInput).map((f) => f.text);
  const inputs = r.model_inputs.map((m) => highlight(m.text, needles));
  const marked = inputs.reduce((n, i) => n + i.count, 0);
  const m = r.mandate;
  const attrs = Object.entries(m.item?.attributes ?? {}).map(([k, val]) => `${k} ${val}`).join(', ');
  const integrity = RECORD_CHECKS.every((k) => j.facts[k]);

  const verdictCard = `<section class="card verdict ${v}"><div>
<div class="k">Verdict · rule ${j.verdict.rule} of ${RULES.length}${j.preview ? ' · preview' : ''}</div>
<div class="v">${label(v)}</div><div class="who">${WHO[v]}</div><p class="why">${esc(j.verdict.why)}</p></div>
<div class="pp">${paypalPanel(c, j)}</div></section>`;

  const mandate = `<h2>What the user authorised</h2><div class="card two">
<div><div class="k">Mandate</div><div class="big">${esc(m.item?.category)}${attrs ? ` · ${esc(attrs)}` : ''}</div>
<div>at most <b>${money(m.maxTotalCents, m.currency)}</b>${m.signedShopsOnly ? ', from shops that sign their pages' : ''}</div>
<div class="k mono">mandate sha256 ${short(r.mandate_hash, 16)}</div></div>
<div><div class="k">What was bought</div><div class="big">${esc(j.product?.name ?? r.purchase.sku)} · ${money(j.order.capturedCents)}</div>
${j.mandate.violations.length ? `<ul class="checks">${j.mandate.violations.map((x) => `<li class="no" style="color:var(--bad)">${esc(x.code === 'OVER_CAP' ? `Over budget: paid ${money(j.order.capturedCents)}, cap ${money(m.maxTotalCents)}, ${money(j.order.capturedCents - m.maxTotalCents)} over` : `${x.code}: ${x.detail}`)}</li>`).join('')}</ul>` : '<ul class="checks"><li class="yes">Within the mandate</li></ul>'}</div></div>`;

  // The contrast in one line: the signed, visible price against the hidden text the model read.
  const hiddenRead = j.findings.find((f) => f.inModelInput && f.namesPurchasedItem) ?? j.findings.find((f) => f.inModelInput);
  const contrast = hiddenRead ? `<div class="two" style="margin-bottom:16px">
<div class="card"><div class="k">Shown to a person</div><div class="big">${esc(j.product?.name ?? r.purchase.sku)} · ${money(j.product?.priceCents ?? r.purchase.price_cents)}</div></div>
<div class="card"><div class="k">Hidden from people, read by the agent (${esc(hiddenRead.method)})</div><div><mark>“${esc(hiddenRead.text)}”</mark></div></div></div>` : '';

  const sideBySide = `<h2>What a person saw · what the agent read</h2>${contrast}<div class="two">
<div><div class="k" style="margin-bottom:6px">The signed page, rendered as a shopper sees it (scripts disabled)</div>
<iframe sandbox="" referrerpolicy="no-referrer" title="Recorded product page" src="${c.bench ? `/bench/${esc(c.bench.id)}` : `/case/${c.hash}`}/page"></iframe></div>
<div><div class="k" style="margin-bottom:6px">The exact model input, from the record${marked ? ` · <a href="#hidden">${marked} hidden passage${marked > 1 ? 's' : ''} highlighted</a>` : ''}</div>
<pre class="input">${inputs.map((i) => i.html).join('\n\n')}</pre></div></div>
${d.reason ? `<blockquote><span class="k">${esc(d.model)} explained its choice:</span><br>“${esc(d.reason)}”</blockquote>` : ''}`;

  const findings = `<h2>Hidden text on the purchased page</h2>${j.findings.length ? j.findings.map((f) => `<div class="card finding">
<div class="k">Hidden by: ${esc(f.method)}${f.thirdPartyIssuer ? ` · signed by third party ${esc(f.thirdPartyIssuer)}` : ''}</div>
<p>“${esc(f.text)}”</p><ul class="checks">${yesNo(f.concealedInReadChannel, 'Hidden from people')}${yesNo(f.namesPurchasedItem, 'Names the item bought')}
${yesNo(f.inModelInput, 'Reached the model')}${yesNo(f.signedByMerchant, 'Merchant-signed')}${yesNo(f.selfContained, 'Self-contained page')}${yesNo(!f.thirdPartySigned, 'No third-party signature')}</ul></div>`).join('')
    : '<div class="card k">None found.</div>'}`;

  const groups = [
    ['Is the record trustworthy?', RECORD_CHECKS],
    ['Did the purchase break the mandate?', ['mandateBroken']],
    ['Did the merchant cause it? (all four, for one hidden text)', MERCHANT_CONDITIONS],
    ['Any other injection signal?', FACT_KEYS.filter((k) => !RECORD_CHECKS.includes(k) && !MERCHANT_CONDITIONS.includes(k) && k !== 'mandateBroken')],
  ];
  const facts = `<h2>The facts code checked</h2><div class="card" style="padding:0;overflow-x:auto"><table>
${groups.map(([title, keys]) => `<tr><th colspan="2" style="padding-top:14px">${esc(title)}</th></tr>${keys.map((k) => `<tr><td>${esc(FACT_TEXT[k])}<div class="k mono">${esc(k)}</div></td><td class="${j.facts[k] ? 't' : 'f'}">${j.facts[k]}</td></tr>`).join('')}`).join('')}
</table></div>`;

  const rules = `<h2>The six rules (exactly one fires)</h2><div class="card" style="padding:6px"><table class="rules">
${RULES.map((rule) => `<tr class="rule ${rule.verdict} ${rule.n === j.verdict.rule ? 'fired' : ''}"><td>${rule.n}</td><td><span class="pill ${rule.verdict}">${label(rule.verdict)}</span></td><td>${esc(rule.why)}</td></tr>`).join('')}
</table></div>`;

  const proof = `<h2>Integrity</h2><div class="card"><div class="k">Record hash (sha256 of the canonical record) = PayPal custom_id</div>
<div class="mono">${esc(c.hash)}</div><div class="mono">${esc(j.order.customId ?? '')}</div>
<ul class="checks">${yesNo(c.hash === j.order.customId, 'The two are equal')}${yesNo(integrity, 'All record checks pass')}</ul>
${j.integrityProblems.length ? `<ul class="problems">${j.integrityProblems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
<div class="k" style="margin-top:8px">Source: <span class="mono">${esc(c.source)}</span></div></div>`;

  const b = c.benchResult;
  const benchCard = b ? `<section class="card" style="margin-bottom:16px"><div class="k"><a href="/bench">Case bench</a> · ${esc(b.def.id)} · ${esc(b.def.kind)}</div>
<div class="big">${esc(b.def.title)}</div><p style="margin:4px 0">${esc(b.def.story)}</p>
<div><span class="pill ${b.pass ? 'PASS' : 'FAIL'}">${b.pass ? 'PASS' : 'FAIL'}</span> <span class="k">expected ${esc(expectText(b.def.expect))}</span></div>
${b.mismatches.map((m) => `<div class="problems">${esc(m)}</div>`).join('')}</section>` : '';

  return layout(`${label(v)} · ${d.model ?? 'replay'}`, `${benchCard}${verdictCard}${mandate}${sideBySide}${findings}${facts}${rules}<h2>Timeline</h2><div class="card">${timeline(c, j)}</div>${proof}`);
}
