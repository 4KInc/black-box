// PayPal webhook receiver: a dispute is filed -> PayPal calls us -> Black Box resolves it.
//
//   node executor/webhook.mjs                     receive on :4040 at POST /paypal/webhook
//   node executor/webhook.mjs --register <url>    register <url> with PayPal for dispute events
//                                                 (prints the webhook ID for PAYPAL_WEBHOOK_ID)
//
// Every event is verified with PayPal (verify-webhook-signature, against PAYPAL_WEBHOOK_ID)
// before anything is read from it; unverified events get 401 and are never acted on. The event
// only supplies a dispute ID: the verdict is always computed from PayPal's own dispute data and
// the stored record, never from the event body.
// Acts only when AUTO_EXECUTE=on; otherwise it computes and logs the plan (dry run).

import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { paypal } from '../lib/paypal.mjs';
import { createAutopilot } from './autopilot.mjs';

const ROOT = join(import.meta.dirname, '..');
export const DISPUTE_EVENTS = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED'];
const MAX_BODY = 1 << 20;

// Asks PayPal whether this delivery really came from PayPal for our webhook.
export function paypalVerifier(webhookId) {
  return async (headers, event) => {
    const h = (k) => headers[k] ?? null;
    const r = await paypal('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'), webhook_id: webhookId, webhook_event: event,
    });
    return r.ok && r.data?.verification_status === 'SUCCESS';
  };
}

export function createWebhookReceiver({ autopilot, verify, log = () => {} }) {
  const seen = new Set(); // event IDs already accepted (PayPal retries deliveries)
  return createServer((req, res) => {
    const reply = (status, text) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(text); };
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/paypal/webhook') return reply(404, 'not found');

    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, 'not JSON'); }
      let ok = false;
      try { ok = await verify(req.headers, event); } catch (e) { log({ event: event?.id, status: 'verify-error', error: e.message }); }
      if (!ok) { log({ event: event?.id, type: event?.event_type, status: 'rejected: signature not verified' }); return reply(401, 'unverified'); }

      if (seen.has(event.id)) return reply(200, 'duplicate');
      seen.add(event.id);
      const disputeId = event.resource?.dispute_id;
      log({ event: event.id, type: event.event_type, dispute: disputeId ?? null, status: 'accepted' });
      reply(200, 'ok'); // answer PayPal at once; the work happens after

      if (DISPUTE_EVENTS.includes(event.event_type) && typeof disputeId === 'string' && /^[A-Z0-9-]{6,64}$/.test(disputeId)) {
        autopilot.handleWithRetry(disputeId, `webhook ${event.event_type}`);
      }
    });
  });
}

function fileLog(name) {
  const dir = join(ROOT, 'records', 'autopilot');
  mkdirSync(dir, { recursive: true });
  return (entry) => {
    const line = { at: new Date().toISOString(), ...entry };
    appendFileSync(join(dir, name), JSON.stringify(line) + '\n');
    console.log(Object.values(line).filter((v) => v !== undefined && v !== null).join('  '));
  };
}

if (import.meta.main) {
  loadEnv(join(ROOT, '.env'), join(ROOT, 'killtest', '.env'));
  const { values } = parseArgs({ options: { register: { type: 'string' }, port: { type: 'string', default: process.env.WEBHOOK_PORT ?? '4040' } } });

  if (values.register) {
    const url = new URL(values.register);
    if (url.protocol !== 'https:') throw new Error('PayPal only delivers webhooks to https:// URLs');
    const r = await paypal('POST', '/v1/notifications/webhooks', { url: url.href, event_types: DISPUTE_EVENTS.map((name) => ({ name })) });
    if (!r.ok) throw new Error(`register failed (${r.status}): ${JSON.stringify(r.data)}`);
    console.log(`registered ${url.href}\nPAYPAL_WEBHOOK_ID=${r.data.id}   (add this to .env)`);
    process.exit(0);
  }

  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set: register a URL first (--register https://...)');
  const execute = process.env.AUTO_EXECUTE === 'on';
  const log = fileLog('webhook.jsonl');
  const autopilot = createAutopilot({ root: ROOT, execute, report: log });
  createWebhookReceiver({ autopilot, verify: paypalVerifier(webhookId), log }).listen(Number(values.port), () =>
    console.log(`webhook  POST http://localhost:${values.port}/paypal/webhook   ${execute ? 'AUTO_EXECUTE=on: will act' : 'dry run (AUTO_EXECUTE=on to act)'}`));
}
