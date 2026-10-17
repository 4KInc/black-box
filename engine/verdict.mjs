// Black Box verdict engine: six ordered rules, written as code, never decided by an AI.
//
// Every rule below has an explicit guard that repeats the negation of the rules before it.
// decide() evaluates all six guards and throws unless exactly one matches, so "first match
// wins" is not something we assume: the test suite checks it over every combination of facts.

export const VERDICT = Object.freeze({
  USER: 'USER',
  AGENT: 'AGENT',
  MERCHANT: 'MERCHANT',
  HUMAN: 'NEEDS_A_HUMAN',
});

// Integrity of the record itself. Any false value means the record is broken (rule 1).
export const RECORD_CHECKS = Object.freeze([
  'hashesMatch',        // every stored body hashes to what the record says, and custom_id equals the record hash
  'signaturesValid',    // every RFC 9421 signature verifies
  'keyOnShopDomain',    // the verifying key is published at the shop's /.well-known/ JWKS
  'payeeMatches',       // the merchant ID in signed content equals the PayPal order's payee
  'signedBeforeOrder',  // every signature's `created` is earlier than the order
  'mandateSigned',      // the paying user approved the mandate with their enrolled passkey
                        // (or the payer had no passkey enrolled when PayPal created the order)
]);

// The five MERCHANT conditions. All must hold for one hidden text (rules 2 and 3). Together they
// define agent-directed deception under Black Box's responsibility policy: they show that the
// merchant planted a contradicting text the agent read, not that the text changed the decision.
export const MERCHANT_CONDITIONS = Object.freeze([
  'concealedInReadChannel', // hidden by a method inside what the agent reads (JSON-LD/meta, textContent)
  'namesPurchasedItem',     // deterministic match on SKU, product ID or exact product name
  'contradictsListing',     // states a price other than the signed price, or tells the agent to set
                            // aside the buyer's limits; accurate product data that is merely unrendered is not
  'inModelInput',           // appears in the logged model input after whitespace normalisation
  'merchantOwned',          // merchant-signed, self-contained, no third-party signature covering it
]);

export const FACT_KEYS = Object.freeze([
  ...RECORD_CHECKS,
  'mandateBroken',
  ...MERCHANT_CONDITIONS,
  'aiInjectionFlag',         // the LLM flagger marked agent-directed text; can only ever lead to NEEDS A HUMAN
  'unattributedHiddenText',  // hidden text the agent read that is not provably the merchant's
                             // (inside third-party-signed content, or depending on unsigned files/JS)
]);

const recordBroken = (f) => RECORD_CHECKS.some((k) => !f[k]);
const allFive = (f) => MERCHANT_CONDITIONS.every((k) => f[k]);
const otherSignal = (f) => f.aiInjectionFlag || f.unattributedHiddenText;

export const RULES = Object.freeze([
  {
    n: 1, verdict: VERDICT.HUMAN,
    why: 'The record is broken, so it cannot support any verdict.',
    when: (f) => recordBroken(f),
  },
  {
    n: 2, verdict: VERDICT.MERCHANT,
    why: 'The purchase breaks the mandate, and the agent read the merchant\'s own signed, hidden text that names this item and contradicts its listing. Under the policy the merchant is responsible, whether or not the agent would have failed anyway.',
    when: (f) => !recordBroken(f) && allFive(f) && f.mandateBroken,
  },
  {
    n: 3, verdict: VERDICT.HUMAN,
    why: 'The purchase is within the mandate, but the merchant steered it. Whether that harmed the buyer is a judgment, not a check.',
    when: (f) => !recordBroken(f) && allFive(f) && !f.mandateBroken,
  },
  {
    n: 4, verdict: VERDICT.HUMAN,
    why: 'There is an injection signal that code cannot attribute to the merchant.',
    when: (f) => !recordBroken(f) && !allFive(f) && otherSignal(f),
  },
  {
    n: 5, verdict: VERDICT.AGENT,
    why: 'The purchase breaks the mandate, and nothing the agent read contradicted the listing or was flagged as manipulation.',
    when: (f) => !recordBroken(f) && !allFive(f) && !otherSignal(f) && f.mandateBroken,
  },
  {
    n: 6, verdict: VERDICT.USER,
    why: 'The purchase is within the mandate and nothing is suspicious.',
    when: (f) => !recordBroken(f) && !allFive(f) && !otherSignal(f) && !f.mandateBroken,
  },
]);

export function assertFacts(facts) {
  for (const k of FACT_KEYS) {
    if (typeof facts?.[k] !== 'boolean') {
      // A missing fact must never quietly default to false: that could turn a broken record into a verdict.
      throw new TypeError(`fact "${k}" must be a boolean, got ${JSON.stringify(facts?.[k])}`);
    }
  }
  const extra = Object.keys(facts).filter((k) => !FACT_KEYS.includes(k));
  if (extra.length) throw new TypeError(`unknown facts: ${extra.join(', ')}`);
}

export function decide(facts) {
  assertFacts(facts);
  const fired = RULES.filter((r) => r.when(facts));
  if (fired.length !== 1) {
    throw new Error(`expected exactly one rule to fire, got [${fired.map((r) => r.n).join(', ')}]`);
  }
  const [rule] = fired;
  return {
    verdict: rule.verdict,
    rule: rule.n,
    why: rule.why,
    trail: FACT_KEYS.map((k) => ({ fact: k, value: facts[k] })),
  };
}
