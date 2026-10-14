import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64u, verifyMandateAssertion } from '../webauthn.mjs';
import { softPasskey } from '../testing/passkey.mjs';

const MANDATE = { item: { category: 'rain jacket', attributes: { color: 'blue', size: 'M' } }, maxTotalCents: 15000, currency: 'USD', signedShopsOnly: true };
const key = softPasskey();

test('a passkey approval of the mandate verifies', () => {
  assert.deepEqual(verifyMandateAssertion(MANDATE, key.approve(MANDATE)), { ok: true });
});

test('loosening the mandate after approval breaks it', () => {
  const auth = key.approve(MANDATE);
  const looser = { ...MANDATE, maxTotalCents: 50000 };
  assert.equal(verifyMandateAssertion(looser, auth).reason, 'the passkey signed a different mandate');
});

test('approvals for another site, a registration, or without user verification are refused', () => {
  const other = softPasskey({ rpId: 'evil.example', origin: 'https://evil.example' }).approve(MANDATE);
  assert.equal(verifyMandateAssertion(MANDATE, { ...other, rp_id: 'localhost' }).ok, false);
  assert.match(verifyMandateAssertion(MANDATE, key.approve(MANDATE, { type: 'webauthn.create' })).reason, /type is webauthn.create/);
  const noUv = softPasskey({ flags: 0x01 });
  assert.match(verifyMandateAssertion(MANDATE, noUv.approve(MANDATE)).reason, /not verified/);
});

test('a signature from a different key, or a damaged one, does not verify', () => {
  const auth = key.approve(MANDATE);
  const swapped = { ...auth, public_key_spki: softPasskey().publicKeySpki };
  assert.equal(verifyMandateAssertion(MANDATE, swapped).reason, 'signature does not verify');
  const sig = b64u.dec(auth.signature); sig[sig.length - 1] ^= 1;
  assert.equal(verifyMandateAssertion(MANDATE, { ...auth, signature: b64u.enc(sig) }).ok, false);
  assert.equal(verifyMandateAssertion(MANDATE, { ...auth, alg: -999 }).ok, false);
  assert.equal(verifyMandateAssertion(MANDATE, { ...auth, client_data_json: 'garbage' }).ok, false);
});
