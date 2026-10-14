// The dispute watcher: polls PayPal for open disputes and resolves each one through the same
// autopilot as the webhook receiver. Needs no public URL, so it works on a laptop.
//   node executor/watch.mjs [--every 30]      dry run
//   AUTO_EXECUTE=on node executor/watch.mjs   acts
// Disputes are re-checked until settled; a dispute PayPal is not ready to act on is simply
// seen again on a later poll.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { paypal } from '../lib/paypal.mjs';
import { createAutopilot } from './autopilot.mjs';

const ROOT = join(import.meta.dirname, '..');
const OPEN = new Set(['WAITING_FOR_SELLER_RESPONSE', 'OPEN']);

export async function openDisputes(fetchPage = (path) => paypal('GET', path)) {
  const r = await fetchPage('/v1/customer/disputes?page_size=50');
  if (!r.ok) throw new Error(`list disputes failed (${r.status})`);
  return (r.data.items ?? []).filter((d) => OPEN.has(d.status)).map((d) => d.dispute_id);
}

export async function pollOnce(autopilot, list = openDisputes) {
  const ids = await list();
  return Promise.all(ids.map((id) => autopilot.handle(id, 'watcher')));
}

if (import.meta.main) {
  loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));
  const { values } = parseArgs({ options: { every: { type: 'string', default: '30' } } });
  const execute = process.env.AUTO_EXECUTE === 'on';
  const dir = join(ROOT, 'records', 'autopilot');
  mkdirSync(dir, { recursive: true });
  const report = (e) => {
    if (e.cached) return;
    const line = { at: new Date().toISOString(), ...e };
    appendFileSync(join(dir, 'watch.jsonl'), JSON.stringify(line) + '\n');
    console.log([line.at, e.disputeId, e.status, e.verdict && `${e.verdict} rule ${e.rule}`, e.action, e.error].filter(Boolean).join('  '));
  };
  const autopilot = createAutopilot({ root: ROOT, execute, report });
  console.log(`watching PayPal disputes every ${values.every}s   ${execute ? 'AUTO_EXECUTE=on: will act' : 'dry run (AUTO_EXECUTE=on to act)'}`);
  const tick = () => pollOnce(autopilot).catch((e) => console.error(`poll failed: ${e.message}`));
  await tick();
  setInterval(tick, Number(values.every) * 1000);
}
