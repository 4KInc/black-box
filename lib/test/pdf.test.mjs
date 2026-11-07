// The PDF writer: a well-formed file (every xref offset points at its object), text that wraps
// within the page and flows onto new pages, and WinAnsi text with nothing unescaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PAGE, PdfDoc, winAnsi, wrap } from '../pdf.mjs';

const contents = (pdf) => [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));

test('the file is well formed: header, every xref offset at its object, startxref at the xref', () => {
  const doc = new PdfDoc({ title: 'T (1)', footer: () => 'foot' });
  doc.rect(48, 48, 100, 40, { fill: '#eeeeee', radius: 6 });
  doc.icon('check', 60, 60, 6, { fill: '#15803d' });
  doc.text('Hello');
  const pdf = doc.bytes();
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  const xrefAt = Number(s.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.equal(s.slice(xrefAt, xrefAt + 5), 'xref\n');
  const offsets = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(offsets.length >= 7);
  offsets.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`));
  assert.match(s, /\/Title \(T \\\(1\\\)\)/, 'parentheses in strings are escaped');
});

test('the same calls give the same bytes', () => {
  const make = () => { const d = new PdfDoc({ title: 'x' }); d.text('same'); return d.bytes(); };
  assert.ok(make().equals(make()));
});

test('text wraps within the page width, a long hash is broken, and long text flows onto new pages', () => {
  const hash = 'a'.repeat(200);
  for (const line of wrap(`word ${hash} word`, { font: 'mono', size: 10 })) assert.ok(line.length * 6 <= PAGE.text + 0.01);
  assert.ok(wrap(hash, { font: 'mono', size: 10 }).length >= 2);
  const doc = new PdfDoc({ footer: () => 'f' });
  for (let i = 0; i < 120; i++) doc.text(`line ${i}`);
  const pages = contents(doc.bytes());
  assert.ok(pages.length >= 2);
  assert.match(pages[0], /\(f\) Tj/, 'each page has its footer');
  assert.match(pages[0], new RegExp(`\\(Page 1 of ${pages.length}\\) Tj`), 'and its page count');
});

test('letter-spacing is set on every text run, so it never leaks into the next one', () => {
  const doc = new PdfDoc();
  doc.textAt(48, 100, 'SPACED', { tracking: 1.5 });
  doc.textAt(48, 120, 'plain');
  const ops = contents(doc.bytes())[0];
  assert.match(ops, /1\.5 Tc [^\n]*\(SPACED\) Tj/);
  assert.match(ops, /0 Tc [^\n]*\(plain\) Tj/);
});

test('text is WinAnsi: typographic quotes and dashes kept, unknown characters replaced, never raw bytes', () => {
  assert.deepEqual(winAnsi('\u201cok\u201d \u2014 \u2192'), [0x93, 111, 107, 0x94, 32, 0x97, 32, 45, 62]);
  assert.deepEqual(winAnsi('\u4e2d'), [63]);
  const doc = new PdfDoc();
  doc.text('price \u201c$119\u201d \\ (agents)');
  assert.match(contents(doc.bytes())[0], /\(price \\223\$119\\224 \\\\ \\\(agents\\\)\) Tj/);
});
