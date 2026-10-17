import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { factsPage, labPage, labResult, runLab } from '../lab.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const run = (q) => runLab(ROOT, new URLSearchParams(q));
const got = (r) => [r.j.verdict.verdict, r.j.verdict.rule];

test('with nothing changed, the lab gives the bench case its own verdict', () => {
  assert.deepEqual(got(run('case=R03')), ['MERCHANT', 2]);
  assert.deepEqual(got(run('case=R12')), ['AGENT', 5]);
});

test('editing the stored page breaks the record, whatever the attacker intended', () => {
  const r = run('case=R03&t=edit-page');
  assert.deepEqual(got(r), ['NEEDS_A_HUMAN', 1]);
  assert.equal(r.j.facts.hashesMatch, false);
});

test('a budget raised after approval: caught by the passkey, or by the custom_id', () => {
  assert.equal(run('case=P03&t=raise-cap&before=1').j.facts.mandateSigned, false);
  assert.equal(run('case=P03&t=raise-cap').j.facts.hashesMatch, false);
});

test('stripping the passkey fails once the buyer had one enrolled, and is reported as no-op otherwise', () => {
  assert.deepEqual(got(run('case=P03&t=strip-passkey&before=1')), ['NEEDS_A_HUMAN', 1]);
  const r = run('case=R11&t=strip-passkey');
  assert.equal(r.noEffect.length, 1);
  assert.deepEqual(got(r), ['MERCHANT', 2]);
});

test('PayPal-side tampering fails the matching check', () => {
  assert.equal(run('case=R03&t=other-payee').j.facts.payeeMatches, false);
  assert.equal(run('case=R03&t=backdate-order').j.facts.signedBeforeOrder, false);
  assert.equal(run('case=R01&t=swap-record').j.facts.hashesMatch, false);
});

test('the dispute reason changes the action, not the verdict', () => {
  const r = run('case=R12&reason=UNAUTHORISED');
  assert.deepEqual([...got(r), r.j.plan.action, r.j.plan.refundCents], ['AGENT', 5, 'make-offer', 9000]);
});

test('lab pages are plain HTML forms with no scripts', () => {
  for (const html of [labPage(), labResult(ROOT, new URLSearchParams('case=R03&t=edit-page')), factsPage(new URLSearchParams())]) {
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /<form class="panel lab" method="get"/);
  }
});

test('the facts page applies the six rules to the facts as ticked', () => {
  assert.match(factsPage(new URLSearchParams()), /<h1>USER <em>· rule 6/);
  assert.match(factsPage(new URLSearchParams('set=1&on=hashesMatch')), /<h1>NEEDS A HUMAN <em>· rule 1/);
});
