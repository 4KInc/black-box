// Runs the evidence desk's scenarios offline: each document is read as its logged AI answer, checked
// against the file by code, and the decision compared with the one written down beforehand.
//   npm run desk-bench

import { DESK_SCENARIOS } from './scenarios.mjs';
import { decide } from './desk.mjs';
import { paypalFacts, recordFacts, sha256 } from './sources.mjs';
import { readReply } from './extract.mjs';

// docs: [{ name, text, reply? }]. Returns what the desk page shows: facts, readings and the decision.
export function deskCase({ dispute, order, docs }) {
  const pp = paypalFacts({ dispute, order });
  const read = docs.map((d) => {
    const doc = { ...d, hash: sha256(d.text), kind: d.name.endsWith('.json') ? 'records' : 'document' };
    if (doc.kind === 'records') return { doc, facts: recordFacts(d.name, JSON.parse(d.text)), dropped: [], instructions: [] };
    return { doc, ...readReply(doc, d.reply ?? '{}', 'logged') };
  });
  const facts = read.flatMap((r) => r.facts);
  const instructions = read.flatMap((r) => r.instructions.map((quote) => ({ doc: r.doc.name, quote })));
  return { pp, read, result: decide(pp, facts, { instructions }) };
}

export function runDeskBench(scenarios = DESK_SCENARIOS) {
  return scenarios.map((s) => {
    const { pp, read, result } = deskCase(s);
    const e = s.expect;
    const missing = result.checks.filter((c) => c.state === 'missing').map((c) => c.id);
    const fails = [
      result.decision !== e.decision && `decision ${result.decision}, expected ${e.decision}`,
      e.evidence && result.evidence?.evidence_type !== e.evidence && `evidence ${result.evidence?.evidence_type ?? 'none'}, expected ${e.evidence}`,
      e.missing && e.missing.some((m) => !missing.includes(m)) && `missing ${missing.join(', ') || 'nothing'}, expected ${e.missing.join(', ')}`,
      e.concedeCents !== undefined && result.concede?.refundCents !== e.concedeCents && `concede ${result.concede?.refundCents}, expected ${e.concedeCents}`,
      e.flagged !== undefined && result.flagged.length !== e.flagged && `${result.flagged.length} flagged, expected ${e.flagged}`,
      e.dropped !== undefined && read.reduce((n, r) => n + r.dropped.length, 0) !== e.dropped && `${read.reduce((n, r) => n + r.dropped.length, 0)} dropped, expected ${e.dropped}`,
    ].filter(Boolean);
    return { s, pp, read, result, pass: !fails.length, fails };
  });
}

if (import.meta.main) {
  const results = runDeskBench();
  for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.s.id} ${r.result.decision.padEnd(8)} ${r.s.title}${r.fails.length ? `\n       ${r.fails.join('; ')}` : ''}`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} evidence desk scenarios decided as written down`);
  process.exit(passed === results.length ? 0 : 1);
}
