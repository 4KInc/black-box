// The replay UI: every recorded purchase, and for each one the verdict, what a person saw next
// to what the agent read, the facts, the rule that fired and what PayPal did.
//   npm run replay   -> http://localhost:4030
// Cases are re-read on every request, so new agent runs and executed disputes appear on reload.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { judge, loadCases } from './cases.mjs';
import { runBench } from '../bench/bench.mjs';
import { benchPage, casePage, indexPage, pageHtml, siteIntro, studyPage } from './page.mjs';
import { latestStudies } from './cases.mjs';
import { factsPage, labPage, labResult } from '../lab/lab.mjs';

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
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function createReplay({ root = ROOT, intro = '' } = {}) {
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
      if (pathname === '/') return send(200, indexPage(loadCases(root).map((c) => ({ c, j: judge(c, { root }) })), { intro }));
      if (pathname === '/lab') return send(200, labPage());
      if (pathname === '/lab/run') return send(200, labResult(root, searchParams));
      if (pathname === '/lab/facts') return send(200, factsPage(searchParams));
      if (pathname === '/bench') return send(200, benchPage(runBench(root)));
      if (pathname === '/study') { const st = latestStudies(root); return st.length ? send(200, studyPage(st)) : send(404, 'No study yet: node study/run.mjs'); }
      const b = pathname.match(/^\/bench\/([A-Z]\d{2})(\/page)?$/);
      const br = b && runBench(root).find((r) => r.def.id === b[1]);
      if (br && b[2]) { res.writeHead(200, RECORDED); return res.end(pageHtml(br.c.record)); }
      if (br) return send(200, casePage({ ...br.c, benchResult: br }, br.j));
      const m = pathname.match(/^\/case\/([0-9a-f]{64})(\/page)?$/);
      const c = m && loadCases(root).find((x) => x.hash === m[1]);
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
