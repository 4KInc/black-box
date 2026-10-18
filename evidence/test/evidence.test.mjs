import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkNote, evidenceFile, evidenceNote, NOTE_MAX, statementsFor, templateNote } from '../evidence.mjs';
import { judge } from '../../replay/cases.mjs';
import { recordHash } from '../../recorder/recorder.mjs';

const root = join(import.meta.dirname, '..', '..');
const fixture = (n) => JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', n), 'utf8'));
const caseOf = (n, reason) => {
  const record = fixture(n);
  const hash = recordHash(record);
  const j = judge({ hash, record, paypal: null }, { root });
  return { record, hash, j, reason: reason ?? j.reason };
};
const HONEST = caseOf('sonnet55-honest.json');
const S = statementsFor(HONEST);
const reply = (text) => async () => ({ text, model: 'scripted' });

test('a USER case gets statements read off the record and PayPal; other verdicts get none', () => {
  assert.equal(HONEST.j.verdict.verdict, 'USER');
  const all = S.join('\n');
  for (const want of ['$150.00', '$129.00', 'RJ-BLUE-M', HONEST.hash, 'not passkey-signed']) assert.ok(all.includes(want), want);
  assert.equal(statementsFor(caseOf('haiku45-merchant-jsonld.json')), null);
});

test('the dispute reason adds the matching statement', () => {
  assert.match(statementsFor({ ...HONEST, reason: 'INCORRECT_AMOUNT' }).join(' '), /captured, \$129\.00, equals the signed listing price/);
  assert.match(statementsFor({ ...HONEST, reason: 'UNAUTHORISED' }).join(' '), /buyer's own agent/);
});

test('the template note passes its own check and fits PayPal', () => {
  const t = templateNote(S);
  assert.ok(t.length <= NOTE_MAX);
  assert.deepEqual(checkNote(t, S), { ok: true });
});

test('a note that invents an amount, SKU, hash or accusation is rejected', () => {
  const base = 'The buyer authorised an agent to buy a blue rain jacket for at most $150.00, and it bought the Coastline Rain Jacket for $129.00. ';
  assert.equal(checkNote(base + 'That is well within the limit.', S).ok, true);
  assert.match(checkNote(base + 'The buyer later got a $20.00 coupon.', S).why, /20\.00/);
  assert.match(checkNote(base + 'It was SKU RJ-RED-L.', S).why, /RJ-RED-L/);
  assert.match(checkNote(base + `Record ${HONEST.hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}.`, S).why, /no statement contains/);
  assert.match(checkNote(base + 'The buyer is committing fraud.', S).why, /fraud/);
  assert.match(checkNote('Fine.', S).why, /too short/);
  assert.match(checkNote(base.repeat(20), S).why, /longer/);
});

test('the AI note is used only when it passes; otherwise the statements are sent', async () => {
  const good = 'The buyer authorised an AI agent to buy a blue rain jacket, size M, for at most $150.00. It bought the Coastline Rain Jacket (SKU RJ-BLUE-M) at the signed price of $129.00, which is within that limit. The attached record is the evidence.';
  const ok = await evidenceNote(S, { llm: reply(good) });
  assert.equal(ok.source, 'ai');
  assert.equal(ok.text, good);
  const bad = await evidenceNote(S, { llm: reply(good + ' PayPal should also refund $10.00 in fees.') });
  assert.equal(bad.source, 'template');
  assert.match(bad.rejected, /10\.00/);
  assert.equal(bad.text, templateNote(S));
  const down = await evidenceNote(S, { llm: async () => { throw new Error('offline'); } });
  assert.equal(down.source, 'template');
  assert.match(down.rejected, /offline/);
});

test('the evidence file carries the note, the numbered statements and the whole record', () => {
  const note = { text: templateNote(S), source: 'template' };
  const f = evidenceFile({ note, statements: S, record: HONEST.record });
  assert.ok(f.startsWith('BLACK BOX EVIDENCE'));
  assert.ok(f.includes(`1. ${S[0]}`));
  assert.deepEqual(JSON.parse(f.slice(f.indexOf('--- The sealed record (JSON) ---') + 33)), HONEST.record);
});
