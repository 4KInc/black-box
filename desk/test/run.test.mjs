// The evidence desk in the executor, against a scripted PayPal: a dispute with no Black Box record
// goes to the desk; documents are read once; nothing is sent until the merchant approves this
// exact package; sending goes through the attempt and reconcile path, so it happens once.
// No network: the PayPal and the AI here are JavaScript functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionLog, resolveDispute } from '../../executor/core.mjs';
import { createAutopilot } from '../../executor/autopilot.mjs';
import { approve, deskState, resolveDesk } from '../run.mjs';
import { addDoc } from '../sources.mjs';
import { DESK_SCENARIOS } from '../scenarios.mjs';

const D01 = DESK_SCENARIOS.find((s) => s.id === 'D01');
const UPS = D01.docs[0];
const ID = 'PP-R-DSK-RUN';

function world({ reason = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', links = ['provide_evidence', 'accept_claim'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bb-desk-run-'));
  const dispute = { ...structuredClone(D01.dispute), dispute_id: ID, reason, links: links.map((rel) => ({ rel })) };
  const order = structuredClone(D01.order);
  const posts = [];
  const reads = [];
  const w = {
    root, dispute, order, posts, reads,
    upload: async () => { dispute.evidences = [...(dispute.evidences ?? []), { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER' }]; return { ok: true, status: 200, text: '{}' }; },
    supporting: async () => { dispute.supporting_info = [...(dispute.supporting_info ?? []), { source: 'SUBMITTED_BY_SELLER' }]; return { ok: true, status: 200, text: '{}' }; },
    log: () => executionLog(root, ID).read(),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
  const paypal = async (method, path, json) => {
    if (method === 'POST') {
      posts.push({ path, json });
      if (path.endsWith('/escalate')) { dispute.dispute_life_cycle_stage = 'CHARGEBACK'; dispute.links = [{ rel: 'provide_evidence' }]; }
      return { ok: true, status: 200, data: {} };
    }
    if (path.startsWith('/v1/customer/disputes/')) return { ok: true, status: 200, data: structuredClone(dispute) };
    if (path.startsWith('/v2/payments/captures/')) return { ok: true, status: 200, data: { supplementary_data: { related_ids: { order_id: order.id } } } };
    return { ok: true, status: 200, data: structuredClone(order) };
  };
  const client = { paypal, evidence: async (id, form, endpoint) => { const input = JSON.parse(await form.get('input').text()); const file = await form.get('file1').text(); posts.push({ path: `/v1/customer/disputes/${id}/${endpoint}`, json: input, file }); return endpoint === 'provide-evidence' ? w.upload() : w.supporting(); } };
  const extract = async (doc) => { reads.push(doc.name); return { raw: DESK_SCENARIOS.flatMap((s) => s.docs).find((d) => d.text === doc.text)?.reply ?? '{"facts":[]}', model: 'scripted' }; };
  w.resolve = (opts = {}) => resolveDispute(ID, { root, execute: true, client, flag: async () => null, desk: (args) => resolveDesk({ ...args, extract, auto: false }), ...opts });
  return w;
}

test('without the desk, a dispute with no Black Box record is still not ours', async () => {
  const w = world();
  try {
    const out = await w.resolve({ desk: null });
    assert.equal(out.status, 'not-ours');
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('with no documents the desk asks for them; with the carrier\'s email it waits for approval; nothing is sent', async () => {
  const w = world();
  try {
    assert.equal((await w.resolve()).status, 'awaiting-documents');
    addDoc(w.root, ID, UPS.name, UPS.text);
    const out = await w.resolve();
    assert.equal(out.status, 'awaiting-approval');
    assert.equal(out.desk.result.decision, 'send');
    assert.equal(w.posts.length, 0);
    // Read once: a second run reuses the logged reading.
    await w.resolve();
    assert.deepEqual(w.reads, ['ups-delivered.txt']);
    assert.equal(w.log().filter((e) => e.step === 'desk-read').length, 1);
  } finally { w.done(); }
});

test('approved, the package is sent once, with tracking, the note and every document', async () => {
  const w = world();
  try {
    addDoc(w.root, ID, UPS.name, UPS.text);
    const before = await w.resolve();
    approve(w.root, ID, before.desk.packageHash);
    const out = await w.resolve();
    assert.equal(out.status, 'executed');
    const sent = w.posts.filter((p) => p.path.endsWith('/provide-evidence'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].json.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
    assert.deepEqual(sent[0].json.evidences[0].evidence_info.tracking_info, [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }]);
    assert.ok(sent[0].file.includes(UPS.text));
    assert.equal((await w.resolve()).status, 'already-done');
    assert.equal(w.posts.filter((p) => p.path.endsWith('/provide-evidence')).length, 1);
    assert.equal(deskState(w.root, ID, w.log()).sent.state, 'succeeded');
  } finally { w.done(); }
});

test('a document added after approval makes a new package, which needs approving again', async () => {
  const w = world();
  try {
    addDoc(w.root, ID, UPS.name, UPS.text);
    approve(w.root, ID, (await w.resolve()).desk.packageHash);
    addDoc(w.root, ID, 'note.txt', 'Customer called on Nov 6 to say thanks.');
    const out = await w.resolve();
    assert.equal(out.status, 'awaiting-approval');
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('a returned parcel is never sent, approved or not: a person decides, and no money moves', async () => {
  const w = world();
  try {
    const d03 = DESK_SCENARIOS.find((s) => s.id === 'D03').docs[0];
    w.order.purchase_units[0].shipping.trackers = []; // D01's tracker would disagree with this parcel
    addDoc(w.root, ID, d03.name, d03.text);
    const out = await w.resolve();
    assert.equal(out.status, 'held-for-person');
    assert.equal(out.desk.result.decision, 'concede');
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('a message the AI could not read blocks sending until it is read', async () => {
  const w = world();
  try {
    addDoc(w.root, ID, UPS.name, UPS.text);
    const out = await w.resolve({ desk: (args) => resolveDesk({ ...args, extract: async () => { throw new Error('model down'); }, auto: true }) });
    assert.equal(out.status, 'awaiting-documents');
    assert.ok(out.desk.result.checks.some((c) => c.id === 'read' || c.id === 'delivered'));
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('an upload that times out is not sent again blindly; PayPal\'s dispute settles it', async () => {
  const w = world();
  try {
    addDoc(w.root, ID, UPS.name, UPS.text);
    approve(w.root, ID, (await w.resolve()).desk.packageHash);
    // The upload reaches PayPal, but the answer is lost.
    w.upload = async () => { w.dispute.evidences = [{ evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER' }]; return { ok: false, status: null, text: null }; };
    assert.equal((await w.resolve()).status, 'outcome-unknown');
    const again = await w.resolve();
    assert.equal(again.status, 'already-done');
    assert.equal(w.posts.filter((p) => p.path.endsWith('/provide-evidence')).length, 1);
    assert.ok(w.log().some((e) => e.step === 'reconciled' && e.kind === 'provide-evidence'));
  } finally { w.done(); }
});

test('an approved package on an inquiry escalates first, then sends', async () => {
  const w = world({ links: ['escalate'] });
  try {
    w.dispute.dispute_life_cycle_stage = 'INQUIRY';
    addDoc(w.root, ID, UPS.name, UPS.text);
    approve(w.root, ID, (await w.resolve()).desk.packageHash);
    assert.equal((await w.resolve()).status, 'escalated');
    assert.equal((await w.resolve()).status, 'executed');
    assert.deepEqual(w.posts.map((p) => p.path.split('/').at(-1)), ['escalate', 'provide-evidence']);
  } finally { w.done(); }
});

test('a claim PayPal already has under review takes the approved package as supporting info, once', async () => {
  // As the sandbox did it (PP-R-NVH-10198801): the inquiry became a claim under review, with
  // provide_supporting_info the only way in.
  const w = world({ links: ['provide_supporting_info'] });
  try {
    w.dispute.status = 'UNDER_REVIEW';
    addDoc(w.root, ID, UPS.name, UPS.text);
    approve(w.root, ID, (await w.resolve()).desk.packageHash);
    assert.equal((await w.resolve()).status, 'executed');
    const sent = w.posts.filter((p) => p.path.endsWith('/provide-supporting-info'));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].json.notes.includes('1Z999AA10123456784'));
    assert.ok(sent[0].file.includes(UPS.text));
    assert.equal((await w.resolve()).status, 'already-done');
    assert.equal(w.posts.length, 1);
    assert.equal(deskState(w.root, ID, w.log()).sent.state, 'succeeded');
  } finally { w.done(); }
});

test('a dry run plans and sends nothing, even approved', async () => {
  const w = world();
  try {
    addDoc(w.root, ID, UPS.name, UPS.text);
    approve(w.root, ID, (await w.resolve()).desk.packageHash);
    assert.equal((await w.resolve({ execute: false })).status, 'planned');
    assert.equal(w.posts.length, 0);
  } finally { w.done(); }
});

test('the autopilot parks a dispute awaiting the merchant, and picks it up again when reopened', async () => {
  const w = world();
  try {
    const ap = createAutopilot({ root: w.root, execute: true, resolve: (id, o) => w.resolve(o) });
    assert.equal((await ap.handle(ID)).status, 'awaiting-documents');
    assert.equal((await ap.handle(ID)).cached, true);
    addDoc(w.root, ID, UPS.name, UPS.text);
    ap.reopen(ID);
    const out = await ap.handle(ID);
    assert.equal(out.status, 'awaiting-approval');
    approve(w.root, ID, out.desk.packageHash);
    ap.reopen(ID);
    assert.equal((await ap.handle(ID)).status, 'executed');
    ap.stop();
  } finally { w.done(); }
});
