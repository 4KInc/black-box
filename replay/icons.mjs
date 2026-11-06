// A small robot face for each AI model, so a recording or study row is recognisable at a glance.
// Original drawings, not the providers' logos: the colour says who makes the model, and the head,
// eyes and topper tell models apart (a leaf for Haiku, a note for Sonnet, a crown for Opus...).
// Inline SVG only, so pages still load nothing from elsewhere.

// One colour per provider family (the same families as the Provider filter).
const COLOURS = { claude: '#e8875b', gpt: '#4fb89a', gemini: '#6c9bf2', grok: '#a7b0be', muse: '#a98bf0', open: '#8cc56b' };

// First match wins. head: round | square; eyes: dot | happy | star | sleepy | visor;
// top: leaf | note | crown | ball | ring | bolt | twin | spike | spark | ears | swirl | bud.
const LOOKS = [
  [/^claude-haiku-4/, { head: 'round', eyes: 'dot', top: 'leaf' }],
  [/^claude-haiku/, { head: 'round', eyes: 'happy', top: 'leaf' }],
  [/^claude-sonnet/, { head: 'round', eyes: 'happy', top: 'note' }],
  [/^claude-opus/, { head: 'round', eyes: 'star', top: 'crown' }],
  [/^claude/, { head: 'round', eyes: 'dot', top: 'ball' }],
  [/^gpt-4o-mini/, { head: 'square', eyes: 'dot', top: 'ball' }],
  [/^gpt/, { head: 'square', eyes: 'visor', top: 'ring' }],
  [/^gemini-.*flash/, { head: 'round', eyes: 'dot', top: 'bolt' }],
  [/^gemini/, { head: 'round', eyes: 'happy', top: 'twin' }],
  [/^grok-.*non-reasoning/, { head: 'square', eyes: 'sleepy', top: 'spike' }],
  [/^grok/, { head: 'square', eyes: 'dot', top: 'spike' }],
  [/^muse/, { head: 'round', eyes: 'star', top: 'spark' }],
  [/llama-3\.2-1b/i, { head: 'round', eyes: 'dot', top: 'ears' }],
  [/llama/i, { head: 'round', eyes: 'happy', top: 'ears' }],
  [/mistral/i, { head: 'square', eyes: 'happy', top: 'swirl' }],
  [/qwen/i, { head: 'round', eyes: 'dot', top: 'bud' }],
];
const PLAIN = { head: 'square', eyes: 'dot', top: 'ball' };

const EYES = {
  dot: '<circle cx="12.5" cy="18" r="1.9"/><circle cx="19.5" cy="18" r="1.9"/>',
  happy: '<path d="M10.6 18.8q1.9-2.6 3.8 0M17.6 18.8q1.9-2.6 3.8 0" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
  star: '<path d="M12.5 15.4l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8zM19.5 15.4l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8z"/>',
  sleepy: '<path d="M10.7 18.4h3.6M17.7 18.4h3.6" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
  visor: '<rect x="10" y="16.4" width="12" height="3.2" rx="1.6"/>',
};

const TOPS = {
  leaf: '<path d="M16 9V6.5"/><path d="M16 6.8c0-2.6 2-4.3 4.6-4.3 0 2.6-2 4.3-4.6 4.3z" stroke="none"/>',
  note: '<path d="M16 9V3.2l3.6-1.1v2.4L16 5.6"/><circle cx="14.6" cy="8.4" r="1.6" stroke="none"/>',
  crown: '<path d="M11 8.6l1-5 2.6 2.6L16 2.4l1.4 3.8L20 3.6l1 5z" stroke="none"/>',
  ball: '<path d="M16 9V5"/><circle cx="16" cy="3.8" r="1.9" stroke="none"/>',
  ring: '<path d="M16 9V6"/><circle cx="16" cy="3.9" r="2" fill="none"/>',
  bolt: '<path d="M17.2 1.8l-3.6 4.4h2.4l-1.2 3 3.6-4.4H16z" stroke="none"/>',
  twin: '<path d="M12.5 9.4V5.6M19.5 9.4V5.6"/><circle cx="12.5" cy="4.4" r="1.7" stroke="none"/><circle cx="19.5" cy="4.4" r="1.7" stroke="none"/>',
  spike: '<path d="M11 9l1.6-5 1.6 4 1.8-6 1.8 6 1.6-4 1.6 5z" stroke="none"/>',
  spark: '<path d="M16 9V7"/><path d="M16 1.4l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" stroke="none"/>',
  ears: '<path d="M9.6 10.4L8.4 3.2l4.2 5.4zM22.4 10.4l1.2-7.2-4.2 5.4z" stroke="none"/>',
  swirl: '<path d="M16 9V6.6c0-1.8 1.4-3 3-2.6 1.4.4 1.4 2.4 0 2.6" fill="none"/>',
  bud: '<path d="M16 9V6"/><circle cx="14.3" cy="4.4" r="1.5" stroke="none"/><circle cx="17.7" cy="4.4" r="1.5" stroke="none"/><circle cx="16" cy="2.9" r="1.5" stroke="none"/>',
};

export const iconLook = (model) => LOOKS.find(([re]) => re.test(model ?? ''))?.[1] ?? PLAIN;

// family: the model's provider family key (claude, gpt, gemini, grok, muse or open).
export function modelIcon(model, family) {
  const c = COLOURS[family] ?? '#8a8f98';
  const { head, eyes, top } = iconLook(model);
  const shell = head === 'round' ? '<rect x="5" y="9" width="22" height="20" rx="10"/>' : '<rect x="5" y="9" width="22" height="20" rx="5"/>';
  return `<svg class="mi" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true" focusable="false">`
    + `<g fill="${c}" stroke="${c}" stroke-width="1.6" stroke-linecap="round">${TOPS[top]}</g>`
    + `<g fill="${c}">${shell}</g>`
    + `<rect x="8" y="12.5" width="16" height="12" rx="${head === 'round' ? 6 : 3}" fill="#1b1e24"/>`
    + `<g fill="#f4efe6" stroke="#f4efe6">${EYES[eyes]}</g>`
    + `<circle cx="10.4" cy="22" r="1.2" fill="${c}" opacity=".55"/><circle cx="21.6" cy="22" r="1.2" fill="${c}" opacity=".55"/>`
    + '</svg>';
}
