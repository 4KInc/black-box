#!/usr/bin/env node
// Black Box kill test: proves (or disproves) the PayPal sandbox dispute loop before any product code.
// Usage: node kt.mjs <command> [args]   (run `node kt.mjs help` for the list)
// Every API exchange is appended to results/log.jsonl so the outcome is evidence, not memory.
import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api-m.sandbox.paypal.com";
const RESULTS = join(HERE, "results");
mkdirSync(RESULTS, { recursive: true });

function loadEnv() {
  const p = join(HERE, ".env");
  if (!existsSync(p)) die("Missing killtest/.env. Copy .env.example and fill it in.");
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) if (!process.env[k]) die(`${k} is empty in .env`);
}

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

function log(entry) {
  appendFileSync(join(RESULTS, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

let cachedToken;
async function token() {
  if (cachedToken) return cachedToken;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) die(`OAuth failed (${r.status}): ${JSON.stringify(j)}`);
  // The granted scopes tell us up front whether DISPUTE_CREATE was provisioned.
  log({ step: "oauth", status: r.status, scopes: j.scope });
  cachedToken = j.access_token;
  return cachedToken;
}

// One wrapper for every call: logs request summary and full response, never the secret.
async function call(step, method, path, { json, form, headers = {} } = {}) {
  const h = { Authorization: `Bearer ${await token()}`, ...headers };
  let body;
  if (json !== undefined) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form; // fetch sets the multipart boundary itself
  const r = await fetch(`${API}${path}`, { method, headers: h, body });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  log({ step, method, path, status: r.status, debug_id: r.headers.get("paypal-debug-id"), request: json ?? (form ? "[multipart]" : null), response: data });
  const ok = r.ok ? "✓" : "✗";
  console.log(`${ok} ${step}: ${method} ${path} -> ${r.status}`);
  if (!r.ok) console.log(JSON.stringify(data, null, 2));
  return { ok: r.ok, status: r.status, data };
}

const links = (d) => (d?.links ?? []).map((l) => l.rel);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Unsigned JWT exactly as PayPal's sandbox dispute docs describe: alg none, iss = client id, email = buyer.
function authAssertion() {
  if (!process.env.BUYER_EMAIL) die("BUYER_EMAIL is empty in .env");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID, email: process.env.BUYER_EMAIL })}.`;
}

const commands = {
  async scopes() {
    await token();
    const last = readFileSync(join(RESULTS, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.step === "oauth").pop();
    const s = last.scopes ?? "";
    for (const want of ["disputes/read-seller", "disputes/update-seller", "disputes/create", "disputes/read-buyer", "disputes/update-buyer"]) {
      console.log(`${s.includes(want) ? "✓" : "✗"} scope ${want}`);
    }
  },

  // Check 1a: custom_id length limit, using order creation only (no approval needed).
  async "customid-limit"() {
    for (const n of [64, 127, 128]) {
      const r = await call(`custom_id length ${n}`, "POST", "/v2/checkout/orders", {
        json: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, custom_id: "a".repeat(n) }] },
      });
      console.log(`  -> ${r.ok ? "accepted" : "rejected"}`);
    }
  },

  // Check 1b: create the order a dispute will target. The record hash rides in custom_id.
  async order(amount = "24.00") {
    const recordHash = sha256(`blackbox-killtest-${Date.now()}`);
    const r = await call("create order", "POST", "/v2/checkout/orders", {
      json: {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: amount }, custom_id: recordHash, description: "Black Box kill test jacket" }],
        payment_source: { paypal: { experience_context: { return_url: "https://example.com/return", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW" } } },
      },
    });
    if (!r.ok) return;
    writeFileSync(join(RESULTS, "last-order.json"), JSON.stringify({ id: r.data.id, recordHash, amount }, null, 2));
    const approve = r.data.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    console.log(`\nOrder ${r.data.id}  custom_id=${recordHash}`);
    console.log(`\nOpen this, log in as the sandbox BUYER, and approve:\n${approve}\n`);
    console.log("Then run: node kt.mjs capture");
  },

  async capture(id) {
    id ??= JSON.parse(readFileSync(join(RESULTS, "last-order.json"), "utf8")).id;
    const r = await call("capture order", "POST", `/v2/checkout/orders/${id}/capture`, { json: {} });
    if (!r.ok) return;
    const cap = r.data.purchase_units[0].payments.captures[0];
    const src = Object.keys(r.data.payment_source ?? {});
    console.log(`\nCapture ${cap.id}  status=${cap.status}  custom_id echoed=${cap.custom_id ?? "(not on capture)"}  funding=${src.join(",")}`);
    const saved = JSON.parse(readFileSync(join(RESULTS, "last-order.json"), "utf8"));
    writeFileSync(join(RESULTS, "last-order.json"), JSON.stringify({ ...saved, captureId: cap.id, captureStatus: cap.status }, null, 2));
    console.log("\nNext: node kt.mjs immutable   (checks custom_id cannot change after capture)");
    console.log("Then find the BUYER-side transaction ID: log in to sandbox.paypal.com as the buyer > Activity > this payment > Transaction ID");
  },

  // Check 1c: after capture, custom_id must not be editable.
  async immutable(id) {
    id ??= JSON.parse(readFileSync(join(RESULTS, "last-order.json"), "utf8")).id;
    const r = await call("patch custom_id after capture", "PATCH", `/v2/checkout/orders/${id}`, {
      json: [{ op: "replace", path: "/purchase_units/@reference_id=='default'/custom_id", value: "tampered" }],
    });
    console.log(r.ok ? "✗ custom_id was CHANGED after capture: binding is not tamper-proof" : "✓ custom_id cannot be changed after capture");
    const g = await call("get order", "GET", `/v2/checkout/orders/${id}`);
    console.log(`  custom_id now: ${g.data?.purchase_units?.[0]?.custom_id}`);
  },

  // Check 2 (API route): buyer creates the dispute. Expected to need the DISPUTE_CREATE scope.
  async "dispute-create"(buyerTxnId, reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", value = "24.00") {
    if (!buyerTxnId) die("Usage: node kt.mjs dispute-create <buyer_transaction_id> [reason] [amount]");
    const input = {
      disputed_transactions: [{ buyer_transaction_id: buyerTxnId }],
      reason,
      dispute_amount: { currency_code: "USD", value },
      extensions: { merchant_contacted: true, merchant_contacted_outcome: "NO_RESPONSE", merchandize_dispute_properties: { issue_type: "PRODUCT" } },
    };
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    const r = await call(`create dispute (${reason})`, "POST", "/v1/customer/disputes", { form, headers: { "PayPal-Auth-Assertion": authAssertion() } });
    if (r.ok) console.log(`\nDispute created: ${r.data?.links?.find((l) => l.rel === "self")?.href}`);
    else console.log("\nAPI route failed. Fallback: log in to sandbox.paypal.com as the buyer > Resolution Center > Report a problem, then run: node kt.mjs disputes");
  },

  async disputes() {
    const r = await call("list disputes", "GET", "/v1/customer/disputes?page_size=20");
    for (const d of r.data?.items ?? []) console.log(`  ${d.dispute_id}  ${d.reason}  ${d.status}  ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}`);
  },

  // Check 5 + binding: what each dispute exposes, and whether our custom_id is visible on it.
  async inspect(id) {
    if (!id) die("Usage: node kt.mjs inspect <dispute_id>");
    const r = await call("get dispute", "GET", `/v1/customer/disputes/${id}`);
    if (!r.ok) return;
    const d = r.data;
    console.log(`\n${d.dispute_id}  reason=${d.reason}  status=${d.status}  stage=${d.dispute_life_cycle_stage}`);
    for (const t of d.disputed_transactions ?? []) {
      console.log(`  seller_txn=${t.seller_transaction_id} buyer_txn=${t.buyer_transaction_id} custom=${t.custom ?? "(none)"} invoice=${t.invoice_number ?? "-"}`);
    }
    console.log(`  available actions: ${links(d).join(", ")}`);
    writeFileSync(join(RESULTS, `dispute-${id}.json`), JSON.stringify(d, null, 2));
  },

  async "require-evidence"(id, action = "SELLER_EVIDENCE") {
    if (!id) die("Usage: node kt.mjs require-evidence <dispute_id> [SELLER_EVIDENCE|BUYER_EVIDENCE]");
    await call(`require-evidence ${action}`, "POST", `/v1/customer/disputes/${id}/require-evidence`, { json: { action } });
    await commands.inspect(id);
  },

  // Check 3: multipart evidence upload, the known 415 / MISSING_OR_INVALID_REQUEST_BODY trap.
  async evidence(id) {
    if (!id) die("Usage: node kt.mjs evidence <dispute_id>");
    const input = {
      evidences: [{
        evidence_type: "OTHER",
        notes: "Black Box record: mandate, merchant-signed page snapshot and agent decision trail. Record hash is in the order custom_id.",
        documents: [{ name: "blackbox-record.txt" }],
      }],
    };
    const doc = `Black Box evidence pack (kill test)\nrecord_hash=${sha256("kill-test")}\n`;
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    form.append("file1", new Blob([doc], { type: "text/plain" }), "blackbox-record.txt");
    const r = await call("provide-evidence (multipart)", "POST", `/v1/customer/disputes/${id}/provide-evidence`, { form });
    console.log(r.ok ? "✓ evidence upload works" : "✗ evidence upload failed (see the response above and results/log.jsonl)");
  },

  // Check 4: partial refund. accept-claim first, make-offer as the fallback.
  async "partial-refund"(id, value = "9.00") {
    if (!id) die("Usage: node kt.mjs partial-refund <dispute_id> [amount]");
    const a = await call(`accept-claim PARTIAL_REFUND ${value}`, "POST", `/v1/customer/disputes/${id}/accept-claim`, {
      json: { note: "Black Box verdict: refund the out-of-scope amount only.", accept_claim_type: "PARTIAL_REFUND", refund_amount: { currency_code: "USD", value } },
    });
    if (a.ok) return console.log("✓ accept-claim with PARTIAL_REFUND works");
    const o = await call(`make-offer REFUND ${value}`, "POST", `/v1/customer/disputes/${id}/make-offer`, {
      json: { note: "Black Box verdict: refund the out-of-scope amount only.", offer_amount: { currency_code: "USD", value }, offer_type: "REFUND" },
    });
    console.log(o.ok ? "✓ make-offer works (partial refund path, needs buyer acceptance)" : "✗ neither partial-refund path worked");
  },

  // AGENT path without closing the dispute: offer only the out-of-scope amount.
  async offer(id, value = "9.00") {
    if (!id) die("Usage: node kt.mjs offer <dispute_id> [amount]");
    const o = await call(`make-offer REFUND ${value}`, "POST", `/v1/customer/disputes/${id}/make-offer`, {
      json: { note: "Black Box verdict: refund the out-of-scope amount only.", offer_amount: { currency_code: "USD", value }, offer_type: "REFUND" },
    });
    console.log(o.ok ? "✓ make-offer works (partial refund, needs buyer acceptance)" : "✗ make-offer failed");
    await commands.inspect(id);
  },

  async escalate(id) {
    if (!id) die("Usage: node kt.mjs escalate <dispute_id>");
    await call("escalate to claim", "POST", `/v1/customer/disputes/${id}/escalate`, { json: { note: "Black Box: escalating so evidence can be reviewed." } });
    await commands.inspect(id);
  },

  async adjudicate(id, outcome = "SELLER_FAVOR") {
    if (!id) die("Usage: node kt.mjs adjudicate <dispute_id> [SELLER_FAVOR|BUYER_FAVOR]");
    await call(`adjudicate ${outcome}`, "POST", `/v1/customer/disputes/${id}/adjudicate`, { json: { adjudication_outcome: outcome } });
    await commands.inspect(id);
  },

  help() {
    console.log(`Kill test, in order:
  scopes                         which dispute scopes this app actually has
  customid-limit                 check 1a: custom_id accepts 64 / 127 / 128 chars?
  order [amount]                 check 1b: create an order (prints the buyer approval link)
  capture [order_id]             capture it after the buyer approves
  immutable [order_id]           check 1c: custom_id cannot change after capture
  dispute-create <buyer_txn> [reason] [amount]   check 2: API route (needs DISPUTE_CREATE scope)
  disputes                       list disputes (use after the Resolution Center fallback)
  inspect <dispute_id>           check 5: status, available actions, is custom_id visible
  require-evidence <id> [action] move to WAITING_FOR_SELLER_RESPONSE
  evidence <id>                  check 3: multipart provide-evidence
  partial-refund <id> [amount]   check 4: accept-claim PARTIAL_REFUND, then make-offer
  adjudicate <id> [outcome]      close the loop in sandbox`);
  },
};

const [cmd = "help", ...args] = process.argv.slice(2);
if (!commands[cmd]) die(`Unknown command "${cmd}". Run: node kt.mjs help`);
if (cmd !== "help") loadEnv();
await commands[cmd](...args);
