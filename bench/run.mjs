// Prints the case bench and exits non-zero if any case disagrees with its expected answer.
//   npm run bench
import { runBench } from './bench.mjs';

const results = runBench();
const money = (c) => (c === undefined ? '' : ` $${(c / 100).toFixed(2)}`);
for (const { def, got, pass, mismatches } of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${def.id}  ${got.verdict.padEnd(13)} rule ${got.rule}  ${(got.action + money(got.refundCents)).padEnd(28)} ${def.title}`);
  for (const m of mismatches) console.log(`        ${m}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} cases match their expected verdict, rule and PayPal action.`);
process.exit(failed ? 1 : 0);
