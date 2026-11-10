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

// What each reason's evidence may claim: authorisation, the amount, and that the item matches the
// signed listing, which the record shows. Never delivery or condition, which it cannot.
const BEYOND_THE_RECORD = /\b(deliver\w*|ship(ped|ping|ment)?|arriv\w*|tracking|courier|condition|damag\w*|undamaged|defect\w*|working order|good order|in stock)\b/i;
const REASON_CLAIM = {
  UNAUTHORISED: /buyer's own agent, under the authorisation above/,
  INCORRECT_AMOUNT: /captured, \$129\.00, equals the signed listing price/,
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: /exact item and price on the merchant's signed listing/,
};
for (const [reason, claim] of Object.entries(REASON_CLAIM)) {
  test(`${reason}: the evidence claims only what the record shows`, () => {
    const s = statementsFor({ ...HONEST, reason });
    const all = s.join('\n');
    assert.match(all, claim);
    assert.doesNotMatch(all, BEYOND_THE_RECORD);
    // "received" appears only for the text the model received, never for the item.
    assert.deepEqual(all.match(/\breceiv\w*/gi), ['received']);
    assert.match(all, /the exact text the model received/);
    // The other reasons' claims are not made.
    for (const [other, c] of Object.entries(REASON_CLAIM)) if (other !== reason) assert.doesNotMatch(all, c, other);
  });
}

test('a reason outside the three gets no evidence statements at all', () => {
  for (const reason of ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'DUPLICATE_TRANSACTION', 'CREDIT_NOT_PROCESSED', 'OTHER', undefined]) {
    assert.equal(statementsFor({ ...HONEST, reason }), null, String(reason));
  }
});
