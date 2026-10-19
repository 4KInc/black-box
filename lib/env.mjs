// Loads KEY=value lines from each of the given .env files that exist, in order. Earlier files
// win, and variables already set in the environment are never overridden.
import { existsSync, readFileSync } from 'node:fs';

// The KEY=value lines of one .env file as an object, without touching process.env (used for
// credentials that must not mix with the merchant's, e.g. the agent operator's).
export function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function loadEnv(...paths) {
  const loaded = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    loaded.push(p);
  }
  return loaded;
}
