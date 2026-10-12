// One dispute, end to end: stored record + what PayPal says -> facts -> verdict -> planned action.
// Everything here is deterministic code. The only AI input is the optional injection flag,
// which can only ever lead to NEEDS A HUMAN.

import { jsonLdBlocks } from '../lib/channels.mjs';
import { recordFacts } from '../recorder/recorder.mjs';
import { planAction } from './actions.mjs';
import { findingsFor } from './extract.mjs';
import { summarize } from './findings.mjs';
import { checkMandate } from './mandate.mjs';
import { decide } from './verdict.mjs';

const toCents = (v) => Math.round(Number(v) * 100);

// The product as the merchant signed it, from the purchased page's JSON-LD.
export function signedProduct(record) {
  const page = record.fetches[record.purchase.page_index];
  const html = Buffer.from(page.body_b64, 'base64').toString('utf8');
  const p = jsonLdBlocks(html).find((j) => j['@type'] === 'Product');
  if (!p) return null;
  return {
    sku: p.sku, name: p.name, category: p.category,
    attributes: { color: p.color, size: p.size },
    priceCents: toCents(p.offers?.price), currency: p.offers?.priceCurrency,
  };
}

// order = { customId, payeeMerchantId, createdAt, capturedCents } from PayPal.
export function evaluateCase({ record, order, reason, aiInjectionFlag = false }) {
  const integrity = recordFacts(record, order);
  const product = signedProduct(record);
  const page = record.fetches[record.purchase.page_index];

  const mandate = checkMandate(record.mandate, {
    sku: record.purchase.sku,
    category: product?.category ?? '',
    attributes: product?.attributes ?? {},
    totalCents: order.capturedCents,
    currency: product?.currency ?? 'USD',
    at: record.purchase.at,
    pageSigned: page.verification?.ok === true,
  });

  const findings = product ? findingsFor(record, { sku: product.sku, name: product.name }) : [];
  const summary = summarize(findings);
  const facts = {
    ...integrity.facts,
    mandateBroken: mandate.broken,
    ...summary.conditions,
    aiInjectionFlag,
    unattributedHiddenText: summary.unattributedHiddenText,
  };
  const verdict = decide(facts);
  const plan = planAction(verdict.verdict, reason, {
    capturedCents: order.capturedCents,
    outOfScopeCents: mandate.outOfScopeCents,
    mandateCapCents: record.mandate.maxTotalCents,
    signedPriceCents: product?.priceCents ?? order.capturedCents,
  });

  return { verdict, plan, facts, mandate, findings, product, integrityProblems: integrity.problems };
}
