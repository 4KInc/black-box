import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relativise, withCsp } from '../build.mjs';
import { AG_GRID, explorerData } from '../explorer.mjs';
import { decide, FACT_KEYS } from '../../engine/verdict.mjs';
import { runBench } from '../../bench/bench.mjs';
import { latestStudies } from '../../replay/cases.mjs';

test('links become relative to the page, with directory slashes', () => {
  assert.equal(relativise('<a href="/bench">x</a>', 0), '<a href="./bench/">x</a>');
  assert.equal(relativise('<a href="/case/ab/record.json" download="x.json">x</a>', 2), '<a href="../../case/ab/record.json" download="x.json">x</a>');
  assert.equal(relativise('<a href="/case/ab#hidden">x</a><iframe src="/case/ab/page">', 2), '<a href="../../case/ab/#hidden">x</a><iframe src="../../case/ab/page/">');
  assert.equal(relativise('<a href="#hidden">x</a><a href="https://github.com/x">y</a>', 2), '<a href="#hidden">x</a><a href="https://github.com/x">y</a>');
});

test('the CSP meta goes first in <head>', () => {
  assert.match(withCsp('<html><head><script>1</script></head>', "default-src 'none'"), /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><script>/);
});

test('the built site: every page has a CSP, no script (but the explorer), no absolute link, and the bench passes', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  const log = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'build.mjs'), out], { encoding: 'utf8' });
  assert.match(log, /29 bench cases \(29 pass\)|bench cases \((\d+) pass\)/);
  const pages = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === 'index.html') pages.push(p); } };
  walk(out);
  assert.ok(pages.length > 50);
  const explorer = join(out, 'explorer', 'index.html');
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/, p);
    if (p !== explorer) assert.doesNotMatch(html, /<script(?![^>]*application\/ld\+json)/i, p);
    assert.doesNotMatch(html, /(?:href|src)="\/[^/]/, p);
  }
  for (const p of pages.filter((x) => x.endsWith(join('page', 'index.html')))) {
    assert.doesNotMatch(readFileSync(p, 'utf8'), /frame-src/, p); // recorded pages cannot frame anything
  }
});

test('the explorer: only AG Grid (pinned, with SRI) and its own script run, with no eval', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'build.mjs'), out], { encoding: 'utf8' });
  const html = readFileSync(join(out, 'explorer', 'index.html'), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
  assert.deepEqual(scripts, ['type="application/json" id="xp-data"', `src="${AG_GRID.src}" integrity="${AG_GRID.integrity}" crossorigin="anonymous"`, 'src="app.js"']);
  assert.match(AG_GRID.src, /@\d+\.\d+\.\d+\//); // an exact version
  assert.ok(statSync(join(out, 'explorer', 'app.js')).size > 0);
  assert.match(html, /aria-current="page">Explorer</);
  assert.match(html, /<div class="xp-facets" id="xp-facets"><\/div>/); // the facet bar, filled by app.js
  const app = readFileSync(join(out, 'explorer', 'app.js'), 'utf8');
  for (const view of ['scenarios', 'ledger', 'decisions', 'cells', 'runs']) assert.match(app, new RegExp(`\\b${view}: \\{[\\s\\S]*?facets: \\[`), view);
  assert.match(readFileSync(join(out, 'bench', 'index.html'), 'utf8'), /href="\.\.\/explorer\/">Explorer</);
  assert.match(readFileSync(join(out, 'bench', 'P09', 'index.html'), 'utf8'), /href="\.\.\/\.\.\/explorer\/#v=scenarios&amp;id=P09">Open in the explorer/);
  assert.match(readFileSync(join(out, 'study', 'index.html'), 'utf8'), /class="xr" href="\.\.\/explorer\/#v=runs&amp;f=/);
});

test('explorer ledger: the live disputes, netted from PayPal’s own figures', () => {
  const { ledger, scenarios } = explorerData(runBench(), []);
  const live = scenarios.filter((s) => s.live);
  assert.equal(new Set(ledger.map((r) => r.disputeId)).size, live.length);
  const net = (id) => ledger.filter((r) => r.caseId === id).reduce((t, r) => ({ buyer: t.buyer + (r.buyerCents ?? 0), shop: t.shop + (r.shopCents ?? 0), app: t.app + (r.appCents ?? 0) }), { buyer: 0, shop: 0, app: 0 });
  // AGENT: the buyer ends at the budget, the shop pays PayPal's fee, the app repays the overage.
  assert.deepEqual(net('P06'), { buyer: -15000, shop: 24000 - 9000 - 887 + 9000, app: -9000 });
  // MERCHANT: the buyer is made whole; the shop is out PayPal's dispute fee.
  assert.deepEqual(net('P09'), { buyer: 0, shop: -887, app: 0 });
  // USER: the sale stands. Held for a person: nothing moves.
  assert.deepEqual(net('P04'), { buyer: -12900, shop: 12900, app: 0 });
  assert.deepEqual(net('P05'), { buyer: -24000, shop: 24000, app: 0 });
  for (const s of live) assert.ok(ledger.some((r) => r.caseId === s.id && r.ref === s.captureId), s.id);
});

test('explorer decision table: every fact combination, and each bench case lands on its own rule', () => {
  const { decisions, scenarios } = explorerData(runBench(), []);
  assert.equal(decisions.rules.length, 1 << FACT_KEYS.length);
  for (const bits of [0, 63, 8191, 65535, 12345]) {
    const f = Object.fromEntries(FACT_KEYS.map((k, i) => [k, Boolean(bits & (1 << i))]));
    assert.equal(Number(decisions.rules[bits]), decide(f).rule, String(bits));
  }
  assert.deepEqual(decisions.facts.map((f) => f.key), FACT_KEYS);
  for (const s of scenarios) {
    assert.equal(Number(decisions.rules[s.bits]), s.rule, s.id);
    assert.ok(decisions.benchAt[s.bits].includes(s.id));
  }
});

test('explorer data: every bench case with its own verdict, and every study run', () => {
  const bench = runBench();
  const studies = latestStudies(join(import.meta.dirname, '..', '..'));
  const d = explorerData(bench, studies);
  assert.equal(d.scenarios.length, bench.length);
  for (const [i, r] of bench.entries()) {
    assert.equal(d.scenarios[i].verdict, r.got.verdict);
    assert.equal(d.scenarios[i].rule, r.got.rule);
    assert.equal(d.scenarios[i].pass, r.pass);
    assert.equal(d.scenarios[i].facts.length, 16);
  }
  assert.equal(d.runs.length, studies.reduce((n, s) => n + s.runs.length, 0));
  assert.equal(d.cells.length, studies.reduce((n, s) => n + s.models.length * s.lies.length, 0));
  const p09 = d.scenarios.find((s) => s.id === 'P09');
  assert.equal(p09.disputeId, 'PP-R-XXC-10197051');
  assert.equal(p09.live, true);
  assert.equal(p09.customId, p09.recordHash);
  assert.match(p09.signatureInput, /alg="ed25519"/);
  assert.match(d.scenarios.find((s) => s.id === 'P06').payout, /batch ZLR5F7QM5LBQ4 SUCCESS/);
});
