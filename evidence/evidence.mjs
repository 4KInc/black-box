// The note Black Box sends PayPal with its evidence, when the verdict is USER (the purchase was
// within what the buyer authorised).
//
// Code decides what the note may say: statementsFor() turns the engine's result into a short list
// of plain sentences, each one read straight off the facts, the record or PayPal. An AI may then
// rephrase them into a note a reviewer can read in half a minute, and checkNote() rejects any
// note that brings in a number, amount, ID or SKU the statements do not contain, accuses anyone,
// or runs too long. A rejected or failed AI note falls back to the statements themselves, so the
// note never depends on the AI. The statements always go to PayPal as well, with the record.

import { VERDICT } from '../engine/verdict.mjs';
import { anthropic } from '../agent/llm.mjs';

export const NARRATOR_MODEL = 'claude-sonnet-5-5';
export const NOTE_MAX = 1500; // PayPal's evidence notes allow 2000 characters; the footer needs the rest

const money = (c) => `$${(c / 100).toFixed(2)}`;
const attrs = (a = {}) => Object.entries(a).map(([k, v]) => `${k} ${v}`).join(', ');

const BY_REASON = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: (s) => `The order is for the exact item and price on the merchant's signed listing (SKU ${s.sku}).`,
  INCORRECT_AMOUNT: (s) => (s.captured === s.price ? `The amount PayPal captured, ${money(s.captured)}, equals the signed listing price.` : null),
  UNAUTHORISED: () => "The purchase was made by the buyer's own agent, under the authorisation above.",
};

// j = evaluateCase() result (or judge()); hash = the record hash; reason = PayPal dispute reason.
// Returns null unless the verdict is USER: the other verdicts refund, so they send no evidence.
export function statementsFor({ record, j, hash, reason }) {
  if (j.verdict.verdict !== VERDICT.USER) return null;
  const m = record.mandate;
  const p = j.product ?? { name: record.purchase.sku, sku: record.purchase.sku, priceCents: record.purchase.price_cents, attributes: {} };
  const captured = j.order.capturedCents;
  const pages = record.fetches.length;
  const decision = (record.decisions ?? []).findLast((d) => d.action === 'buy');
  const contradicting = j.findings.some((f) => f.inModelInput && f.namesPurchasedItem && f.contradictsListing);

  const out = [
    `The buyer authorised an AI shopping agent to buy a ${m.item?.category ?? 'product'}${attrs(m.item?.attributes) ? ` (${attrs(m.item.attributes)})` : ''} for at most ${money(m.maxTotalCents)} ${m.currency}${m.signedShopsOnly ? ', from shops that sign their pages' : ''}.`,
    j.mandateAuth?.legacy
      ? 'The order was placed before the buyer enrolled a passkey, so this authorisation is not passkey-signed.'
      : 'The buyer approved that limit with the passkey enrolled for the paying PayPal account; the signature covers the exact limit.',
    `The agent bought "${p.name}" (SKU ${p.sku})${attrs(p.attributes) ? `, ${attrs(p.attributes)}` : ''}, listed at ${money(p.priceCents)} on the merchant's signed product page. PayPal captured ${money(captured)}.`,
    `${money(captured)} is within the ${money(m.maxTotalCents)} limit, and the item matches what the buyer asked for.`,
    `All ${pages} pages the agent read carry a valid merchant signature, made with the key published on the shop's own domain before the PayPal order was created.`,
    !contradicting && !j.facts.unattributedHiddenText && !j.facts.aiInjectionFlag
      ? "Nothing hidden in what the agent read stated a different price for this item or told the agent to ignore the buyer's limits."
      : null,
    decision?.reason ? `The agent's recorded reason: "${decision.reason.slice(0, 400)}"` : null,
    BY_REASON[reason]?.({ sku: p.sku, captured, price: p.priceCents }) ?? null,
    `The attached record shows every page the agent read and the exact text the model received. Its SHA-256 hash, ${hash}, equals the custom_id on this PayPal order, set at checkout.`,
    'The verdict comes from fixed rules applied by code, so anyone with the record can re-run them and get the same result.',
  ];
  return out.filter(Boolean);
}

export const templateNote = (statements) => statements.filter((s) => !s.startsWith("The agent's recorded reason")).join(' ').slice(0, NOTE_MAX);

// Tokens a note must not invent: hashes, anything with a digit (amounts, dates, IDs) and SKUs.
const TOKENS = /\b[0-9a-f]{12,}\b|\$?\d[\d,.:/-]*\d|\$?\d|\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b/g;
const tokens = (s) => (String(s).match(TOKENS) ?? []).map((t) => t.replace(/^\$/, '').replace(/[.,]$/, ''));
const BLAME = /\b(fraud\w*|scam\w*|lie[sd]?|lying|deceiv\w*|deceptive|malicious|guarantee\w*|criminal|stole\w*)\b/i;

export function checkNote(note, statements) {
  const text = String(note ?? '').trim();
  if (text.length < 120) return { ok: false, why: 'too short' };
  if (text.length > NOTE_MAX) return { ok: false, why: `longer than ${NOTE_MAX} characters` };
  const blame = text.match(BLAME);
  if (blame) return { ok: false, why: `uses "${blame[0]}", which no statement supports` };
  const allowed = new Set(tokens(statements.join(' ')));
  const invented = [...new Set(tokens(text))].filter((t) => !allowed.has(t));
  if (invented.length) return { ok: false, why: `states ${invented.slice(0, 5).join(', ')}, which no statement contains` };
  return { ok: true };
}

export const NARRATOR_SYSTEM = `You write the note a merchant sends a PayPal dispute reviewer with its evidence.
You are given numbered statements. They are the only facts you have.
Write 90 to 160 words of plain English that a reviewer can read in thirty seconds: what the buyer
authorised, what was bought, why it is within that authorisation, and what the attached record is.
Rules: use only the statements. Add no fact, number, amount, name, date or ID that is not in them,
and copy amounts and IDs exactly. Do not accuse anyone or speculate about intent. You may leave
statements out. Reply with the note only, no heading.`;

// Returns { text, source: 'ai' | 'template', model, rejected }.
export async function evidenceNote(statements, { llm = anthropic, model = NARRATOR_MODEL } = {}) {
  const fallback = (rejected) => ({ text: templateNote(statements), source: 'template', model: null, rejected });
  let reply;
  try {
    reply = await llm({ system: NARRATOR_SYSTEM, user: statements.map((s, i) => `${i + 1}. ${s}`).join('\n'), model, maxTokens: 500 });
  } catch (e) {
    return fallback(`narrator failed: ${e.message}`);
  }
  const text = String(reply.text ?? '').trim();
  const check = checkNote(text, statements);
  return check.ok ? { text, source: 'ai', model: reply.model ?? model, rejected: null } : { ...fallback(check.why), draft: text };
}

// The text file PayPal receives: the note, the statements it was written from, then the record.
export function evidenceFile({ note, statements, record }) {
  return [
    'BLACK BOX EVIDENCE',
    '',
    note.text,
    '',
    `Established by code (the note above ${note.source === 'ai' ? 'was worded by an AI from these statements and checked against them' : 'is these statements'}):`,
    ...statements.map((s, i) => `${i + 1}. ${s}`),
    '',
    '--- The sealed record (JSON) ---',
    JSON.stringify(record, null, 2),
  ].join('\n');
}
