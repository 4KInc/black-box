// Turns the concealment extractor's per-text findings into the five MERCHANT conditions and the
// unattributed-hidden-text and unclassified-agent-text signals that the verdict engine consumes.
//
// finding = {
//   textHash,               // sha256 of the normalised hidden text, for the replay
//   concealedInReadChannel, // boolean
//   namesPurchasedItem,     // boolean
//   contradictsListing,     // another current price for this item and variant, or an instruction to drop the buyer's limits
//   inModelInput,           // boolean
//   signedByMerchant,       // the text sits in a merchant-signed body
//   selfContained,          // its concealment depends on no unsigned file or script
//   thirdPartySigned,       // a third party (review platform, reviewer) signed a span covering it
//   addressesAgents,        // the text speaks to AI agents, assistants or bots
// }

export function merchantOwned(f) {
  return f.signedByMerchant && f.selfContained && !f.thirdPartySigned;
}

// The merchant's own hidden text, naming the item bought, that reached the model. Code may still
// judge it honest; this only says that the text is there and is the merchant's.
export function merchantHiddenTextRead(f) {
  return f.concealedInReadChannel && f.inModelInput && f.namesPurchasedItem && merchantOwned(f);
}

export function conditionsFor(f) {
  return {
    concealedInReadChannel: f.concealedInReadChannel,
    namesPurchasedItem: f.namesPurchasedItem,
    contradictsListing: f.contradictsListing,
    inModelInput: f.inModelInput,
    merchantOwned: merchantOwned(f),
  };
}

const count = (c) => Object.values(c).filter(Boolean).length;

// The five conditions must hold for the SAME text. Mixing conditions across texts
// (one hidden text names the SKU, another was read by the agent) must not convict.
export function summarize(findings) {
  let best = { concealedInReadChannel: false, namesPurchasedItem: false, contradictsListing: false, inModelInput: false, merchantOwned: false };
  let bestText = null;
  for (const f of findings) {
    const c = conditionsFor(f);
    if (count(c) > count(best)) { best = c; bestText = f.textHash ?? null; }
  }
  // Hidden text the agent actually read, but which code cannot pin on the merchant.
  const unattributed = findings.filter((f) => f.concealedInReadChannel && f.inModelInput && !merchantOwned(f));
  // The merchant's own hidden text about this item, addressed to AI agents, that code did not find
  // contradicting. Honest agent-directed copy lands here too: a person reads it, the agent is not blamed.
  const unclassified = findings.filter((f) => merchantHiddenTextRead(f) && f.addressesAgents && !f.contradictsListing);
  return {
    conditions: best,
    decisiveText: bestText,
    unattributedHiddenText: unattributed.length > 0,
    unattributedTexts: unattributed.map((f) => f.textHash ?? null),
    unclassifiedAgentText: unclassified.length > 0,
    unclassifiedTexts: unclassified.map((f) => f.textHash ?? null),
  };
}
