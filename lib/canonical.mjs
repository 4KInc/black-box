// Canonical JSON for hashing: object keys sorted, no whitespace. A subset of RFC 8785 (JCS):
// only strings, integers, booleans, null, arrays and objects are allowed, so number formatting
// can never make two equal records hash differently.

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`only safe integers can be hashed, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const k of keys) if (value[k] === undefined) throw new TypeError(`undefined value at key "${k}"`);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`cannot hash a ${typeof value}`);
}
