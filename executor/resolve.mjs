// The PayPal executor, by hand. Given a dispute ID, prints the verdict and plan; with --execute,
// carries the plan out (see core.mjs, which the webhook receiver and the watcher also use).
//   node executor/resolve.mjs <dispute_id> [--execute]

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { toValue } from '../engine/actions.mjs';
import { resolveDispute } from './core.mjs';

const ROOT = join(import.meta.dirname, '..');
loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));

const { values, positionals } = parseArgs({ allowPositionals: true, options: { execute: { type: 'boolean', default: false } } });
const [disputeId] = positionals;
if (!disputeId) { console.error('Usage: node executor/resolve.mjs <dispute_id> [--execute]'); process.exit(1); }

const out = await resolveDispute(disputeId, { root: ROOT, execute: values.execute });
const { dispute } = out;
console.log(`dispute    ${disputeId}  ${dispute.reason}  ${dispute.status}  stage=${dispute.dispute_life_cycle_stage}`);
if (out.status === 'not-ours') {
  console.log('skipped    the disputed order carries no Black Box record');
  process.exit(0);
}
const { result, txn } = out;
console.log(`record     ${txn.custom}`);
console.log(`payee      ${txn.seller?.merchant_id}  (signed: ${result.product ? 'page names ' + (result.facts.payeeMatches ? 'the same ID' : 'a different ID') : 'no product'})`);
console.log(`verdict    ${result.verdict.verdict}  (rule ${result.verdict.rule}): ${result.verdict.why}`);
for (const f of result.findings) console.log(`  finding  [${f.method}] names item=${f.namesPurchasedItem} read=${f.inModelInput} third-party=${f.thirdPartySigned}`);
console.log(`plan       ${result.plan.action}${result.plan.refundCents ? ' $' + toValue(result.plan.refundCents) : ''}: ${result.plan.note}`);
console.log(`paypal     available actions: ${out.links.join(', ')}`);

const said = {
  planned: values.execute ? '\nnothing to execute for this verdict' : '\n(dry run: add --execute to carry out the plan)',
  'already-done': '\nalready executed for this dispute (see records/executions/); not sending it twice',
  'not-ready': '\nPayPal does not offer this action on the dispute yet; try again in a minute',
  executed: `\n✓ executed ${result.plan.action}\ndispute    now ${out.after?.status}  outcome=${out.after?.dispute_outcome?.outcome_code ?? '-'}`,
};
console.log(said[out.status]);
