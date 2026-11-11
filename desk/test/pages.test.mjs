// The evidence desk's pages: the scenarios are public; a live dispute's page, and its forms to add
// a document and to approve sending, need the operator password and a same-origin post. Approving
// takes the exact package the page showed: if it changed, nothing is approved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLive } from '../../lab/live.mjs';
import { createReplay } from '../../replay/server.mjs';
import { createAutopilot } from '../../executor/autopilot.mjs';
import { executionLog, resolveDispute } from '../../executor/core.mjs';
import { deskState, resolveDesk } from '../run.mjs';
import { DESK_SCENARIOS } from '../scenarios.mjs';

const ORIGIN = 'http://localhost:4998';
const KEY = 'operator-secret';
const ID = 'PP-R-DSK-PAGE';
const D01 = DESK_SCENARIOS.find((s) => s.id === 'D01');
const auth = (pass = KEY) => ({ authorization: `Basic ${Buffer.from(`op:${pass}`).toString('base64')}` });
let root, server, base, uploads;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'bb-desk-pages-'));
  uploads = [];
  const dispute = { ...structuredClone(D01.dispute), dispute_id: ID };
  const paypal = async (method, path) => {
    if (path.startsWith('/v1/customer/disputes/')) return { ok: true, status: 200, data: structuredClone(dispute) };
    if (path.startsWith('/v2/payments/captures/')) return { ok: true, status: 200, data: { supplementary_data: { related_ids: { order_id: D01.order.id } } } };
    return { ok: true, status: 200, data: structuredClone(D01.order) };
  };
  const client = { paypal, evidence: async (id, form) => { uploads.push(JSON.parse(await form.get('input').text())); dispute.evidences = [{ source: 'SUBMITTED_BY_SELLER' }]; return { ok: true, status: 200, text: '{}' }; } };
  const extract = async (doc) => ({ raw: DESK_SCENARIOS.flatMap((s) => s.docs).find((d) => d.text === doc.text)?.reply ?? '{"facts":[]}', model: 'scripted' });
  const desk = (args) => resolveDesk({ ...args, extract, auto: false });
  const autopilot = createAutopilot({ root, execute: true, resolve: (id, o) => resolveDispute(id, { ...o, client, flag: async () => null, desk }) });
  await autopilot.handle(ID); // the desk sees the dispute, with no documents yet
  const stub = createServer((q, s) => s.end('stub'));
  server = createLive({ root, operatorKey: KEY, origin: ORIGIN, shopUrl: 'http://shop.test', replay: createReplay({ root, live: true }), mandate: stub, autopilot });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });

const form = (path, fields, headers = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { ...auth(), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });

test('the desk and its scenarios are public; a live dispute needs the operator password', async () => {
  const index = await fetch(`${base}/desk`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /11 of 11/);
  assert.ok(html.includes(`/desk/${ID}`), 'the live dispute is listed');
  assert.equal((await fetch(`${base}/desk/scenario/D10`)).status, 200);
  assert.match(await (await fetch(`${base}/desk/scenario/D10`)).text(), /shown here and never acted on|Addressed to the reader/);
  assert.equal((await fetch(`${base}/desk/${ID}`)).status, 401);
  assert.equal((await fetch(`${base}/desk/${ID}`, { headers: auth('wrong') })).status, 401);
  const page = await fetch(`${base}/desk/${ID}`, { headers: auth() });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Not proven/);
});

test('a document posted from another site is refused; from the page, it is added and read', async () => {
  const doc = D01.docs[0];
  assert.equal((await form(`/desk/${ID}/doc`, { name: doc.name, text: doc.text }, { origin: 'https://evil.example' })).status, 403);
  const r = await form(`/desk/${ID}/doc`, { name: doc.name, text: doc.text });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /Added ups-delivered\.txt\. Ready: approve it to send\./);
  const st = deskState(root, ID, executionLog(root, ID).read());
  assert.equal(st.result.decision, 'send');
  assert.equal(st.approved, false);
  assert.equal(uploads.length, 0);
  assert.match(await (await fetch(`${base}/desk/${ID}`, { headers: auth() })).text(), /Send to PayPal/);
});

test('approving a package the page did not show approves nothing; the shown one is sent, once', async () => {
  const stale = await form(`/desk/${ID}/send`, { package: 'f'.repeat(64) });
  assert.match(decodeURIComponent(stale.headers.get('location')), /package changed/);
  assert.equal(uploads.length, 0);
  const st = deskState(root, ID, executionLog(root, ID).read());
  const sent = await form(`/desk/${ID}/send`, { package: st.packageHash });
  assert.match(decodeURIComponent(sent.headers.get('location')), /Approved\. Sent to PayPal\./);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  await form(`/desk/${ID}/send`, { package: st.packageHash });
  assert.equal(uploads.length, 1);
  const page = await (await fetch(`${base}/desk/${ID}`, { headers: auth() })).text();
  assert.match(page, /<span class="dverdict">Sent to PayPal<\/span>/);
  assert.doesNotMatch(page, /<button class="send"/);
  assert.match(await (await fetch(`${base}/desk`)).text(), /<span class="dv">Sent to PayPal<\/span>/);
});
