// A small PDF writer, no dependencies: text in the PDF standard fonts (Helvetica, Helvetica-Bold,
// Courier, WinAnsi encoding), word-wrapped, with filled boxes and rules, over as many US Letter
// pages as the text needs. Output is deterministic: the same calls give the same bytes.
import { deflateSync } from 'node:zlib';

const W = 612, H = 792, MARGIN = 54;
export const PAGE = Object.freeze({ width: W, height: H, margin: MARGIN, text: W - 2 * MARGIN });

// Glyph widths (1/1000 em) for ASCII 32..126, from the Adobe AFM files; anything else ~556.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const FONTS = { regular: { name: 'F1', base: 'Helvetica', widths: HELV }, bold: { name: 'F2', base: 'Helvetica-Bold', widths: BOLD }, mono: { name: 'F3', base: 'Courier', widths: null } };

// Unicode to WinAnsi: the typographic characters the report uses, and a plain fallback for the rest.
const WIN = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85, ' ': 0x20, '·': 0xb7, '×': 0xd7, 'é': 0xe9 };
const FALLBACK = { '→': '->', '←': '<-', '↓': 'v', '≤': '<=', '≥': '>=', '≠': '!=', '✓': 'yes', '✗': 'no', '●': '*' };
export function winAnsi(text) {
  const out = [];
  for (const ch of String(text).normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (WIN[ch] !== undefined) out.push(WIN[ch]);
    else if (FALLBACK[ch]) for (const f of FALLBACK[ch]) out.push(f.charCodeAt(0));
    else if (c === 9) out.push(32);
    else if (c > 160 && c < 256) out.push(c);
    else out.push(63); // '?'
  }
  return out;
}

const widthOf = (codes, font, size) => codes.reduce((w, c) => w + (font.widths ? (c >= 32 && c < 127 ? font.widths[c - 32] : 556) : 600), 0) * size / 1000;
const pdfString = (codes) => `(${codes.map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : String.fromCharCode(c))).join('')})`;
const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

// Splits text into lines no wider than `width`; a word longer than a line (a hash) is broken.
export function wrap(text, { font = 'regular', size = 10, width = PAGE.text } = {}) {
  const f = FONTS[font];
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = [];
    for (const word of para.split(/ +/)) {
      let w = winAnsi(word);
      const candidate = line.length ? [...line, 32, ...w] : w;
      if (widthOf(candidate, f, size) <= width) { line = candidate; continue; }
      if (line.length) lines.push(line);
      while (widthOf(w, f, size) > width) {
        let n = w.length;
        while (n > 1 && widthOf(w.slice(0, n), f, size) > width) n--;
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

export class PdfDoc {
  #pages = [];
  #y = 0;
  constructor({ title = 'Document', footer = () => '' } = {}) {
    this.title = title;
    this.footer = footer;
    this.newPage();
  }

  get y() { return this.#y; }
  newPage() { this.#pages.push([]); this.#y = H - MARGIN; }
  #ops() { return this.#pages.at(-1); }
  // Starts a new page unless `height` more points fit above the footer.
  need(height) { if (this.#y - height < MARGIN + 18) this.newPage(); }
  space(points) { this.#y -= points; }

  #textAt(x, y, codes, { font = 'regular', size = 10, color = '#1a1a1a' } = {}) {
    this.#ops().push(`BT /${FONTS[font].name} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(codes)} Tj ET`);
  }

  // Wrapped text at the current position; long text flows onto new pages.
  text(text, { font = 'regular', size = 10, color = '#1a1a1a', indent = 0, width = PAGE.text - indent, leading = size * 1.4 } = {}) {
    for (const line of wrap(text, { font, size, width })) {
      this.need(leading);
      this.#y -= leading;
      this.#textAt(MARGIN + indent, this.#y + (leading - size) * 0.5, line, { font, size, color });
    }
  }

  rule({ color = '#cccccc', gap = 8 } = {}) {
    this.need(gap * 2);
    this.#y -= gap;
    this.#ops().push(`${rgb(color)} RG 0.6 w ${MARGIN} ${this.#y.toFixed(2)} m ${W - MARGIN} ${this.#y.toFixed(2)} l S`);
    this.#y -= gap;
  }

  // A filled box with a title and a body, e.g. the verdict banner.
  box(title, body, { fill = '#f2f2f2', color = '#1a1a1a', titleSize = 16, size = 10 } = {}) {
    const pad = 12;
    const inner = PAGE.text - 2 * pad;
    const tl = wrap(title, { font: 'bold', size: titleSize, width: inner });
    const bl = body ? wrap(body, { size, width: inner }) : [];
    const height = pad * 2 + tl.length * titleSize * 1.25 + (bl.length ? 6 + bl.length * size * 1.4 : 0);
    this.need(height + 6);
    const top = this.#y;
    this.#ops().push(`${rgb(fill)} rg ${MARGIN} ${(top - height).toFixed(2)} ${PAGE.text} ${height.toFixed(2)} re f`);
    let y = top - pad;
    for (const l of tl) { y -= titleSize * 1.25; this.#textAt(MARGIN + pad, y + titleSize * 0.2, l, { font: 'bold', size: titleSize, color }); }
    if (bl.length) y -= 6;
    for (const l of bl) { y -= size * 1.4; this.#textAt(MARGIN + pad, y + size * 0.2, l, { size, color }); }
    this.#y = top - height - 6;
  }

  // Two columns: a bold label and wrapped text, one row per pair.
  rows(pairs, { labelWidth = 150, size = 9.5 } = {}) {
    const valueWidth = PAGE.text - labelWidth;
    for (const [label, value, opts = {}] of pairs) {
      const ll = wrap(label, { font: 'bold', size, width: labelWidth - 10 });
      const vl = wrap(value, { font: opts.font ?? 'regular', size, width: valueWidth });
      const leading = size * 1.4;
      const n = Math.max(ll.length, vl.length);
      this.need(n * leading + 3);
      for (let i = 0; i < n; i++) {
        this.#y -= leading;
        if (ll[i]) this.#textAt(MARGIN, this.#y + leading * 0.15, ll[i], { font: 'bold', size, color: '#444444' });
        if (vl[i]) this.#textAt(MARGIN + labelWidth, this.#y + leading * 0.15, vl[i], { font: opts.font ?? 'regular', size, color: opts.color ?? '#1a1a1a' });
      }
      this.#y -= 3;
    }
  }

  bytes() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const fontIds = Object.fromEntries(Object.values(FONTS).map((f) => [f.name, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`)]));
    const fontRes = Object.entries(fontIds).map(([n, id]) => `/${n} ${id} 0 R`).join(' ');
    const total = this.#pages.length;
    const kids = this.#pages.map((ops, i) => {
      const foot = winAnsi(`${this.footer()}${this.footer() ? '  ·  ' : ''}page ${i + 1} of ${total}`);
      const all = [...ops, `BT /F1 8 Tf ${rgb('#777777')} rg ${MARGIN} ${MARGIN - 20} Td ${pdfString(foot)} Tj ET`].join('\n');
      const data = deflateSync(Buffer.from(all, 'latin1'), { level: 9 });
      const content = add({ stream: data });
      return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << ${fontRes} >> >> /Contents ${content} 0 R >>`);
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${total} >>`;
    const info = add(`<< /Title ${pdfString(winAnsi(this.title))} /Producer (Black Box) >>`);

    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let length = parts[0].length;
    objects.forEach((o, i) => {
      offsets.push(length);
      const buf = o.stream
        ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
        : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      parts.push(buf);
      length += buf.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}
