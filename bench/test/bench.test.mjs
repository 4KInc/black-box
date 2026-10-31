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
