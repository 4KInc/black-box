// A small PDF writer, no dependencies. Text in the PDF standard fonts (Helvetica and its bold and
// oblique, Courier; WinAnsi encoding), measured and word-wrapped; filled and rounded boxes,
// circles, lines and simple vector icons; any number of US Letter pages. Coordinates are in points
// from the TOP-left corner, which is easier to lay out than PDF's bottom-left. Deterministic: the
// same calls give the same bytes.
import { deflateSync } from 'node:zlib';

const W = 612, H = 792;
export const PAGE = Object.freeze({ width: W, height: H, margin: 48, text: W - 96 });

// Glyph widths (1/1000 em) for ASCII 32..126, from the Adobe AFM files; anything else ~556.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const FONTS = {
  regular: { name: 'F1', base: 'Helvetica', widths: HELV },
  bold: { name: 'F2', base: 'Helvetica-Bold', widths: BOLD },
  italic: { name: 'F3', base: 'Helvetica-Oblique', widths: HELV },
  mono: { name: 'F4', base: 'Courier', widths: null },
};
// Widths of the WinAnsi characters above 127 the report uses (Helvetica; close enough for bold).
const HIGH = { 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x85: 1000, 0xb7: 278, 0xd7: 584 };

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

const glyph = (c, font) => (!font.widths ? 600 : c >= 32 && c < 127 ? font.widths[c - 32] : HIGH[c] ?? 556);
const codesWidth = (codes, font, size, tracking = 0) => codes.reduce((w, c) => w + glyph(c, font), 0) * size / 1000 + tracking * codes.length;
export const measure = (text, { font = 'regular', size = 10, tracking = 0 } = {}) => codesWidth(winAnsi(text), FONTS[font], size, tracking);
const pdfString = (codes) => `(${codes.map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : String.fromCharCode(c))).join('')})`;
const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
const n = (v) => Number(v.toFixed(2));

// Splits text into lines (as WinAnsi codes) no wider than `width`; a word longer than a line (a
// hash) is broken.
export function wrap(text, { font = 'regular', size = 10, width = PAGE.text, tracking = 0 } = {}) {
  const f = FONTS[font];
  const fits = (codes) => codesWidth(codes, f, size, tracking) <= width;
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = [];
    for (const word of para.split(/ +/)) {
      let w = winAnsi(word);
      const candidate = line.length ? [...line, 32, ...w] : w;
      if (fits(candidate)) { line = candidate; continue; }
      if (line.length) lines.push(line);
      while (!fits(w)) {
        let k = w.length;
        while (k > 1 && !fits(w.slice(0, k))) k--;
        lines.push(w.slice(0, k));
        w = w.slice(k);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

// The height textBox uses for this text, without drawing it.
export function boxHeight(width, text, { font = 'regular', size = 10, leading = size * 1.45, tracking = 0 } = {}) {
  const k = wrap(text, { font, size, width, tracking }).length;
  return k ? (k - 1) * leading + size * 1.3 : 0;
}

export class PdfDoc {
  #pages = [];
  // y: the flow cursor, in points from the top of the page.
  y = 0;
  constructor({ title = 'Document', footer = () => '', onPage = () => {}, margin = PAGE.margin } = {}) {
    this.title = title;
    this.footer = footer;
    this.onPage = onPage;
    this.margin = margin;
    this.newPage();
  }

  get pageCount() { return this.#pages.length; }
  get left() { return this.margin; }
  get width() { return W - 2 * this.margin; }
  newPage() { this.#pages.push([]); this.y = this.margin; this.onPage(this, this.#pages.length); }
  // Starts a new page unless `height` more points fit above the footer.
  need(height) { if (this.y + height > H - this.margin - 14) this.newPage(); }
  space(points) { this.y += points; }
  #op(s) { this.#pages.at(-1).push(s); }

  // ---------- drawing, absolute (x, y from the top-left) ----------
  rect(x, y, w, h, { fill = null, stroke = null, radius = 0, lineWidth = 0.75 } = {}) {
    const by = H - y - h;
    let path;
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2), k = r * 0.5523;
      const [x0, y0, x1, y1] = [x, by, x + w, by + h];
      path = [`${n(x0 + r)} ${n(y0)} m`, `${n(x1 - r)} ${n(y0)} l`, `${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} c`,
        `${n(x1)} ${n(y1 - r)} l`, `${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c`,
        `${n(x0 + r)} ${n(y1)} l`, `${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} c`,
        `${n(x0)} ${n(y0 + r)} l`, `${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c`, 'h'].join(' ');
    } else path = `${n(x)} ${n(by)} ${n(w)} ${n(h)} re`;
    this.#paint(path, { fill, stroke, lineWidth });
  }

  circle(cx, cy, r, { fill = null, stroke = null, lineWidth = 0.75 } = {}) {
    const k = r * 0.5523, y = H - cy;
    const path = [`${n(cx + r)} ${n(y)} m`, `${n(cx + r)} ${n(y + k)} ${n(cx + k)} ${n(y + r)} ${n(cx)} ${n(y + r)} c`,
      `${n(cx - k)} ${n(y + r)} ${n(cx - r)} ${n(y + k)} ${n(cx - r)} ${n(y)} c`, `${n(cx - r)} ${n(y - k)} ${n(cx - k)} ${n(y - r)} ${n(cx)} ${n(y - r)} c`,
      `${n(cx + k)} ${n(y - r)} ${n(cx + r)} ${n(y - k)} ${n(cx + r)} ${n(y)} c`, 'h'].join(' ');
    this.#paint(path, { fill, stroke, lineWidth });
  }

  line(x1, y1, x2, y2, { color = '#e5e7eb', width = 0.75, cap = 0 } = {}) {
    this.#op(`${rgb(color)} RG ${width} w ${cap} J ${n(x1)} ${n(H - y1)} m ${n(x2)} ${n(H - y2)} l S`);
  }

  #paint(path, { fill, stroke, lineWidth }) {
    if (!fill && !stroke) return;
    this.#op(`${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${lineWidth} w ` : ''}${path} ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }

  // A round badge with a check, a cross or a dash in it, centred on (cx, cy).
  icon(kind, cx, cy, r, { fill, color = '#ffffff' } = {}) {
    this.circle(cx, cy, r, { fill });
    const s = r * 0.5, w = Math.max(1, r * 0.28);
    const stroke = (pts) => this.#op(`${rgb(color)} RG ${n(w)} w 1 J 1 j ${pts.map(([x, y], i) => `${n(cx + x)} ${n(H - (cy + y))} ${i ? 'l' : 'm'}`).join(' ')} S`);
    if (kind === 'check') stroke([[-s, 0], [-s * 0.3, s * 0.7], [s, -s * 0.65]]);
    else if (kind === 'cross') { stroke([[-s * 0.7, -s * 0.7], [s * 0.7, s * 0.7]]); stroke([[-s * 0.7, s * 0.7], [s * 0.7, -s * 0.7]]); }
    else stroke([[-s * 0.7, 0], [s * 0.7, 0]]);
  }

  // One line of text with its baseline at y. align: left (x is the start), right (x is the end),
  // center (x is the middle). tracking: extra points between characters. Returns its width.
  textAt(x, y, text, { font = 'regular', size = 10, color = '#111827', align = 'left', tracking = 0 } = {}) {
    const codes = Array.isArray(text) ? text : winAnsi(text);
    const width = codesWidth(codes, FONTS[font], size, tracking);
    const sx = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    // Tc persists between text objects, so every run sets it, to 0 when there is no tracking.
    this.#op(`BT /${FONTS[font].name} ${size} Tf ${tracking} Tc ${rgb(color)} rg ${n(sx)} ${n(H - y)} Td ${pdfString(codes)} Tj ET`);
    return width;
  }

  // Wrapped text in a box of `width` at (x, y-top); returns the height used. Does not page-break.
  textBox(x, y, width, text, { font = 'regular', size = 10, color = '#111827', leading = size * 1.45, tracking = 0, align = 'left' } = {}) {
    const lines = wrap(text, { font, size, width, tracking });
    lines.forEach((l, i) => this.textAt(align === 'center' ? x + width / 2 : align === 'right' ? x + width : x, y + size + i * leading, l, { font, size, color, tracking, align }));
    return boxHeight(width, text, { font, size, leading, tracking });
  }

  // ---------- flowing text at the cursor ----------
  // Wrapped text at the cursor; long text flows onto new pages.
  text(text, { font = 'regular', size = 10, color = '#111827', indent = 0, width = this.width - indent, leading = size * 1.45, tracking = 0 } = {}) {
    for (const line of wrap(text, { font, size, width, tracking })) {
      this.need(leading);
      this.textAt(this.left + indent, this.y + size, line, { font, size, color, tracking });
      this.y += leading;
    }
  }

  bytes() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const fontIds = Object.fromEntries(Object.values(FONTS).map((f) => [f.name, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`)]));
    const fontRes = Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ');
    const total = this.#pages.length;
    const kids = this.#pages.map((ops, i) => {
      const fy = H - this.margin + 20;
      const foot = [
        `${rgb('#e5e7eb')} RG 0.75 w ${this.margin} ${n(H - fy + 12)} m ${W - this.margin} ${n(H - fy + 12)} l S`,
        `BT /F1 7.5 Tf 0 Tc ${rgb('#6b7280')} rg ${this.margin} ${n(H - fy)} Td ${pdfString(winAnsi(this.footer()))} Tj ET`,
      ];
      const right = winAnsi(`Page ${i + 1} of ${total}`);
      foot.push(`BT /F2 7.5 Tf 0 Tc ${rgb('#6b7280')} rg ${n(W - this.margin - codesWidth(right, FONTS.bold, 7.5))} ${n(H - fy)} Td ${pdfString(right)} Tj ET`);
      const data = deflateSync(Buffer.from([...ops, ...foot].join('\n'), 'latin1'), { level: 9 });
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
