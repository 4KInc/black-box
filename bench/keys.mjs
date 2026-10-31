// TEST ONLY. The bench's signing key, for the pages it rewrites (E01-E11). Its private half is
// committed in keys/TEST-ONLY-bench-signing-key.jwk.json, so anyone can sign with it: it must
// never be a shop's key. The shop and the review platform refuse to start with it, and
// recordFacts fails keyOnShopDomain for any record whose key set carries it, unless the caller
// is the bench and says so (trustBenchKey).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { thumbprint } from '../lib/sig.mjs';

export const BENCH_KEY_ID = '--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck';

export const isBenchKey = (jwk) => Boolean(jwk?.x) && thumbprint(jwk) === BENCH_KEY_ID;

// Read only when the bench builds a case that needs it.
export function loadBenchKey() {
  const { _warning, ...jwk } = JSON.parse(readFileSync(join(import.meta.dirname, 'keys', 'TEST-ONLY-bench-signing-key.jwk.json'), 'utf8'));
  if (!isBenchKey(jwk)) throw new Error('the bench key file does not hold the bench key');
  return jwk;
}
