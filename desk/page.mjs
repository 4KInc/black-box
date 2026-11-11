// The evidence desk's pages, in the replay's layout:
//   /desk                  what the desk does, and its scenarios (public)
//   /desk/scenario/<D..>   one scenario's package (public)
//   /desk/<dispute>        a live dispute's package, with the forms to add a document and to send
//                          (operator password; lab/live.mjs serves it)
// Every line on a page is read off the decision: each check with its sources, each document with
// the facts kept from it, the ones thrown out and why, and any line in it that addressed a reader.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { layout } from '../replay/page.mjs';
import { executionLog } from '../executor/core.mjs';
import { REASON_TEXT } from './desk.mjs';
import { deskState } from './run.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (c) => `$${(c / 100).toFixed(2)}`;

export const HEAD = {
  send: ['The evidence', 'proves it', 'Ready to send'],
  missing: ['Not proven', 'yet', 'Needs a document'],
  concede: ['Refund the', 'buyer', 'Refund the buyer'],
  person: ['A person', 'decides', 'Needs a person'],
};
const STATE = { met: ['✓', 'Shown'], missing: ['…', 'Missing'], against: ['✗', 'Against'], conflict: ['≠', 'Disagree'], info: ['·', 'Note'] };
const KIND = { paypal: 'Verified with PayPal', records: 'From your records', document: 'From a document' };
const KEY = { tracking_number: 'Tracking number', carrier: 'Carrier', shipped_at: 'Shipped', delivery_status: 'Status', delivered_at: 'Delivered', delivery_postcode: 'Delivered to postcode', refund_id: 'Refund ID' };

const CSS = `<style>
.sec>header h2{flex-basis:100%}
.d-send{--c:var(--green)}.d-missing{--c:var(--amber)}.d-concede{--c:var(--red)}.d-person{--c:var(--ink)}
.dhero h1 em{color:var(--c)}
.dmeta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font:400 12px/1.5 var(--mono);color:var(--ink-3);margin-top:12px}.dmeta b{color:var(--ink-2);font-weight:400;overflow-wrap:anywhere}
.dverdict{display:inline-block;font:700 15px/1 var(--display);letter-spacing:.14em;text-transform:uppercase;color:var(--c);border:1px solid var(--c);border-radius:3px;padding:7px 10px;margin-bottom:12px}
.dchecks{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dchecks>li{display:grid;grid-template-columns:110px minmax(0,1fr);gap:4px 16px;padding:12px 14px;border:1px solid var(--rule);border-radius:4px;background:var(--bg-1)}
.dchecks .st{font:400 11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase}
.dchecks .met .st{color:var(--green)}.dchecks .missing .st{color:var(--amber)}.dchecks :is(.against,.conflict) .st{color:var(--red)}.dchecks .info .st{color:var(--ink-3)}
.dchecks :is(.against,.conflict){border-color:oklch(.66 .21 27 / .5)}.dchecks .missing{border-style:dashed;border-color:oklch(.83 .15 82 / .5)}
.dchecks h3{margin:0;font:600 17px/1.2 var(--display);letter-spacing:.02em}
.dchecks p{margin:2px 0 0;color:var(--ink-2)}
.dsrc{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;grid-column:2}
.dsrc span{font:400 11px/1.4 var(--mono);color:var(--ink-3);border:1px solid var(--rule-2);border-radius:2px;padding:4px 7px;max-width:100%;overflow-wrap:anywhere}
.dsrc span.paypal{color:var(--cyan);border-color:oklch(.80 .11 222 / .45)}.dsrc span.records{color:var(--amber)}.dsrc span q{color:var(--ink-2)}
@media (max-width:640px){.dchecks>li{grid-template-columns:1fr}.dsrc{grid-column:1}}
.ddocs{display:grid;gap:12px}
.ddoc h3{margin:0 0 6px;font:600 18px/1.2 var(--display);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.ddoc h3 small{font:400 11px/1 var(--mono);color:var(--ink-3);letter-spacing:.06em}
.ddoc pre{margin:8px 0;padding:10px 12px;background:var(--bg);border:1px solid var(--rule);border-radius:3px;font:400 12px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink-2);max-height:22em;overflow:auto}
.ddoc pre mark{background:oklch(.80 .17 150 / .18);color:var(--ink);border-bottom:1px solid var(--green)}.ddoc pre mark.flag{background:oklch(.66 .21 27 / .22);border-bottom-color:var(--red)}
.dfacts{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px;font:400 12px/1.5 var(--mono)}
.dfacts li{color:var(--ink-2)}.dfacts li b{color:var(--ink);font-weight:400}.dfacts li.out{color:var(--ink-3);text-decoration:line-through;text-decoration-color:var(--rule-2)}.dfacts li.out span{text-decoration:none;display:inline-block;margin-left:6px;color:var(--amber)}
.dflag{margin:8px 0 0;padding:10px 12px;border:1px solid oklch(.66 .21 27 / .6);border-radius:3px;color:var(--ink-2)}.dflag b{color:var(--red);font:400 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;display:block;margin-bottom:4px}
.dpkg pre{margin:6px 0 0;padding:10px 12px;background:var(--bg);border:1px solid var(--rule);border-radius:3px;font:400 12px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.dpkg ol{margin:8px 0 0;padding-left:20px;color:var(--ink-2)}
.dstatus{margin-top:14px;font:400 12px/1.5 var(--mono);color:var(--ink-3)}.dstatus b{color:var(--c);font-weight:400}
form.dform{display:grid;gap:10px;max-width:72ch}
form.dform input,form.dform textarea{font:400 14px/1.4 var(--sans);color:var(--ink);background:var(--bg-2);border:1px solid var(--rule-2);border-radius:3px;padding:9px 10px;max-width:100%}
form.dform textarea{min-height:10em;font-family:var(--mono);font-size:12.5px}
form.dform button{justify-self:start;font:700 16px/1 var(--display);letter-spacing:.14em;text-transform:uppercase;color:#140600;background:var(--orange);border:0;border-radius:3px;padding:12px 18px;cursor:pointer}
form.dform button.send{background:var(--green)}
form.dform label{font:400 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.dcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.dcard{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--rule);border-radius:4px;background:var(--bg-1);text-decoration:none}
.dcard:hover{border-color:var(--c)}
.dcard .top{display:flex;gap:10px;align-items:baseline}.dcard .id{font:700 24px/1 var(--display);color:var(--orange)}
.dcard .dv{white-space:nowrap;font:700 13px/1 var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--c)}.dcard .ok{white-space:nowrap;margin-left:auto;font:400 11px/1 var(--mono);color:var(--green)}.dcard .ok.no{color:var(--red)}
.dcard h3{margin:0;font:600 17px/1.2 var(--display);letter-spacing:.02em}
.dcard p{margin:0;font:400 11.5px/1.45 var(--mono);color:var(--ink-3)}
.dsteps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;counter-reset:s;list-style:none;margin:0;padding:0}
.dsteps li{padding:14px;border:1px solid var(--rule);border-radius:4px;background:var(--bg-1);color:var(--ink-2)}
.dsteps li b{display:block;font:600 18px/1.15 var(--display);color:var(--ink);margin-bottom:4px}
.dsteps li::before{counter-increment:s;content:"0" counter(s);display:block;font:400 11px/1 var(--mono);color:var(--orange);letter-spacing:.1em;margin-bottom:8px}
.dflash{margin:14px 0 0;padding:10px 12px;border:1px solid var(--rule-2);border-radius:3px;color:var(--ink-2)}
</style>`;

// A scenario's result in the shape of a live dispute's state.
export const deskView = (r) => ({ pp: r.pp, read: r.read, result: r.result, docs: r.read.map((x) => x.doc), packageHash: null, approved: false, sent: null });

// Every dispute the desk has looked at here, newest first, from the execution logs.
export function liveDesk(root) {
  const dir = join(root, 'records', 'executions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6))
    .map((id) => { const entries = executionLog(root, id).read(); return entries.some((e) => e.step === 'desk-decision') ? deskState(root, id, entries) : null; })
    .filter(Boolean)
    .sort((a, b) => String(b.dispute?.create_time ?? '').localeCompare(String(a.dispute?.create_time ?? '')));
}

const sec = (title, note, body) => `<section class="sec"><header><h2>${title}</h2>${note ? `<p>${note}</p>` : ''}</header>${body}</section>`;

function sourceChip(f) {
  if (f.source.kind === 'paypal') return `<span class="paypal">${KIND.paypal}: ${esc(f.value)}</span>`;
  return `<span class="${f.source.kind}">${KIND[f.source.kind]}: ${esc(f.source.name)}${f.quote ? ` <q>${esc(f.quote)}</q>` : ''}</span>`;
}

// The document with the quoted lines marked: kept facts green, lines that addressed a reader red.
function marked(text, quotes, flags) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const ranges = [];
  for (const [q, cls] of [...quotes.map((q) => [q, '']), ...flags.map((q) => [q, 'flag'])]) {
    const words = norm(q).split(' ').filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) continue;
    const m = new RegExp(words.join('\\s+')).exec(text);
    if (m) ranges.push([m.index, m.index + m[0].length, cls]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e, cls] of ranges) { if (s < at) continue; out += esc(text.slice(at, s)) + `<mark${cls ? ` class="${cls}"` : ''}>${esc(text.slice(s, e))}</mark>`; at = e; }
  return out + esc(text.slice(at));
}

function docBlock(r) {
  const kept = r.facts.map((f) => `<li><b>${esc(KEY[f.key] ?? f.key)}: ${esc(f.value)}</b></li>`).join('');
  const out = r.dropped.map((d) => `<li class="out">${esc(KEY[d.key] ?? d.key)}: ${esc(d.value ?? '')}<span>thrown out: ${esc(d.why)}</span></li>`).join('');
  const flags = r.instructions.map((q) => `<div class="dflag"><b>Addressed to the reader: shown, not followed</b>“${esc(q)}”</div>`).join('');
  const how = r.doc.kind === 'records' ? 'your export, read by code' : r.unread ? `not read: ${r.unread}` : 'a message, read by an AI and checked by code';
  return `<div class="panel ddoc"><h3>${esc(r.doc.name)}<small>${esc(how)}</small></h3>
<pre>${r.doc.kind === 'records' ? esc(r.doc.text) : marked(r.doc.text, r.facts.map((f) => f.quote), r.instructions)}</pre>
${kept || out ? `<ul class="dfacts">${kept}${out}</ul>` : '<p class="k">No fact the desk uses.</p>'}${flags}</div>`;
}

function paypalPanel(pp) {
  const rows = [
    ['Dispute', `${pp.disputeId ?? '–'} · ${REASON_TEXT[pp.reason] ?? pp.reason} · ${fmt(pp.disputedCents)}`],
    ['Payment', `capture ${pp.captureId ?? '–'}${pp.orderId ? ` · order ${pp.orderId}` : ''}${pp.orderedAt ? ` · ordered ${pp.orderedAt}` : ''}`],
    ['Ships to', pp.shipTo ? `postcode ${pp.shipTo.postcode ?? '–'}${pp.shipTo.city ? `, ${pp.shipTo.city}` : ''}` : 'no shipping address on the order'],
    ['Refunds', pp.refunds.length ? pp.refunds.map((r) => `${r.id} ${fmt(r.cents)} ${r.status}`).join(' · ') : 'none on this payment'],
    ['Tracking', pp.trackers.length ? pp.trackers.map((t) => `${t.number ?? t.id} (${t.status}, set by the merchant)`).join(' · ') : 'none added to the order'],
    ['PayPal asked for', pp.requested.length ? pp.requested.join(', ') : 'nothing specific'],
  ];
  return `<div class="dmeta">${rows.map(([k, v]) => `<span>${k}</span><b>${esc(v)}</b>`).join('')}</div>`;
}

// st = deskState() or a bench case shaped like it. opts: { scenario, manage, flash, status }
export function deskCasePage(st, { scenario = null, manage = false, flash = '', status = '' } = {}) {
  const { pp, read, result } = st;
  const [a, b] = HEAD[result.decision];
  const tag = st.sent ? 'Sent to PayPal' : HEAD[result.decision][2];
  const title = scenario ? `${scenario.id} · ${scenario.title}` : `${pp.disputeId}`;
  const sent = st.sent ? `Sent to PayPal ${esc(String(st.sent.at ?? '').slice(0, 16).replace('T', ' '))} UTC. PayPal decides the dispute.` : '';
  const state = result.decision !== 'send' ? 'Nothing is sent.'
    : sent || (st.approved ? 'Approved: it goes out on the next run.' : manage ? 'Waiting for your approval below.' : scenario ? 'On a live dispute, this waits for the merchant to approve it.' : 'Waiting for the merchant\'s approval.');

  const checks = `<ul class="dchecks">${result.checks.map((c) => `<li class="${c.state}"><span class="st">${STATE[c.state][0]} ${STATE[c.state][1]}</span><div><h3>${esc(c.label)}</h3><p>${esc(c.detail)}</p></div>${c.sources.length ? `<div class="dsrc">${c.sources.map(sourceChip).join('')}</div>` : ''}</li>`).join('')}</ul>`;

  const pkg = result.decision === 'send' ? sec('What PayPal receives', 'Built by code from the checks above. The note is the statements, word for word; the file adds every document in full.',
    `<div class="panel dpkg"><div class="dmeta"><span>Evidence type</span><b>${esc(result.evidence.evidence_type)}</b></div>
<pre>${esc(JSON.stringify(result.evidence.evidence_info, null, 2))}</pre>
<ol>${result.statements.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<p class="dstatus"><b>${esc(state)}</b></p>
${manage && !st.sent && !st.approved && st.packageHash ? `<form class="dform" method="post" action="/desk/${esc(pp.disputeId)}/send"><input type="hidden" name="package" value="${esc(st.packageHash)}"><button class="send" type="submit">Send to PayPal</button></form>` : ''}</div>`)
    : result.decision === 'concede' ? sec('What the desk recommends', '', `<div class="panel"><p>${esc(result.why)}</p><p class="k">The desk moves no money. Accept the claim${result.concede?.refundCents ? ` for ${fmt(result.concede.refundCents)}` : ''} in PayPal yourself, or answer the buyer.</p></div>`)
      : '';

  const docs = read.length ? `<div class="ddocs">${read.map(docBlock).join('')}</div>` : '<p class="k">No documents yet.</p>';
  const add = manage ? `<form class="dform panel" method="post" action="/desk/${esc(pp.disputeId)}/doc">
<label for="dn">Name</label><input id="dn" name="name" placeholder="ups-delivered.txt, or export.json" maxlength="80">
<label for="dt">Paste the message or the export</label><textarea id="dt" name="text" required maxlength="20000" placeholder="From: UPS&#10;Your package has been delivered..."></textarea>
<button type="submit">Add the document</button></form>` : '';

  return layout(`Black Box · desk · ${title}`, `${CSS}<section class="hero top dhero d-${result.decision}"><div><span class="dverdict">${tag}</span><h1>${a} <em>${b}</em></h1></div>
<div><p>${esc(result.why)}</p>${paypalPanel(pp)}${status ? `<p class="dstatus">Last run: <b>${esc(status)}</b></p>` : ''}${flash ? `<p class="dflash">${esc(flash)}</p>` : ''}</div></section>
${sec(`What “${esc(REASON_TEXT[pp.reason] ?? pp.reason)}” needs`, 'Each requirement, and where its proof came from. Only the carrier\'s own message can show delivery.', checks)}
${pkg}
${sec('The sources', 'Lines highlighted green are the quotes a fact was kept from. Red lines addressed whoever reads the file: they are shown here and never acted on.', docs + add)}
<p class="k" style="margin-top:28px">${scenario ? 'The documents are samples written for this scenario. ' : ''}<a href="/desk">All desk disputes</a></p>`, { active: 'desk' });
}

// /desk: what it does, the live disputes (when hosted), and the scenarios.
export function deskIndex(bench, { live = null } = {}) {
  const passed = bench.filter((r) => r.pass).length;
  const card = (href, id, decision, title, line, ok = null, sent = false) => `<a class="dcard d-${decision}" href="${href}"><div class="top"><span class="id">${esc(id)}</span><span class="dv">${sent ? 'Sent to PayPal' : HEAD[decision][2]}</span>${ok === null ? '' : `<span class="ok${ok ? '' : ' no'}">${ok ? '✓ as written' : '✗ wrong'}</span>`}</div><h3>${esc(title)}</h3><p>${esc(line)}</p></a>`;
  const liveList = live === null ? '' : sec('Live disputes', 'Disputes in the PayPal sandbox with no Black Box record, or a reason the recorder does not answer. Opening one needs the operator password.',
    live.length ? `<div class="dcards">${live.map((st) => card(`/desk/${st.pp.disputeId}`, st.pp.disputeId.replace(/^PP-R-/, ''), st.result.decision, `${REASON_TEXT[st.pp.reason] ?? st.pp.reason} · ${fmt(st.pp.disputedCents)}`, st.sent ? 'Evidence sent: PayPal decides' : st.result.why, null, Boolean(st.sent))).join('')}</div>` : '<p class="k">None yet.</p>');
  return layout('Black Box · evidence desk', `${CSS}<section class="hero top"><div><h1>Evidence <em>desk</em></h1></div>
<div><p>For every other dispute a shop gets: “item not received”, “refund not received”, “charged twice”. It builds the evidence PayPal asks for, shows where each fact came from, says what is missing, and never makes up a defence.</p>
<div class="stats"><div class="stat"><b>${passed} of ${bench.length}</b><span>scenarios decided as written down</span></div></div></div></section>
${sec('How it decides', '', `<ol class="dsteps">
<li><b>Read PayPal first</b>The dispute, the order's shipping address, refunds and tracking on this exact payment.</li>
<li><b>Read what the shop adds</b>A carrier email or a support thread. An AI points at the lines; code keeps a fact only if its quote is in the file and the value is in the quote. It cannot tell a forged email from a real one, so PayPal gets every document in full.</li>
<li><b>Decide by code</b>Send, missing, refund the buyer, or a person. Delivery is proven only by the carrier's own message.</li>
<li><b>Send once, on approval</b>The merchant approves the exact package. It goes out once, even if PayPal times out.</li></ol>`)}
${liveList}
${sec('Scenarios', 'Each dispute\'s right answer is written down before the desk sees it. The AI\'s reading is replayed from the log, and code checks it against the file every time.',
    `<div class="dcards">${bench.map((r) => card(`/desk/scenario/${r.s.id}`, r.s.id, r.result.decision, r.s.title, r.result.why, r.pass)).join('')}</div>`)}`, { active: 'desk' });
}
