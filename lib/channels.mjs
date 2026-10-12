// What the agent reads from a page, and nothing else: JSON-LD, meta tags, and textContent.
// textContent ignores CSS, so text hidden with display:none IS read; that is the point.
// <script> and <style> bodies are excluded from text (JSON-LD is given separately).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const normalize = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

export function stripTags(html) {
  return normalize(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '));
}

export function jsonLdBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { /* malformed JSON-LD is ignored, as a crawler would */ }
  }
  return out;
}

export function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"\s*\/?>/gi)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

export function readChannels(html) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return { jsonLd: jsonLdBlocks(html), meta: metaTags(html), text: stripTags(body) };
}

// The exact text block for one page in the model input.
export function pageForModel(url, html) {
  const c = readChannels(html);
  return [
    `=== PAGE ${url} ===`,
    'STRUCTURED DATA (JSON-LD):',
    ...c.jsonLd.map((j) => JSON.stringify(j, null, 2)),
    'META:',
    ...Object.entries(c.meta).map(([k, v]) => `${k}: ${v}`),
    'TEXT:',
    c.text,
  ].join('\n');
}
