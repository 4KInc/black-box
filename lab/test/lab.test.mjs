import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { factsPage, labPage, labResult, runLab } from '../lab.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const run = (q) => runLab(ROOT, new URLSearchParams(q));
const got = (r) => [r.j.verdict.verdict, r.j.verdict.rule];

test('with nothing changed, the lab gives the bench case its own verdict', () => {
  assert.deepEqual(got(run('case=R03')), ['MERCHANT', 2]);
  assert.deepEqual(got(run('case=R12')), ['AGENT', 5]);
});

test('editing the stored page breaks the record, whatever the attacker intended', () => {
  const r = run('case=R03&t=edit-page');
  assert.deepEqual(got(r), ['NEEDS_A_HUMAN', 1]);
  assert.equal(r.j.facts.hashesMatch, false);
});

test('a budget raised after approval: caught by the passkey, or by the custom_id', () => {
  assert.equal(run('case=P03&t=raise-cap&before=1').j.facts.mandateSigned, false);
  assert.equal(run('case=P03&t=raise-cap').j.facts.hashesMatch, false);
});

test('stripping the passkey fails once the buyer had one enrolled, and is reported as no-op otherwise', () => {
  assert.deepEqual(got(run('case=P03&t=strip-passkey&before=1')), ['NEEDS_A_HUMAN', 1]);
  assert.deepEqual(got(run('case=R11&t=strip-passkey')), ['NEEDS_A_HUMAN', 1]);
  const r = run('case=R12&t=strip-passkey');
  assert.equal(r.noEffect.length, 1);
  assert.deepEqual(got(r), ['AGENT', 5]);
});

test('PayPal-side tampering fails the matching check', () => {
  assert.equal(run('case=R03&t=other-payee').j.facts.payeeMatches, false);
  assert.equal(run('case=R03&t=backdate-order').j.facts.signedBeforeOrder, false);
  assert.equal(run('case=R01&t=swap-record').j.facts.hashesMatch, false);
});

test("claiming the buyer asked for the overspend: caught by the custom_id, and at most it reaches a person", () => {
  // After payment, any edit to the record breaks its fingerprint.
  assert.deepEqual(got(run('case=P06&t=buyer-asked')), ['NEEDS_A_HUMAN', 1]);
  // Even a record changed before payment wins the operator no more than a review: AGENT becomes NEEDS A HUMAN.
  const r = run('case=P06&t=buyer-asked&before=1');
  assert.equal(r.j.facts.requestExceedsMandate, true);
  assert.deepEqual(got(r), ['NEEDS_A_HUMAN', 4]);
  // It never moves blame off a shop that planted a lie.
  assert.deepEqual(got(run('case=P08&t=buyer-asked&before=1')), ['MERCHANT', 2]);
});

test('the lab opens on the newest live case', () => {
  assert.match(labPage(), /<option value="P09" selected>P09 · The buyer says what they want[^<]*→ MERCHANT<\/option>/);
  assert.equal(runLab(ROOT, new URLSearchParams()).base.id, 'P09');
});

test('the case list is grouped, live disputes first, and every case is in exactly one group', () => {
  const html = labPage();
  const groups = [...html.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)];
  assert.equal(groups[0][1], 'Live disputes in the PayPal sandbox');
  assert.deepEqual([...groups[0][2].matchAll(/value="(\w+)"/g)].map((m) => m[1]), ['R03', 'R11', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']);
  const ids = groups.flatMap((g) => [...g[2].matchAll(/value="(\w+)"/g)].map((m) => m[1]));
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, (html.match(/<option value="[A-Z]\d+"/g) ?? []).length);
  assert.ok(groups.every((g) => g[2].includes('<option')), 'no empty group');
});

test('the start cards pick a case: one per verdict, the picked one marked and selected', () => {
  const html = labPage(new URLSearchParams('case=R01'));
  assert.deepEqual([...html.matchAll(/<a class="pick (\w+)" href="\/lab\?case=(\w+)"/g)].map((m) => [m[2], m[1]]),
    [['P09', 'MERCHANT'], ['P06', 'AGENT'], ['R01', 'USER'], ['R06', 'NEEDS_A_HUMAN']]);
  assert.match(html, /href="\/lab\?case=R01" aria-current="true"/);
  assert.match(html, /<option value="R01" selected>/);
  assert.match(labPage(new URLSearchParams('case=nope')), /<option value="P09" selected>/);
});

test('the dispute reason changes the action, not the verdict', () => {
  const r = run('case=R12&reason=UNAUTHORISED');
  assert.deepEqual([...got(r), r.j.plan.action, r.j.plan.refundCents], ['AGENT', 5, 'make-offer', 9000]);
});

test('lab pages are plain HTML forms with no scripts', () => {
  for (const html of [labPage(), labResult(ROOT, new URLSearchParams('case=R03&t=edit-page')), factsPage(new URLSearchParams())]) {
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /<form class="panel lab" method="get"/);
  }
});

test('the facts page applies the six rules to the facts as ticked', () => {
  assert.match(factsPage(new URLSearchParams()), /<h1>USER <em>· rule 6/);
  assert.match(factsPage(new URLSearchParams('set=1&on=hashesMatch')), /<h1>NEEDS A HUMAN <em>· rule 1/);
});

test('a lab run reads true: its own page preview, re-checked signatures, the cause only, under Lab', async () => {
  const html = labResult(ROOT, new URLSearchParams('case=R01&t=edit-page'));
  assert.match(html, /src="\/lab\/page\?case=R01&amp;t=edit-page"/);
  assert.match(html, /<a href="[^"]*lab"[^>]*aria-current="page">Lab<\/a>/);
  // The edited page fails its re-check in the timeline, as on the checks; the others still verify.
  assert.match(html, /\/p\/RJ-BLUE-M<\/span> from [^·]+· signature <span style="color:var\(--red\)">invalid/);
  assert.match(html, /\/p\/RJ-STORM-BLUE-M<\/span> from [^·]+· signature valid/);
  // The timing check fails only because the signature does; the story names the cause, not the knock-on.
  assert.match(html, /signature is fake or damaged/);
  assert.doesNotMatch(html, /signed after the payment/);
  assert.match(html, /PayPal order, captured \$129\.00/);
  assert.doesNotMatch(html, /PayPal order <span class="mono"><\/span>/);

  const { createReplay } = await import('../../replay/server.mjs');
  const s = createReplay({ root: ROOT });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/lab/page?case=R01&t=edit-page`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /^sandbox;/);
    assert.match(await r.text(), /<h1>[XY]oastline Rain Jacket/);
  } finally { s.close(); }
});

test('a changed case says it is a lab run, not that the real PayPal dispute is open', () => {
  const html = labResult(ROOT, new URLSearchParams('case=P09&t=edit-page'));
  assert.match(html, /Lab run · nothing sent to PayPal/);
  assert.match(html, /Lab run: nothing is sent to PayPal\. On a real dispute like PP-R-XXC-10197051, Black Box would take no automatic action/);
  assert.doesNotMatch(html, /dispute open|still open|planned, not yet executed|AUTO_EXECUTE/);
  assert.match(html, /The buyer opens dispute <span class="mono">PP-R-XXC-10197051<\/span>/);
  const p06 = labResult(ROOT, new URLSearchParams('case=P06&t=raise-cap'));
  assert.match(p06, /Lab run · nothing sent to PayPal/);
  assert.doesNotMatch(p06, /ZLR5F7QM5LBQ4|operator → merchant|Payout/, 'the real case\'s payout is not shown on a lab run');
});

test('a lab run on a bench case calls its dispute simulated, never by the stand-in id', () => {
  const html = labResult(ROOT, new URLSearchParams('case=R06&t=edit-page'));
  assert.match(html, /Lab run: nothing is sent to PayPal\. On a real dispute, Black Box would take no automatic action/);
  assert.match(html, /<span>Dispute<\/span><b class="mono">simulated dispute<\/b>/);
  assert.doesNotMatch(html, /BENCH-/);
});
