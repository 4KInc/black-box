// Loads KEY=value lines from the first of the given .env files that exists. Never overrides
// variables already set in the environment.
import { existsSync, readFileSync } from 'node:fs';

export function loadEnv(...paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    return p;
  }
  return null;
}
