// A software passkey for tests: produces real WebAuthn assertion bytes (authenticatorData,
// clientDataJSON, ES256 signature) exactly as a browser would, signed with a P-256 key in memory.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { b64u, mandateChallenge } from '../webauthn.mjs';

const sha256 = (d) => createHash('sha256').update(d).digest();

export function softPasskey({ rpId = 'localhost', origin = 'http://localhost:4050', flags = 0x05 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeySpki = b64u.enc(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    publicKeySpki,
    approve(mandate, { challenge = mandateChallenge(mandate), type = 'webauthn.get', at = origin } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type, challenge, origin: at, crossOrigin: false }));
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), { key: privateKey, dsaEncoding: 'der' });
      return {
        rp_id: rpId, credential_id: b64u.enc(sha256(publicKeySpki).subarray(0, 16)), public_key_spki: publicKeySpki, alg: -7,
        authenticator_data: b64u.enc(authData), client_data_json: b64u.enc(clientData), signature: b64u.enc(signature),
      };
    },
  };
}
