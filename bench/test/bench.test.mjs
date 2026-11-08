import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, VERDICT } from '../../engine/verdict.mjs';
import { runBench } from '../bench.mjs';
import { CASES } from '../cases.mjs';

test('every bench case gets its expected verdict, rule, PayPal action and broken checks', () => {
  for (const r of runBench()) assert.ok(r.pass, `${r.def.id} ${r.def.title}: ${r.mismatches.join('; ')}`);
});

test('the bench covers all four verdicts and all six rules', () => {
  const got = runBench();
  assert.deepEqual(new Set(got.map((r) => r.got.verdict)), new Set(Object.values(VERDICT)));
  assert.deepEqual(new Set(got.map((r) => r.got.rule)), new Set(RULES.map((r) => r.n)));
});

test('a wrong expectation is reported, so the bench can fail', () => {
  const saved = CASES[0].expect;
  CASES[0].expect = { ...saved, verdict: 'MERCHANT' };
  try {
    const [first] = runBench();
    assert.equal(first.pass, false);
    assert.match(first.mismatches.join(), /verdict: expected MERCHANT, got USER/);
  } finally {
    CASES[0].expect = saved;
  }
});

test('recorded cases are untouched real runs; attacks change the record or the PayPal side', () => {
  for (const r of runBench()) {
    if (r.def.kind !== 'attack') assert.equal(r.c.paypal.customId, r.c.hash, r.def.id);
    else assert.ok(r.def.mutate || r.def.order, r.def.id);
  }
});

test('a lie on another product or variant node does not name the item bought (E10, E11)', () => {
  for (const r of runBench().filter((x) => ['E10', 'E11'].includes(x.def.id))) {
    const lie = r.j.findings.find((f) => /\$119/.test(f.text));
    assert.ok(lie, r.def.id);
    assert.equal(lie.namesPurchasedItem, false, r.def.id);
    assert.equal(lie.contradictsListing, true, r.def.id);
    assert.notEqual(r.got.verdict, 'MERCHANT', r.def.id);
  }
});

test('a ProductGroup note is judged against the purchased variant\'s signed price (E12, E13)', () => {
  const got = Object.fromEntries(runBench().filter((x) => ['E12', 'E13'].includes(x.def.id)).map((r) => [r.def.id, r]));
  for (const r of Object.values(got)) {
    assert.deepEqual([r.j.product.sku, r.j.product.priceCents], ['RJ-PREMIUM-BLUE-M', 24000], r.def.id);
    const note = r.j.findings.find((f) => /^AI agents:/.test(f.text));
    assert.equal(note.namesPurchasedItem, true, r.def.id);
  }
  assert.equal(got.E12.j.findings.find((f) => /^AI agents:/.test(f.text)).contradictsListing, false);
  assert.equal(got.E13.j.findings.find((f) => /^AI agents:/.test(f.text)).contradictsListing, true);
});

test('the bench page says each result in plain words, with a colour key', async () => {
  const { benchPage } = await import('../../replay/page.mjs');
  const html = benchPage(runBench());
  assert.match(html, /class="vkey"><span class="MERCHANT"><i><\/i>Shop at fault<\/span>/);
  assert.match(html, /If disputed as “wrong amount”<\/span><b>refund \$90\.00<\/b>/);
  assert.match(html, /<span class="fails">fails: [a-z' ,]+<\/span>/);
  assert.doesNotMatch(html, /accept-claim|breaks /);
});

test('the bench page reads as dispute scenarios, in groups that fold away', async () => {
  const { benchPage } = await import('../../replay/page.mjs');
  const results = runBench();
  const html = benchPage(results);
  assert.match(html, new RegExp(`${results.length} of ${results.length}</em><br>disputes judged right`));
  assert.equal((html.match(/<details class="sec fold">/g) ?? []).length, 6);
  assert.match(html, /<h2>Attacks on the record<\/h2><span class="why"[^>]*>What this proves<\/span><span class="tally">10 of 10 right<\/span>/);
  assert.doesNotMatch(html, />PASS<|exactly as expected/);
});

test('the bench page shows cards that filter by verdict, outcome and complaint, without scripts', async () => {
  const { benchPage } = await import('../../replay/page.mjs');
  const results = runBench();
  const html = benchPage(results);
  assert.equal((html.match(/<a class="bcard /g) ?? []).length, results.length);
  for (const legend of ['Verdict', 'Outcome', 'Complaint']) assert.match(html, new RegExp(`<legend>${legend}</legend>`));
  assert.match(html, /main:has\(#fb-v-AGENT:checked\) :is\(\.bcard,\.matrix a\):not\(\[data-v~="AGENT"\]\)\{display:none\}/);
  assert.match(html, /main:has\(#fb-a-refund:checked\) \.fold:not\(:has\(\[data-a~="refund"\]\)\)\{display:none\}/);
  const r04 = results.find((r) => r.def.id === 'R04');
  assert.match(html, new RegExp(`href="/bench/R04" data-v="${r04.got.verdict}" data-a="refund" data-r="amount"`));
  assert.doesNotMatch(html, /<script/);
});

test('with no flagger answer the money-moving plan is held, the verdict kept (F01, F03); others are not held', async () => {
  const results = runBench();
  assert.deepEqual(results.filter((r) => r.got.held).map((r) => r.def.id), ['F01', 'F03']);
  const f03 = results.find((r) => r.def.id === 'F03');
  assert.deepEqual([f03.got.verdict, f03.got.rule, f03.got.action], ['AGENT', 5, 'make-offer']);
  const { casePage, benchPage } = await import('../../replay/page.mjs');
  assert.match(casePage(f03.c, f03.j), /Held: the AI check gave no answer, and without it no money moves, so the offer \$60\.00 back waits/);
  assert.match(benchPage(results), /<span class="held">held: with no answer from the AI check, no money moves<\/span>/);
  // With the flagger's answer, F04 is not held: the flag sends it to a person.
  assert.equal(results.find((r) => r.def.id === 'F04').got.held, false);
});
