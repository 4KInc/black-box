// The hosted Black Box: the replay, the case bench, the study and the lab, served from the
// committed fixtures. On Cloud Run (Dockerfile) or any host:
//   HOST=0.0.0.0 PORT=10000 node lab/hosted.mjs
// With LIVE_DIR set it is also the live demo (lab/live.mjs): runs made here, their PayPal disputes
// and the passkeys enrolled here are kept in LIVE_DIR (on Cloud Run, a Cloud Storage bucket), and
// it needs, from Secret Manager or the environment:
//   PUBLIC_ORIGIN       this site's https:// origin (the passkey relying party)
//   SHOP_URL            the hosted shop the agent buys from
//   OPERATOR_KEY        the password for /mandate/ and /operator
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   the merchant's sandbox app
//   ANTHROPIC_API_KEY   the agent's model and the AI flagger
//   PAYPAL_WEBHOOK_ID   the registered webhook (without it, the autopilot only polls)
//   AUTO_EXECUTE=on     to act on disputes; otherwise it only plans them
//   BUYER_PAYER_ID      prefilled on the mandate page
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplay } from '../replay/server.mjs';
import { siteIntro } from '../replay/page.mjs';
import { mergeEnrolment } from './live.mjs';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 10000);
const HOST = process.env.HOST ?? '0.0.0.0';
const LIVE_DIR = process.env.LIVE_DIR;

// A scratch root holding what is committed, plus the buyer's enrolled passkey (public key) in the
// registry the replay reads, exactly as the static site build does. Live, records/ is LIVE_DIR.
const root = mkdtempSync(join(tmpdir(), 'blackbox-hosted-'));
cpSync(join(ROOT, 'fixtures'), join(root, 'fixtures'), { recursive: true });
if (LIVE_DIR) { mkdirSync(LIVE_DIR, { recursive: true }); symlinkSync(LIVE_DIR, join(root, 'records'), 'dir'); }
mergeEnrolment(root, JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', 'passkey-enrolment.json'), 'utf8')));

const replay = createReplay({ root, intro: siteIntro({ live: true }), live: Boolean(LIVE_DIR) });
if (!LIVE_DIR) {
  replay.listen(PORT, HOST, () => console.log(`black box  http://${HOST}:${PORT}  (fixtures only)`));
} else {
  const { createLive } = await import('./live.mjs');
  const { createMandateServer } = await import('../mandate/server.mjs');
  const { createAutopilot, flaggerWarning } = await import('../executor/autopilot.mjs');
  const { createWebhookReceiver, paypalVerifier } = await import('../executor/webhook.mjs');
  const { pollOnce } = await import('../executor/watch.mjs');
  const env = process.env;
  for (const k of ['PUBLIC_ORIGIN', 'SHOP_URL', 'OPERATOR_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) {
    if (!env[k]) throw new Error(`LIVE_DIR is set, so ${k} must be too`);
  }
  const origin = new URL(env.PUBLIC_ORIGIN).origin;
  mkdirSync(join(root, 'records', 'autopilot'), { recursive: true });
  const log = (entry) => {
    if (entry.cached) return;
    const line = { at: new Date().toISOString(), ...entry };
    appendFileSync(join(root, 'records', 'autopilot', 'hosted.jsonl'), JSON.stringify(line) + '\n');
    console.log(JSON.stringify(line));
  };
  const autopilot = createAutopilot({ root, execute: env.AUTO_EXECUTE === 'on', report: log });
  const warning = flaggerWarning(env);
  if (warning) console.warn(warning);
  const mandate = createMandateServer({
    root, defaultPayerId: env.BUYER_PAYER_ID ?? '', rpId: new URL(origin).hostname, origin,
    next: () => 'The agent operator can now send the agent shopping: /operator',
  });
  const webhook = env.PAYPAL_WEBHOOK_ID ? createWebhookReceiver({ autopilot, verify: paypalVerifier(env.PAYPAL_WEBHOOK_ID), log }) : null;
  const every = Number(env.WATCH_EVERY ?? 30);
  setInterval(() => pollOnce(autopilot).catch((e) => log({ status: 'poll failed', error: e.message })), every * 1000);
  createLive({ root, replay, mandate, webhook, operatorKey: env.OPERATOR_KEY, origin, shopUrl: env.SHOP_URL }).listen(PORT, HOST, () =>
    console.log(`black box  http://${HOST}:${PORT}  live: ${origin}, shop ${env.SHOP_URL}, ${webhook ? 'webhook and ' : ''}polling every ${every}s, ${env.AUTO_EXECUTE === 'on' ? 'AUTO_EXECUTE=on: will act' : 'dry run'}`));
}
