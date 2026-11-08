// Checks for a live sandbox run (see scripts/smoke-live.md). Each exits non-zero, loudly, on failure.
//   node scripts/live.mjs preflight             the flagger's Anthropic key answers one tiny call, the
//                                               PayPal sandbox app gets a token, and nothing turns the
//                                               flagger off (without it, every money-moving verdict is held)
//   node scripts/live.mjs capture <dispute_id>  the disputed capture's status; fails unless REFUNDED
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { anthropic } from '../agent/llm.mjs';
import { FLAGGER_MODEL } from '../flagger/flagger.mjs';
import { accessToken, paypal } from '../lib/paypal.mjs';

// Returns the problems found, [] when ready. The two calls are passed in so tests make none.
export async function preflight({ env = process.env, askModel, paypalToken }) {
  const problems = [];
  if (!env.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is not set (black-box/.env). Without it the flagger cannot run and every money-moving verdict (AGENT or MERCHANT) is HELD, not paid.');
  else {
    try { await askModel(); } catch (e) { problems.push(`the Anthropic key does not work for the flagger model ${FLAGGER_MODEL}: ${e.message}`); }
  }
  if (env.FLAGGER === 'off') problems.push('FLAGGER=off: every money-moving verdict (AGENT or MERCHANT) would be HELD, not paid. Unset it.');
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) problems.push('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (killtest/.env).');
  else {
    try { await paypalToken(); } catch (e) { problems.push(`the PayPal sandbox app did not get a token: ${e.message}`); }
  }
  return problems;
}

// The status of the capture a dispute is about, e.g. REFUNDED or PARTIALLY_REFUNDED.
export async function captureStatus(disputeId, { client = { paypal } } = {}) {
  const d = await client.paypal('GET', `/v1/customer/disputes/${disputeId}`);
  if (!d.ok) throw new Error(`get dispute failed (${d.status}, debug ${d.debugId})`);
  const captureId = d.data.disputed_transactions?.[0]?.seller_transaction_id;
  if (!captureId) throw new Error('the dispute names no capture');
  const c = await client.paypal('GET', `/v2/payments/captures/${captureId}`);
  if (!c.ok) throw new Error(`get capture failed (${c.status}, debug ${c.debugId})`);
  return { captureId, status: c.data.status, disputeStatus: d.data.status, outcome: d.data.dispute_outcome?.outcome_code ?? null };
}

if (import.meta.main) {
  const ROOT = join(import.meta.dirname, '..');
  loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));
  const { positionals } = parseArgs({ allowPositionals: true });
  const [cmd, arg] = positionals;
  const fail = (lines) => { console.error(['', '!!! LIVE CHECK FAILED !!!', ...lines.map((l) => `  - ${l}`), ''].join('\n')); process.exit(1); };

  if (cmd === 'preflight') {
    const problems = await preflight({ askModel: () => anthropic({ system: 'Reply with OK.', user: 'OK?', model: FLAGGER_MODEL, maxTokens: 1 }), paypalToken: accessToken });
    if (problems.length) fail(problems);
    console.log(`preflight ok: Anthropic key answers (${FLAGGER_MODEL}), PayPal sandbox token issued, flagger on`);
  } else if (cmd === 'capture') {
    if (!arg) fail(['usage: node scripts/live.mjs capture <dispute_id>']);
    const s = await captureStatus(arg);
    console.log(`dispute ${arg}  ${s.disputeStatus}  outcome=${s.outcome ?? '-'}  capture ${s.captureId}  ${s.status}`);
    if (s.status !== 'REFUNDED') fail([`capture ${s.captureId} is ${s.status}, not REFUNDED`]);
  } else {
    fail(['usage: node scripts/live.mjs preflight | capture <dispute_id>']);
  }
}
