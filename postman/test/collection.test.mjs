import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTION, OUT } from '../build.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
// The code that runs Black Box; killtest/ holds the first feasibility checks, not the product.
const DIRS = ['agent', 'executor', 'lab', 'lib', 'mandate', 'scripts', 'shop'];
const requests = COLLECTION.item.flatMap((folder) => folder.item);
const shape = (path) => path.replace(/\?.*$/, '').replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, ':id');

function pathsInCode() {
  const found = new Set();
  for (const dir of DIRS) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true })) {
      if (!f.endsWith('.mjs') || f.split(/[\\/]/).includes('test')) continue;
      const src = readFileSync(join(ROOT, dir, f), 'utf8');
      for (const m of src.matchAll(/(?:['`]|\$\{API\})(\/v[123]\/[^'`\s]*)/g)) found.add(shape(m[1]));
    }
  }
  return found;
}

test('the committed collection is what postman/build.mjs makes', () => {
  assert.equal(readFileSync(OUT, 'utf8'), JSON.stringify(COLLECTION, null, 2) + '\n');
});

test('every PayPal path the code calls has a request in the collection', () => {
  const inCollection = new Set(requests.map((r) => shape(r.request.url.replace('{{base_url}}', ''))));
  const code = pathsInCode();
  assert.ok(code.size >= 15, `found only ${code.size} paths`);
  for (const p of code) assert.ok(inCollection.has(p), `${p} is called by the code but missing from the collection`);
  for (const p of inCollection) assert.ok(code.has(p), `${p} is in the collection but the code never calls it`);
});

test('the collection carries no credentials and points at the sandbox', () => {
  const vars = Object.fromEntries(COLLECTION.variable.map((v) => [v.key, v.value]));
  for (const k of ['client_id', 'client_secret', 'access_token', 'operator_client_id', 'operator_client_secret', 'operator_access_token']) assert.equal(vars[k], '', k);
  assert.equal(vars.base_url, 'https://api-m.sandbox.paypal.com');
  for (const r of requests) assert.match(r.request.description, /Source: `[a-z]+\/[a-z-]+\.mjs/, r.name);
});
