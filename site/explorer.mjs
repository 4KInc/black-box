// The explorer: every bench case, every study cell and every study run in AG Grid tables.
// This is the one page with scripts, and only the static site builds it. It loads AG Grid
// Community from jsDelivr, pinned to one version with its Subresource Integrity hash, and its own
// script from the site; its data is a JSON block, so nothing runs that was not built here.
// The verdicts it shows are the bench's own results: AG Grid only displays them.

import { FACT_KEYS } from '../engine/verdict.mjs';
import { cellKind, decisionOf, FACT, failsText, label, layout, modelFamily, modelName, planPlain, reasonPlain, RULE_SHORT, SECTIONS, setupOf, studySummary } from '../replay/page.mjs';

export const AG_GRID = {
  version: '36.2.0',
  src: 'https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/ag-grid-community.min.js',
  integrity: 'sha384-icvtRKM0YJJgeDhXnWY8UlF1PVBFd4K8Pj61la+vG+EU+awBeoP0xGPZhCD2SQOV',
};
// No 'unsafe-eval': the explorer gives AG Grid functions, never string expressions.
export const EXPLORER_CSP = "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'";

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
    executed: [].concat(p.executed ?? []).map((e) => `${e.action} · HTTP ${e.httpStatus}`),
    payout: p.payout ? `${p.payout.from} → ${p.payout.to} · batch ${p.payout.batchId} ${p.payout.status}` : null,
    pageUrl: page.url ?? null,
    signatureInput: h['signature-input'] ?? null,
    signature: h.signature ?? null,
    contentDigest: h['content-digest'] ?? null,
    bodySha256: page.body_sha256 ?? null,
    keyid: page.verification?.keyid ?? null,
    signedAt: page.verification?.created ? new Date(page.verification.created * 1000).toISOString() : null,
    facts: FACT_KEYS.map((k) => [FACT[k]?.[0] ?? k, Boolean(r.j.facts[k])]),
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
  return { scenarios, cells, runs };
}

// JSON inside <script type="application/json">: "<" is escaped so no text can close the block.
const jsonBlock = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const STYLE = `<style>
.xp-hero{padding-bottom:8px}.xp-hero h1{font-size:clamp(40px,5.4vw,68px)}
.xp-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.xp-tabs button,.xp-chips button{font:600 15px/1 var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);background:var(--bg-1);border:1px solid var(--rule);border-radius:2px;padding:9px 14px;cursor:pointer}
.xp-tabs button small{font:400 11px/1 var(--mono);letter-spacing:0;color:var(--ink-3);margin-left:8px}
.xp-tabs button[aria-selected=true]{color:var(--ink);border-color:var(--orange);background:var(--bg-2)}
.xp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 12px}
.xp-tools input{flex:1 1 220px;min-width:0;font:400 13px/1 var(--mono);color:var(--ink);background:var(--bg-1);border:1px solid var(--rule);border-radius:2px;padding:9px 12px}
.xp-chips{display:flex;flex-wrap:wrap;gap:6px}
.xp-chips button{font-size:13px;padding:7px 10px;display:inline-flex;align-items:center;gap:7px}
.xp-chips button i{width:8px;height:8px;border-radius:50%;background:var(--c,var(--ink-3))}
.xp-chips button[aria-pressed=true]{color:var(--ink);border-color:var(--c,var(--orange));background:var(--bg-2)}
.xp-count{font:400 12px/1 var(--mono);color:var(--ink-3)}
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
@media (max-width:640px){.xp-kv{grid-template-columns:minmax(0,1fr)}.xp-grid{height:70vh}}
</style>`;

export function explorerPage(data) {
  const n = (x) => x.toLocaleString('en-US');
  const verdicts = [['MERCHANT', 'Shop at fault'], ['AGENT', 'Agent at fault'], ['USER', 'Purchase stands'], ['NEEDS_A_HUMAN', 'Needs a human']];
  const body = `${STYLE}<section class="hero top xp-hero"><div><div class="eyebrow"><b>●</b> Explorer · AG Grid</div>
<h1>Every case,<br>every run</h1></div>
<div><p>${n(data.scenarios.length)} dispute scenarios and ${n(data.runs.length)} agent runs from the study, in one table. Sort, filter, pin, and pick a row to see its signatures, hashes and PayPal IDs.</p>
<p class="k" style="font-size:12px">The verdicts come from the bench (<span class="mono">npm run bench</span>). The table only shows them.</p></div></section>
<section class="sec" aria-label="Explorer">
<div class="xp-tabs" role="tablist">
<button role="tab" data-tab="scenarios" aria-selected="true">Dispute scenarios<small>${n(data.scenarios.length)}</small></button>
<button role="tab" data-tab="cells" aria-selected="false">Study results<small>${n(data.cells.length)}</small></button>
<button role="tab" data-tab="runs" aria-selected="false">Agent runs<small>${n(data.runs.length)}</small></button></div>
<div class="xp-tools"><input id="xp-q" type="search" placeholder="Search: a model, a dispute ID, a hash, a word from the agent’s reason" aria-label="Search the table">
<div class="xp-chips" id="xp-chips" role="group" aria-label="Verdict">${verdicts.map(([v, t]) => `<button class="${v}" data-v="${v}" aria-pressed="false"><i></i>${t}</button>`).join('')}</div>
<span class="xp-count" id="xp-count" aria-live="polite"></span></div>
<div id="xp-grid" class="xp-grid"><noscript><p style="padding:16px">The explorer needs JavaScript. Every case is also on the <a href="/bench">Scenarios</a> page and every run on the <a href="/study">Study</a> page, with no scripts.</p></noscript></div>
<div id="xp-detail" class="xp-detail" aria-live="polite"><p class="hint">Pick a row to see its details.</p></div>
</section>
<script type="application/json" id="xp-data">${jsonBlock(data)}</script>
<script src="${AG_GRID.src}" integrity="${AG_GRID.integrity}" crossorigin="anonymous"></script>
<script src="app.js"></script>`;
  return layout('Black Box · explorer', body, { active: 'explorer' });
}
