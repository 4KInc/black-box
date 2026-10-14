// Builds the read-only Black Box site: the replay of every committed case, and the case bench.
//   node site/build.mjs [outDir]       (default _site/)
// It uses only fixtures/recorded/ (no local records, no keys), so anyone can rebuild it and get
// the same pages. GitHub Pages cannot send headers, so every page carries its Content Security
// Policy in a <meta> tag, and recorded shop pages are only ever shown in a sandboxed iframe.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBench } from '../bench/bench.mjs';
import { judge, loadCases } from '../replay/cases.mjs';
import { benchPage, casePage, indexPage, pageHtml } from '../replay/page.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = process.argv[2] ?? join(ROOT, '_site');

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'";
const RECORDED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

// Absolute links ("/case/…") become relative to the page, so the site works under any path
// (GitHub Pages serves it at /black-box/). Directory links get a trailing slash.
export function relativise(html, depth) {
  const up = depth ? '../'.repeat(depth) : './';
  return html.replace(/(href|src)="\/([^"]*)"/g, (_, attr, path) => {
    const [p, frag = ''] = path.split('#');
    const dir = p === '' || p.endsWith('/') ? p : `${p}/`;
    return `${attr}="${up}${dir}${frag ? '#' + frag : ''}"`;
  });
}

// Puts a CSP <meta> first in <head>, before anything the page itself contains.
export function withCsp(html, csp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + meta) : meta + html;
}

function write(path, html, depth, csp = PAGE_CSP) {
  const file = join(OUT, path, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withCsp(relativise(html, depth), csp));
}

const INTRO = `<section class="card verdict MERCHANT"><div>
<div class="k">Black Box · PayPal sandbox · read-only replay, no keys needed</div>
<div class="v">Who pays when an AI agent buys the wrong thing?</div>
<p class="why" style="margin-top:8px">Black Box records what a shopping agent saw and decided, seals it into the PayPal order,
and when the buyer disputes, code (not an AI) decides: <b>USER</b>, <b>AGENT</b>, <b>MERCHANT</b> or <b>NEEDS A HUMAN</b>.
PayPal then carries the outcome out. Every case below is a real recorded run.</p>
<p class="why">Live in the PayPal sandbox: the cases marked with a PayPal dispute were refunded through the Disputes API,
the last two by the autopilot from PayPal's own webhook, with no one at the keyboard.
<a href="/bench">The case bench</a> runs every verdict, every rule and ten attacks on the record.</p>
<p class="why">Source: <a href="https://github.com/4KInc/black-box">github.com/4KInc/black-box</a></p></div></section>`;

// A scratch root holding only what is committed: the fixtures, and the buyer's enrolled
// passkey (public key) in the registry the replay reads.
const root = mkdtempSync(join(tmpdir(), 'blackbox-site-'));
try {
  cpSync(join(ROOT, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  const enrolment = JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', 'passkey-enrolment.json'), 'utf8'));
  mkdirSync(join(root, 'records', 'passkeys'), { recursive: true });
  writeFileSync(join(root, 'records', 'passkeys', `${enrolment.payer_id}.json`), JSON.stringify(enrolment));

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, '.nojekyll'), '');

  const cases = loadCases(root).map((c) => ({ c, j: judge(c, { root }) }));
  write('', indexPage(cases, { intro: INTRO }), 0);
  for (const { c, j } of cases) {
    write(`case/${c.hash}`, casePage(c, j), 2);
    write(`case/${c.hash}/page`, pageHtml(c.record), 3, RECORDED_CSP);
  }

  const bench = runBench(root);
  write('bench', benchPage(bench), 1);
  for (const r of bench) {
    write(`bench/${r.def.id}`, casePage({ ...r.c, benchResult: r }, r.j), 2);
    write(`bench/${r.def.id}/page`, pageHtml(r.c.record), 3, RECORDED_CSP);
  }
  const failed = bench.filter((r) => !r.pass).length;
  console.log(`site     ${OUT}\ncases    ${cases.length} replays, ${bench.length} bench cases (${bench.length - failed} pass)`);
  if (failed) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
