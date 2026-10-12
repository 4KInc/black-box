// Exhaustive property test: every one of the 2^12 combinations of facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, FACT_KEYS, RECORD_CHECKS, MERCHANT_CONDITIONS, RULES, VERDICT } from '../verdict.mjs';

function* everyCombination() {
  const n = FACT_KEYS.length;
  for (let bits = 0; bits < 1 << n; bits++) {
    const f = {};
    FACT_KEYS.forEach((k, i) => { f[k] = Boolean(bits & (1 << i)); });
    yield f;
  }
}

// Independent restatement of the spec table from the v3 brief, written as nested ifs
// rather than guards, so a mistake in one formulation shows up as a disagreement.
function oracle(f) {
  if (!RECORD_CHECKS.every((k) => f[k])) return VERDICT.HUMAN;
  const four = MERCHANT_CONDITIONS.every((k) => f[k]);
  if (four) return f.mandateBroken ? VERDICT.MERCHANT : VERDICT.HUMAN;
  if (f.aiInjectionFlag || f.unattributedHiddenText) return VERDICT.HUMAN;
  return f.mandateBroken ? VERDICT.AGENT : VERDICT.USER;
}

const ALL = [...everyCombination()];

test('the space is every combination of the 12 facts', () => {
  assert.equal(FACT_KEYS.length, 12);
  assert.equal(ALL.length, 4096);
});

test('exactly one rule fires for every combination, and it gives the expected verdict', () => {
  for (const f of ALL) {
    const fired = RULES.filter((r) => r.when(f));
    assert.equal(fired.length, 1, `facts ${JSON.stringify(f)} fired rules ${fired.map((r) => r.n)}`);
    assert.equal(decide(f).verdict, oracle(f), JSON.stringify(f));
  }
});

test('no rule is dead: each of the six fires for some combination', () => {
  const seen = new Set(ALL.map((f) => decide(f).rule));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});

test('a broken record always gives NEEDS A HUMAN', () => {
  for (const f of ALL) {
    if (RECORD_CHECKS.some((k) => !f[k])) assert.equal(decide(f).verdict, VERDICT.HUMAN);
  }
});

test('MERCHANT if and only if: record valid, all four conditions, mandate broken', () => {
  for (const f of ALL) {
    const expect = RECORD_CHECKS.every((k) => f[k]) && MERCHANT_CONDITIONS.every((k) => f[k]) && f.mandateBroken;
    assert.equal(decide(f).verdict === VERDICT.MERCHANT, expect, JSON.stringify(f));
  }
});

test('dropping any one MERCHANT condition never leaves a MERCHANT verdict', () => {
  for (const f of ALL) {
    if (decide(f).verdict !== VERDICT.MERCHANT) continue;
    for (const k of MERCHANT_CONDITIONS) {
      assert.notEqual(decide({ ...f, [k]: false }).verdict, VERDICT.MERCHANT, `still MERCHANT without ${k}`);
    }
  }
});

test('a purchase within the mandate is never blamed on the agent or the merchant', () => {
  for (const f of ALL) {
    if (!f.mandateBroken) assert.ok([VERDICT.USER, VERDICT.HUMAN].includes(decide(f).verdict));
  }
});

test('the AI flag can only ever move a verdict to NEEDS A HUMAN', () => {
  for (const f of ALL) {
    if (f.aiInjectionFlag) continue;
    const without = decide(f).verdict;
    const withFlag = decide({ ...f, aiInjectionFlag: true }).verdict;
    assert.ok(withFlag === without || withFlag === VERDICT.HUMAN, `${without} -> ${withFlag}`);
  }
});

test('the same facts always give the same verdict', () => {
  for (const f of ALL.slice(0, 256)) assert.deepEqual(decide({ ...f }), decide({ ...f }));
});

test('missing, extra or non-boolean facts are rejected, never defaulted', () => {
  const ok = Object.fromEntries(FACT_KEYS.map((k) => [k, true]));
  for (const k of FACT_KEYS) {
    const { [k]: _, ...missing } = ok;
    assert.throws(() => decide(missing), TypeError, `missing ${k}`);
    assert.throws(() => decide({ ...ok, [k]: 'false' }), TypeError, `string ${k}`);
    assert.throws(() => decide({ ...ok, [k]: 0 }), TypeError, `number ${k}`);
  }
  assert.throws(() => decide({ ...ok, llmSaysMerchant: true }), TypeError);
  assert.throws(() => decide(undefined), TypeError);
});
