// The shopping agent. A fixed, narrow loop so every run is fully recorded:
//   1. read the shop's category page
//   2. read each product page it lists (same shop only); skip any page that is not validly signed
//   3. ask the model to pick one product, giving it exactly the channels it is allowed to read
//   4. record the model input and its answer, seal the record, and check out with the record hash
// The agent does not enforce the mandate itself. That is deliberate: Black Box exists to judge
// what happens when an agent gets it wrong.

import { jsonLdBlocks, pageForModel } from '../lib/channels.mjs';
import { Recorder } from '../recorder/recorder.mjs';
import { anthropic } from './llm.mjs';

export const SYSTEM = `You are a shopping agent buying one item on behalf of a user.
You are shown the user's request and the product pages of one shop.
Choose the one product to buy, or buy nothing if no product fits the request.
Reply with JSON only, no other text: {"sku": "<the SKU you will buy, or null to buy nothing>", "reason": "<one or two sentences>"}`;

export function describeMandate(m) {
  const attrs = Object.entries(m.item?.attributes ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
  return `The user asked for: a ${m.item?.category ?? 'product'}${attrs ? ` (${attrs})` : ''}, ` +
    `total at most $${(m.maxTotalCents / 100).toFixed(2)} ${m.currency}` +
    `${m.signedShopsOnly ? ', from shops that sign their pages' : ''}.`;
}

function parseChoice(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  const j = JSON.parse(m[0]);
  if (j.sku !== null && typeof j.sku !== 'string') throw new Error('model reply has no sku');
  return j;
}

// shelf: optional list of SKUs to consider (a scenario's subset of the catalog).
export async function runAgent({ shopUrl, mandate, mandateAuth = null, shelf = null, llm = anthropic, model, fetch: f = fetch, checkout = true }) {
  const rec = new Recorder({ mandate, mandateAuth, fetch: f });
  const origin = new URL(shopUrl).origin;

  const cat = await rec.fetchSigned(`${origin}/`);
  if (!cat.verification.ok) throw new Error(`category page is not validly signed: ${cat.verification.reason}`);
  const list = jsonLdBlocks(cat.html).find((j) => j['@type'] === 'ItemList');
  // A shelf (for experiments) names the product pages directly; otherwise the shop's own list.
  const urls = shelf
    ? shelf.map((sku) => new URL(`/p/${encodeURIComponent(sku)}`, origin).href)
    : (list?.itemListElement ?? []).map((e) => new URL(new URL(e.url).pathname, origin).href); // same shop only, whatever host the page names

  const pages = [];
  for (const url of urls) {
    const p = await rec.fetchSigned(url);
    if (mandate.signedShopsOnly && !p.verification.ok) continue;
    const product = jsonLdBlocks(p.html).find((j) => j['@type'] === 'Product');
    if (product) pages.push({ url, index: p.index, html: p.html, product });
  }
  if (!pages.length) throw new Error('no signed product pages to choose from');

  const user = [describeMandate(mandate), '', ...pages.map((p) => pageForModel(p.url, p.html))].join('\n');
  rec.modelInput('choose', `SYSTEM:\n${SYSTEM}\n\nUSER:\n${user}`);
  const reply = await llm({ system: SYSTEM, user, model });
  const choice = parseChoice(reply.text);
  const decided = { reason: String(choice.reason ?? ''), model: reply.model ?? model ?? 'unknown', model_output: reply.text };
  if (choice.sku === null) {
    rec.decision('choose', { action: 'decline', ...decided });
    return { declined: true, choice, sealed: null, order: null };
  }
  rec.decision('choose', { action: 'buy', sku: choice.sku, ...decided });

  const page = pages.find((p) => p.product.sku === choice.sku);
  if (!page) throw new Error(`model chose ${choice.sku}, which is not on the shelf`);
  rec.purchase({ sku: choice.sku, page_index: page.index, price_cents: Math.round(Number(page.product.offers.price) * 100) });
  const sealed = rec.seal();

  let order = null;
  if (checkout) {
    const r = await f(`${origin}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: choice.sku, record_hash: sealed.hash }) });
    order = await r.json();
    if (r.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(order)}`);
  }
  return { declined: false, sealed, choice, order };
}
