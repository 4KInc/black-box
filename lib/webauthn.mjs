// WebAuthn (passkey) assertions over a mandate, verified with node:crypto only.
//
// The challenge the passkey signs is base64url(sha256(canonical mandate)), so the signature
// covers exactly the mandate the user saw. Verification checks, in order:
//   clientDataJSON: type "webauthn.get", that challenge, an origin on the relying party's host
//   authenticatorData: rpIdHash = sha256(rpId), user present (UP) and user verified (UV) flags
//   signature: over authenticatorData || sha256(clientDataJSON), with the credential's public key
// Whether that key belongs to the paying user is decided by the caller (the enrolment registry).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalize } from './canonical.mjs';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};
const sha256 = (data) => createHash('sha256').update(data).digest();

export const mandateChallenge = (mandate) => b64u.enc(sha256(canonicalize(mandate)));

// COSE algorithm IDs browsers report from getPublicKeyAlgorithm().
const ALGS = {
  [-7]: { hash: 'sha256', dsaEncoding: 'der' }, // ES256 (P-256), what most passkeys use
  [-8]: { hash: null },                          // EdDSA (Ed25519)
  [-257]: { hash: 'sha256' },                    // RS256
};

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

// auth = { rp_id, credential_id, public_key_spki, alg, authenticator_data, client_data_json, signature }
// (binary fields base64url). Returns { ok: true } or { ok: false, reason }.
export function verifyMandateAssertion(mandate, auth) {
  try {
    const alg = ALGS[auth?.alg];
    if (!alg) return { ok: false, reason: `unsupported algorithm ${auth?.alg}` };

    const clientDataRaw = b64u.dec(auth.client_data_json);
    const clientData = JSON.parse(clientDataRaw.toString('utf8'));
    if (clientData.type !== 'webauthn.get') return { ok: false, reason: `client data type is ${clientData.type}` };
    if (clientData.challenge !== mandateChallenge(mandate)) return { ok: false, reason: 'the passkey signed a different mandate' };
    let originHost;
    try { originHost = new URL(clientData.origin).hostname; } catch { return { ok: false, reason: 'unreadable origin' }; }
    if (originHost !== auth.rp_id) return { ok: false, reason: `origin ${clientData.origin} is not on ${auth.rp_id}` };

    const authData = b64u.dec(auth.authenticator_data);
    if (authData.length < 37) return { ok: false, reason: 'authenticator data too short' };
    if (!authData.subarray(0, 32).equals(sha256(auth.rp_id))) return { ok: false, reason: 'signed for a different relying party' };
    const flags = authData[32];
    if (!(flags & FLAG_UP)) return { ok: false, reason: 'user was not present' };
    if (!(flags & FLAG_UV)) return { ok: false, reason: 'user was not verified (no biometric or PIN)' };

    const key = createPublicKey({ key: b64u.dec(auth.public_key_spki), format: 'der', type: 'spki' });
    const signed = Buffer.concat([authData, sha256(clientDataRaw)]);
    const ok = verify(alg.hash, signed, alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, b64u.dec(auth.signature));
    return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' };
  } catch (e) {
    return { ok: false, reason: `unreadable assertion: ${e.message}` };
  }
}
