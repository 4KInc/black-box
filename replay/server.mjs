// The replay UI: every recorded purchase, and for each one the verdict, what a person saw next
// to what the agent read, the facts, the rule that fired and what PayPal did. A run where the
// agent bought nothing is shown too, with what it read and why it declined, and no verdict.
//   npm run replay   -> http://localhost:4030
// Cases are re-read on every request, so new agent runs and executed disputes appear on reload.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { judge, loadCases } from './cases.mjs';
import { runBench } from '../bench/bench.mjs';
import { benchPage, casePage, indexPage, judgePage, pageHtml, recordJson, siteIntro, studyPage } from './page.mjs';
import { latestStudies } from './cases.mjs';
import { caseReport, reportName } from './report.mjs';
import { factsPage, labPage, labResult, runLab } from '../lab/lab.mjs';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? process.env.REPLAY_PORT ?? 4030);
const HOST = process.env.HOST ?? '127.0.0.1';
const FONTS = join(import.meta.dirname, 'fonts');

// The recorded page itself, for the iframe: sandboxed, so it gets an opaque origin and cannot
// run scripts, submit forms or navigate; it may only use its own inline CSS and SVG.
const RECORDED = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// Recorded pages are untrusted: no script runs anywhere, and nothing is loaded from elsewhere.
// A recording to download, as JSON.
const RECORD_JSON = (hash) => ({
  'content-type': 'application/json; charset=utf-8',
  'content-disposition': `attachment; filename="black-box-${hash.slice(0, 12)}.json"`,
  'x-content-type-options': 'nosniff',
});

// The case report as a PDF, for a PayPal dispute reviewer.
const REPORT_PDF = (c) => ({
  'content-type': 'application/pdf',
  'content-disposition': `attachment; filename="${reportName(c)}"`,
  'x-content-type-options': 'nosniff',
});
// Where a case page lives, for the report's "check it yourself" line.
const pageUrl = (req, path) => {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return host ? `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}${path}` : null;
};

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// live: the hosted app with live runs. Recordings it made itself (records/, not the committed
// fixtures) are tagged as live runs.
export function createReplay({ root = ROOT, intro = '', live = false } = {}) {
  const cases = () => loadCases(root).map((c) => (live && c.source.startsWith('records/') ? { ...c, live: true } : c));
  return createServer((req, res) => {
    const send = (status, html) => { res.writeHead(status, HEADERS); res.end(html); };
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://replay');
      if (req.method !== 'GET') return send(405, 'Method not allowed');
      const font = pathname.match(/^\/fonts\/([A-Za-z0-9-]+\.woff2)$/);
      if (font && existsSync(join(FONTS, font[1]))) {
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(readFileSync(join(FONTS, font[1])));
      }
      if (pathname === '/') return send(200, indexPage(cases().map((c) => ({ c, j: judge(c, { root }) })), { intro }));
      if (pathname === '/lab') return send(200, labPage(searchParams));
      if (pathname === '/lab/run') return send(200, labResult(root, searchParams));
      if (pathname === '/lab/page') { res.writeHead(200, RECORDED); return res.end(pageHtml(runLab(root, searchParams).c.record)); }
      if (pathname === '/lab/facts') return send(200, factsPage(searchParams));
      if (pathname === '/bench') return send(200, benchPage(runBench(root)));
      if (pathname === '/judge') return send(200, judgePage(runBench(root)));
      if (pathname === '/study') { const st = latestStudies(root); return st.length ? send(200, studyPage(st)) : send(404, 'No study yet: node study/run.mjs'); }
      const b = pathname.match(/^\/bench\/([A-Z]\d{2})(\/page|\/record\.json|\/report\.pdf)?$/);
      const br = b && runBench(root).find((r) => r.def.id === b[1]);
      if (br && b[2] === '/record.json') { res.writeHead(200, RECORD_JSON(br.c.hash)); return res.end(recordJson(br.c.record)); }
      if (br && b[2] === '/report.pdf' && br.j) { res.writeHead(200, REPORT_PDF(br.c)); return res.end(caseReport(br.c, br.j, { caseUrl: pageUrl(req, `/bench/${br.def.id}`) })); }
      if (br && b[2]) { res.writeHead(200, RECORDED); return res.end(pageHtml(br.c.record)); }
      if (br) return send(200, casePage({ ...br.c, benchResult: br }, br.j));
      const m = pathname.match(/^\/case\/([0-9a-f]{64})(\/page|\/record\.json|\/report\.pdf)?$/);
      const c = m && cases().find((x) => x.hash === m[1]);
      if (c && m[2] === '/record.json') { res.writeHead(200, RECORD_JSON(c.hash)); return res.end(recordJson(c.record)); }
      if (c && m[2] === '/report.pdf') {
        const j = judge(c, { root });
        if (!j) return send(404, 'The agent bought nothing, so there is no case to report.');
        res.writeHead(200, REPORT_PDF(c));
        return res.end(caseReport(c, j, { caseUrl: pageUrl(req, `/case/${c.hash}`) }));
      }
      if (c && m[2]) { res.writeHead(200, RECORDED); return res.end(pageHtml(c.record)); }
      if (c) return send(200, casePage(c, judge(c, { root })));
      send(404, 'No such case');
    } catch (e) {
      console.error(e);
      send(500, 'Replay failed; see the server log.');
    }
  });
}

if (import.meta.main) {
  createReplay().listen(PORT, HOST, () => console.log(`replay  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
