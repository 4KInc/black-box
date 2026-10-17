// Runs the case bench: builds each case, judges it exactly as the executor would, and compares
// the verdict, rule, PayPal action and refund with the expected answer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_CHECKS } from '../engine/verdict.mjs';
import { judge } from '../replay/cases.mjs';
import { buildCase, CASES, ENROLMENT } from './cases.mjs';

export function runBench(root = join(import.meta.dirname, '..')) {
  const load = (name) => JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', name), 'utf8'));
  // The enrolment registry for the bench is the committed fixture, not the local records/.
  const enrolment = load(ENROLMENT);
  const enrolledFor = (payerId) => (payerId === enrolment.payer_id ? enrolment.credentials : []);
  return CASES.map((def) => {
    const c = buildCase(def, load);
    const j = judge(c, { enrolment: enrolledFor });
    const got = {
      verdict: j.verdict.verdict, rule: j.verdict.rule, action: j.plan.action, refundCents: j.plan.refundCents,
      broken: RECORD_CHECKS.filter((k) => !j.facts[k]).join(','),
    };
    const want = { broken: [], ...def.expect };
    want.broken = want.broken.join(',');
    const mismatches = Object.entries(want)
      .filter(([k, v]) => got[k] !== v)
      .map(([k, v]) => `${k}: expected ${v || '(none)'}, got ${got[k] || '(none)'}`);
    return { def, c, j, got, pass: mismatches.length === 0, mismatches };
  });
}
