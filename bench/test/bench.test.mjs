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
    if (r.def.kind === 'recorded') assert.equal(r.c.paypal.customId, r.c.hash, r.def.id);
    else assert.ok(r.def.mutate || r.def.order, r.def.id);
  }
});
