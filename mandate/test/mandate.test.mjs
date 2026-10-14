import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64u, verifyMandateAssertion } from '../../lib/webauthn.mjs';
import { softPasskey } from '../../lib/testing/passkey.mjs';
import { createMandateServer, enrolledKeysFrom } from '../server.mjs';

const root = mkdtempSync(join(tmpdir(), 'mandate-'));
let server, base, origin, post;
const PAYER = 'TESTPAYER123';
const FORM = { category: 'Rain Jacket', color: 'Blue', size: 'm', maxDollars: '150', days: '7' };

before(async () => {
  server = createMandateServer({ root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  origin = `http://localhost:${port}`;
  post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
});
after(() => server.close());
const keyFor = (key, at) => (mandate) => key.approve(mandate, { at });

async function enrolKey(key) {
  const o = await post('/enrol/options', { payerId: PAYER });
  const clientDataJSON = b64u.enc(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin }));
  return post('/enrol', { payerId: PAYER, id: 'cred-1', alg: -7, publicKeySpki: key.publicKeySpki, clientDataJSON });
}

test('the page is served with a CSP that allows only its own script', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /<script src="\/app.js"><\/script>/);
});

test('enrol, approve, and the saved mandate verifies against the enrolled key', async () => {
  const key = softPasskey();
  assert.equal((await post('/approve/options', { payerId: PAYER, ...FORM })).status, 400); // not enrolled yet
  assert.equal((await enrolKey(key)).ok, true);
  assert.deepEqual(enrolledKeysFrom(root)(PAYER), [key.publicKeySpki]);

  const o = await post('/approve/options', { payerId: PAYER, ...FORM });
  assert.deepEqual(o.mandate.item, { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } });
  assert.equal(o.mandate.maxTotalCents, 15000);
  const signer = keyFor(key, origin);
  const auth = signer(o.mandate);
  assert.equal(auth.client_data_json.length > 0, true);
  const r = await post('/approve', { pending: o.pending, credentialId: 'cred-1', authenticatorData: auth.authenticator_data, clientDataJSON: auth.client_data_json, signature: auth.signature });
  assert.equal(r.status, 200);
  const saved = JSON.parse(readFileSync(join(root, 'records', 'mandates', `${r.mandateHash}.json`), 'utf8'));
  assert.equal(saved.payer_id, PAYER);
  assert.deepEqual(verifyMandateAssertion(saved.mandate, saved.mandate_auth), { ok: true });
  // An approval can be used once.
  assert.equal((await post('/approve', { pending: o.pending, credentialId: 'cred-1', authenticatorData: auth.authenticator_data, clientDataJSON: auth.client_data_json, signature: auth.signature })).status, 400);
});

test('an approval signed by a key that is not enrolled is refused', async () => {
  const o = await post('/approve/options', { payerId: PAYER, ...FORM });
  const auth = keyFor(softPasskey(), origin)(o.mandate);
  const r = await post('/approve', { pending: o.pending, credentialId: 'cred-1', authenticatorData: auth.authenticator_data, clientDataJSON: auth.client_data_json, signature: auth.signature });
  assert.equal(r.status, 400);
  assert.match(r.error, /signature does not verify/);
});

test('enrolment needs a fresh challenge from this page', async () => {
  const clientDataJSON = b64u.enc(JSON.stringify({ type: 'webauthn.create', challenge: 'made-up', origin }));
  assert.equal((await post('/enrol', { payerId: PAYER, id: 'x', alg: -7, publicKeySpki: 'x', clientDataJSON })).status, 400);
  assert.equal((await post('/enrol/options', { payerId: '../../etc' })).status, 400);
});
