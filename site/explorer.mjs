// The explorer: every bench case, the money moved in the live PayPal disputes, every combination
// of the 16 facts, and every study cell and run, in AG Grid tables.
// This is the one page with scripts, and only the static site builds it. It loads AG Grid
// Community from jsDelivr, pinned to one version with its Subresource Integrity hash, and its own
// script from the site; its data is a JSON block, so nothing runs that was not built here.
// The verdicts it shows are the bench's own results: AG Grid only displays them.

import { decide, FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, RULES } from '../engine/verdict.mjs';
import { actionPlain, cellKind, triggerPlain, decisionOf, FACT, failsText, label, layout, modelFamily, modelName, planPlain, reasonPlain, RULE_SHORT, SECTIONS, setupOf, studySummary } from '../replay/page.mjs';

export const AG_GRID = {
  version: '36.2.0',
  src: 'https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/ag-grid-community.min.js',
  integrity: 'sha384-icvtRKM0YJJgeDhXnWY8UlF1PVBFd4K8Pj61la+vG+EU+awBeoP0xGPZhCD2SQOV',
};
// No 'unsafe-eval': the explorer gives AG Grid functions, never string expressions.
export const EXPLORER_CSP = "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'";

// What Black Box asks PayPal to do, as a ledger step.
const ACTS = { 'accept-claim': 'accepts the claim', 'accept-claim-partial': 'accepts part of the claim', 'provide-evidence': 'sends PayPal the evidence', 'make-offer': 'offers the buyer a refund' };
const live = (p) => Boolean(p?.disputeId) && !/^BENCH-/.test(p.disputeId);
const GROUP = Object.fromEntries(SECTIONS.map(([kind, title]) => [kind, title]));
const KIND_LABEL = { hit: 'the lie caused it', anyway: 'overspends anyway', clean: 'never fooled', mixed: 'the lie caused it', none: '' };

function scenarioRow(r) {
  const rec = r.c.record;
  const page = rec.fetches[rec.purchase?.page_index] ?? rec.fetches.at(-1) ?? {};
  const h = page.headers ?? {};
  const p = r.c.paypal ?? {};
  return {
    id: r.def.id,
    group: GROUP[r.def.kind] ?? r.def.kind,
    title: r.def.title,
    model: modelName(decisionOf(rec).model ?? 'unknown model'),
    family: modelFamily(decisionOf(rec).model),
    reason: reasonPlain(r.def.reason),
    verdict: r.got.verdict,
    verdictLabel: label(r.got.verdict),
    rule: r.got.rule,
    ruleText: RULE_SHORT[r.got.rule] ?? '',
    action: r.got.action,
    outcome: planPlain(r.got),
    refundCents: r.got.refundCents ?? null,
    budgetCents: rec.mandate?.maxTotalCents ?? null,
    paidCents: p.captured?.cents ?? rec.purchase?.price_cents ?? null,
    held: r.got.held,
    fails: failsText(r.got.broken).replace(/^fails: /, ''),
    expected: `${label(r.def.expect.verdict)} · rule ${r.def.expect.rule}`,
    pass: r.pass,
    live: live(p),
    disputeId: p.disputeId ?? null,
    orderId: p.orderId ?? null,
    captureId: p.captureId ?? null,
    customId: p.customId ?? null,
    recordHash: r.c.hash,
    executed: [].concat(p.executed ?? []).map((e) => actionPlain(e.action)),
    payout: p.payout ? `${p.payout.from} → ${p.payout.to} · batch ${p.payout.batchId} ${p.payout.status}` : null,
    pageUrl: page.url ?? null,
    signatureInput: h['signature-input'] ?? null,
    signature: h.signature ?? null,
    contentDigest: h['content-digest'] ?? null,
    bodySha256: page.body_sha256 ?? null,
    keyid: page.verification?.keyid ?? null,
    signedAt: page.verification?.created ? new Date(page.verification.created * 1000).toISOString() : null,
    facts: FACT_KEYS.map((k) => [FACT[k]?.[0] ?? k, Boolean(r.j.facts[k])]),
    bits: factBits(r.j.facts),
  };
}

// A set of facts as a number: bit i is FACT_KEYS[i], as in the property test.
const factBits = (f) => FACT_KEYS.reduce((n, k, i) => n | (f[k] ? 1 << i : 0), 0);

// The live sandbox disputes as a ledger: each step, and what it did to each party's money. Amounts
// are signed from that party's side. Settlements and fees are PayPal's own report (the dispute's
// money_movements after Black Box acted); the payment and the payout are PayPal's responses.
export function ledgerRows(bench) {
  const rows = [];
  const seen = new Set();
  for (const r of bench) {
    const p = r.c.paypal;
    if (!live(p) || seen.has(p.disputeId)) continue;
    seen.add(p.disputeId);
    const base = { caseId: r.def.id, disputeId: p.disputeId, verdict: r.got.verdict, rule: r.got.rule, orderId: p.orderId, captureId: p.captureId, trigger: p.trigger ? triggerPlain(p.trigger) : null };
    const row = (o) => rows.push({ ...base, buyerCents: null, shopCents: null, appCents: null, http: null, ref: null, by: 'PayPal', ...o });
    const paid = p.captured?.cents ?? null;
    row({ at: p.orderCreatedAt, step: 'Buyer pays the shop (order captured)', buyerCents: -paid, shopCents: paid, ref: p.captureId });
    row({ at: p.filedAt, step: `Buyer disputes: ${reasonPlain(p.reason)}`, ref: p.disputeId, by: 'the buyer' });
    if (p.escalated?.at) row({ at: p.escalated.at, step: 'Black Box escalates the inquiry to a claim', http: 200, ref: p.escalated.debugId, by: 'Black Box' });
    if (p.executed) {
      row({ at: p.executed.at, step: `Black Box ${ACTS[r.got.action] ?? ACTS[p.executed.action.split(' ')[0]] ?? actionPlain(p.executed.action)}`, http: p.executed.httpStatus, ref: p.executed.debugId, by: 'Black Box' });
    } else {
      row({ at: p.filedAt, step: 'Held: no money moves until a person decides', by: 'Black Box' });
    }
    const refunds = [...(p.after?.refundTransactions ?? [])];
    for (const m of p.after?.moneyMovements ?? []) {
      const c = (m.type === 'CREDIT' ? 1 : -1) * m.amount.cents;
      const fee = /FEE/.test(m.reason);
      const step = fee ? 'PayPal charges the shop its dispute fee' : m.party === 'BUYER' ? 'PayPal refunds the buyer' : 'PayPal takes the refund from the shop';
      row({ at: p.after.updatedAt, step, [m.party === 'BUYER' ? 'buyerCents' : 'shopCents']: c, ref: !fee && m.party === 'BUYER' ? refunds.shift()?.id ?? null : null });
    }
    if (p.payout) {
      row({ at: p.payout.at, step: 'Payouts: the shopping app repays the shop', appCents: -p.payout.amount.cents, shopCents: p.payout.amount.cents,
        http: p.payout.httpStatus, ref: `batch ${p.payout.batchId} · ${p.payout.status}`, by: 'Black Box' });
    }
  }
  // Disputes by when they were paid; within one, the steps in the order they happened (PayPal's
  // updatedAt can be a moment earlier than our log of the request that caused it).
  const first = new Map();
  for (const r of rows) if (!first.has(r.disputeId)) first.set(r.disputeId, r.at);
  return rows.map((r, i) => ({ ...r, seq: i })).sort((a, b) => String(first.get(a.disputeId)).localeCompare(String(first.get(b.disputeId))) || a.seq - b.seq);
}

// Every combination of the 16 facts, judged by the engine itself (decide), as the property test
// does. Rule n is the n-th character; the verdict follows from the rule.
export function decisionTable(scenarios) {
  const n = FACT_KEYS.length;
  let rules = '';
  for (let bits = 0; bits < 1 << n; bits++) {
    const f = Object.fromEntries(FACT_KEYS.map((k, i) => [k, Boolean(bits & (1 << i))]));
    rules += decide(f).rule;
  }
  const group = (k) => (RECORD_CHECKS.includes(k) ? 'The record' : MERCHANT_CONDITIONS.includes(k) ? 'The shop’s hidden lie'
    : k === 'mandateBroken' || k === 'requestExceedsMandate' ? 'The buyer’s limit' : 'Other warning signs');
  const benchAt = {};
  for (const s of scenarios) (benchAt[s.bits] ??= []).push(s.id);
  return {
    rules,
    facts: FACT_KEYS.map((k, i) => ({ key: k, bit: i, caption: FACT[k][0], tip: FACT[k][1], group: group(k) })),
    ruleVerdict: Object.fromEntries(RULES.map((r) => [r.n, r.verdict])),
    ruleText: RULE_SHORT,
    benchAt,
  };
}

export function explorerData(bench, studies) {
  const scenarios = bench.map(scenarioRow);
  const cells = [], runs = [];
  for (const study of studies) {
    const setup = setupOf(study).title;
    const budget = setupOf(study).budget;
    const lieBySku = new Map(study.lies.map((l) => [l.sku, l]));
    for (const row of studySummary(study).rows) {
      for (const c of row.cells) {
        const kind = cellKind(c);
        cells.push({ setup, model: modelName(row.model), family: modelFamily(row.model), lie: c.lie, who: c.who, priceCents: c.price, budgetCents: budget,
          lieBought: c.lieBought, lieN: c.lieN, ctlBought: c.ctlBought, ctlN: c.ctlN, effect: c.effect === null ? null : Math.round(c.effect * 100), kind: KIND_LABEL[kind] });
      }
    }
    for (const r of study.runs) {
      const l = lieBySku.get(r.sku);
      runs.push({ setup, model: modelName(r.model), family: modelFamily(r.model), condition: r.condition === 'lie' ? 'with the lie' : 'without (control)',
        lie: l?.lie ?? r.sku, priceCents: l?.price ?? null, budgetCents: budget, bought: r.error ? null : Boolean(r.bought), choice: r.choice ?? null,
        reason: r.reason ?? r.error ?? '', at: r.at ?? null });
    }
  }
  return { scenarios, ledger: ledgerRows(bench), decisions: decisionTable(scenarios), cells, runs };
}

// JSON inside <script type="application/json">: "<" is escaped so no text can close the block.
const jsonBlock = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const STYLE = `<style>
.xp-hero{padding-bottom:8px}.xp-hero h1{font-size:clamp(40px,5.4vw,68px)}
.xp-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.xp-tabs button,.xp-facet button{font:600 15px/1 var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);background:var(--bg-1);border:1px solid var(--rule);border-radius:2px;padding:9px 14px;cursor:pointer}
.xp-tabs button small{font:400 11px/1 var(--mono);letter-spacing:0;color:var(--ink-3);margin-left:8px}
.xp-tabs button[aria-selected=true]{color:var(--ink);border-color:var(--orange);background:var(--bg-2)}
.xp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 12px}
.xp-tools input{flex:1 1 220px;min-width:0;font:400 13px/1 var(--mono);color:var(--ink);background:var(--bg-1);border:1px solid var(--rule);border-radius:2px;padding:9px 12px}
.xp-facets{display:flex;flex-wrap:wrap;gap:10px 22px;margin:0 0 14px;padding:12px 14px;border:1px solid var(--rule);background:var(--bg-1)}
.xp-facet{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.xp-facet .lab{font:400 10.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-right:2px}
.xp-facet button{font-size:13px;padding:6px 9px;display:inline-flex;align-items:center;gap:7px;background:var(--bg)}
.xp-facet button i{width:8px;height:8px;border-radius:50%;background:var(--c,var(--ink-3))}
.xp-facet button small{font:400 11px/1 var(--mono);letter-spacing:0;color:var(--ink-3)}
.xp-facet button:hover{color:var(--ink);border-color:var(--rule-2)}
.xp-facet button[aria-pressed=true]{color:var(--ink);border-color:var(--c,var(--orange));background:var(--bg-2)}
.xp-facet button[aria-pressed=true] small{color:var(--ink-2)}
.xp-facet button.zero{opacity:.4}
.xp-count{font:400 12px/1 var(--mono);color:var(--ink-3)}
.xp-acts{display:flex;gap:6px;margin-left:auto}
.xp-acts button{font:400 12px/1 var(--mono);color:var(--ink-2);background:transparent;border:1px solid var(--rule);border-radius:2px;padding:8px 10px;cursor:pointer}
.xp-acts button:hover{color:var(--ink);border-color:var(--rule-2)}
.xp-lead{color:var(--ink-2);margin:0 0 12px;max-width:80ch}
.xp-lamp{font:600 13px/1 var(--display);letter-spacing:.08em}.xp-lamp.on{color:var(--amber)}.xp-lamp.off{color:var(--ink-3)}
.xp-sum{font-weight:700}
.xp-pos{color:var(--green)}.xp-neg{color:var(--red)}
.xp-grid{height:min(620px,70vh);border:1px solid var(--rule)}
.xp-v{display:inline-flex;align-items:center;gap:7px;font:600 14px/1 var(--display);letter-spacing:.08em;color:var(--c)}
.xp-v::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--c)}
.xp-ok{color:var(--green)}.xp-bad{color:var(--red)}
.xp-detail{margin-top:16px;border:1px solid var(--rule);background:var(--bg-1);padding:18px clamp(14px,2.4vw,24px)}
.xp-detail h3{font:600 22px/1.1 var(--display);letter-spacing:.04em;margin:0 0 4px}
.xp-detail .hint{color:var(--ink-3);margin:0}
.xp-kv{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:6px 16px;margin:14px 0 0}
.xp-kv dt{font:400 11px/1.6 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.xp-kv dd{margin:0;font:400 12px/1.6 var(--mono);overflow-wrap:anywhere;min-width:0}
.xp-lamps{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0;padding:0;list-style:none}
.xp-lamps li{font:600 12px/1 var(--display);letter-spacing:.08em;padding:6px 8px;border:1px solid var(--rule);color:var(--ink-3)}
.xp-lamps li.on{color:var(--amber);border-color:var(--amber)}
.xp-note{color:var(--ink-3);font-size:12px;margin:14px 0 0}
@media (max-width:640px){.xp-acts{margin-left:0}.xp-kv{grid-template-columns:minmax(0,1fr)}.xp-grid{height:70vh}}
</style>`;

export function explorerPage(data) {
  const n = (x) => x.toLocaleString('en-US');
  const body = `${STYLE}<section class="hero top xp-hero"><div><h1>Every case,<br>every run</h1></div></section>
<section class="sec" aria-label="Explorer">
<div class="xp-tabs" role="tablist">
<button role="tab" data-tab="scenarios" aria-selected="true">Dispute scenarios<small>${n(data.scenarios.length)}</small></button>
<button role="tab" data-tab="ledger" aria-selected="false">PayPal ledger<small>${n(data.ledger.length)}</small></button>
<button role="tab" data-tab="decisions" aria-selected="false">Every fact combination<small>${n(data.decisions.rules.length)}</small></button>
<button role="tab" data-tab="cells" aria-selected="false">Study results<small>${n(data.cells.length)}</small></button>
<button role="tab" data-tab="runs" aria-selected="false">Agent runs<small>${n(data.runs.length)}</small></button></div>
<div class="xp-tools"><input id="xp-q" type="search" placeholder="Search: a model, a dispute ID, a hash, a word from the agent’s reason" aria-label="Search the table">
<span class="xp-count" id="xp-count" aria-live="polite"></span>
<span class="xp-acts"><button id="xp-csv" type="button">Download CSV</button><button id="xp-link" type="button">Copy link to this view</button></span></div>
<div class="xp-facets" id="xp-facets"></div>
<p class="xp-lead" id="xp-lead"></p>
<div id="xp-grid" class="xp-grid"><noscript><p style="padding:16px">The explorer needs JavaScript. Every case is also on the <a href="/bench">Scenarios</a> page and every run on the <a href="/study">Study</a> page, with no scripts.</p></noscript></div>
<div id="xp-detail" class="xp-detail" aria-live="polite"><p class="hint">Pick a row to see its details.</p></div>
</section>
<script type="application/json" id="xp-data">${jsonBlock(data)}</script>
<script src="${AG_GRID.src}" integrity="${AG_GRID.integrity}" crossorigin="anonymous"></script>
<script src="app.js"></script>`;
  return layout('Black Box · explorer', body, { active: 'explorer' });
}
