import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relativise, withCsp } from '../build.mjs';

test('links become relative to the page, with directory slashes', () => {
  assert.equal(relativise('<a href="/bench">x</a>', 0), '<a href="./bench/">x</a>');
  assert.equal(relativise('<a href="/case/ab#hidden">x</a><iframe src="/case/ab/page">', 2), '<a href="../../case/ab/#hidden">x</a><iframe src="../../case/ab/page/">');
  assert.equal(relativise('<a href="#hidden">x</a><a href="https://github.com/x">y</a>', 2), '<a href="#hidden">x</a><a href="https://github.com/x">y</a>');
});

test('the CSP meta goes first in <head>', () => {
  assert.match(withCsp('<html><head><script>1</script></head>', "default-src 'none'"), /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><script>/);
});

test('the built site: every page has a CSP, no script, no absolute link, and the bench passes', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  const log = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'build.mjs'), out], { encoding: 'utf8' });
  assert.match(log, /29 bench cases \(29 pass\)|bench cases \((\d+) pass\)/);
  const pages = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === 'index.html') pages.push(p); } };
  walk(out);
  assert.ok(pages.length > 50);
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/, p);
    assert.doesNotMatch(html, /<script(?![^>]*application\/ld\+json)/i, p);
    assert.doesNotMatch(html, /(?:href|src)="\/[^/]/, p);
  }
  for (const p of pages.filter((x) => x.endsWith(join('page', 'index.html')))) {
    assert.doesNotMatch(readFileSync(p, 'utf8'), /frame-src/, p); // recorded pages cannot frame anything
  }
});
