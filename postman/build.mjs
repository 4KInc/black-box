// Builds the Postman collection of every PayPal sandbox call Black Box makes, with the same
// method, path and body as the code (each request names its source). No secrets: the client ID
// and secret are empty collection variables you fill in Postman.
//   node postman/build.mjs   -> postman/black-box.postman_collection.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUT = join(import.meta.dirname, 'black-box.postman_collection.json');

const json = (obj) => ({ mode: 'raw', raw: JSON.stringify(obj, null, 2), options: { raw: { language: 'json' } } });
// Saves fields of the JSON response as collection variables, so the next request can use them.
const save = (pairs) => [{
  listen: 'test',
  script: { type: 'text/javascript', exec: [
    'const j = pm.response.json();',
    ...Object.entries(pairs).map(([name, expr]) => `if (${expr} !== undefined) pm.collectionVariables.set('${name}', ${expr});`),
  ] },
}];

function request(name, method, path, { body, source, description = '', events, token = 'access_token', headers = [] }) {
  return {
    name,
    ...(events ? { event: events } : {}),
    request: {
      method,
      auth: { type: 'bearer', bearer: [{ key: 'token', value: `{{${token}}}`, type: 'string' }] },
      header: headers,
      ...(body ? { body } : {}),
      url: `{{base_url}}${path}`,
      description: `${description}${description ? '\n\n' : ''}Source: \`${source}\``,
    },
  };
}

function tokenRequest(name, { id, secret, saveAs, description }) {
  return {
    name,
    event: save({ [saveAs]: 'j.access_token' }),
    request: {
      method: 'POST',
      auth: { type: 'basic', basic: [{ key: 'username', value: `{{${id}}}`, type: 'string' }, { key: 'password', value: `{{${secret}}}`, type: 'string' }] },
      header: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }] },
      url: '{{base_url}}/v1/oauth2/token',
      description: `${description}\n\nSource: \`lib/paypal.mjs\` (createPayPal)`,
    },
  };
}

const usd = (value) => ({ currency_code: 'USD', value });
const NOTE = 'Black Box verdict MERCHANT (rule 2). Record {{record_hash}}.';
const ORDER_UNIT = {
  reference_id: 'default',
  custom_id: '{{record_hash}}',
  description: 'Summit Pro Shell (RJ-PREMIUM-BLUE-M)',
  amount: { ...usd('240.00'), breakdown: { item_total: usd('240.00') } },
  items: [{ name: 'Summit Pro Shell', sku: 'RJ-PREMIUM-BLUE-M', quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: usd('240.00') }],
};

export const COLLECTION = {
  info: {
    name: 'Black Box: PayPal sandbox calls',
    description: [
      'Every PayPal REST call Black Box makes, in the order a case uses them: the shop takes payment with the agent\'s record hash in `custom_id`, a buyer disputes, and Black Box reads the dispute and carries out its verdict. Each request names the file that makes it; method, path and body match the code.',
      '',
      'Sandbox only. Set `client_id` and `client_secret` (the merchant\'s sandbox REST app) and run **Get access token** first. The payout requests use the agent operator\'s own app: `operator_client_id`, `operator_client_secret`, then **Get operator access token**.',
      '',
      'Requests that move sandbox money: Capture order, Create order with saved wallet, Accept claim, Make offer, Create payout.',
      '',
      'Built by `node postman/build.mjs`; see `postman/README.md`.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['base_url', 'https://api-m.sandbox.paypal.com'],
    ['client_id', ''], ['client_secret', ''], ['access_token', ''],
    ['operator_client_id', ''], ['operator_client_secret', ''], ['operator_access_token', ''],
    ['record_hash', '028c1c5b89bf2800ca6a06ac7ecef846f21fbbdd6f00b280b88f8d18ed8342b6'],
    ['shop_origin', 'https://driftwood-outfitters-342881585799.us-central1.run.app'],
    ['order_id', ''], ['capture_id', ''], ['dispute_id', ''],
    ['setup_token', ''], ['vault_id', ''],
    ['webhook_url', 'https://black-box-342881585799.us-central1.run.app/paypal/webhook'], ['webhook_id', ''],
    ['merchant_id', 'MCYKQUXGB936U'], ['payout_batch_id', ''],
  ].map(([key, value]) => ({ key, value, type: 'string' })),
  item: [
    { name: '0. Auth', item: [
      tokenRequest('Get access token', { id: 'client_id', secret: 'client_secret', saveAs: 'access_token', description: 'The merchant\'s token, used by every request except the payouts.' }),
      tokenRequest('Get operator access token', { id: 'operator_client_id', secret: 'operator_client_secret', saveAs: 'operator_access_token', description: 'The agent operator\'s token, for the payouts that repay a merchant when the agent was at fault.' }),
    ] },
    { name: '1. Checkout (the demo shop)', item: [
      request('Create order', 'POST', '/v2/checkout/orders', {
        source: 'shop/server.mjs (checkout)',
        description: 'The shop creates the order at its signed catalog price and puts the agent\'s record hash in `custom_id`, which binds the record to the payment. The buyer approves at the `payer-action` link.',
        body: json({ intent: 'CAPTURE', purchase_units: [ORDER_UNIT], payment_source: { paypal: { experience_context: {
          brand_name: 'Driftwood Outfitters', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
          return_url: '{{shop_origin}}/paypal/return', cancel_url: '{{shop_origin}}/paypal/cancel',
        } } } }),
        events: save({ order_id: 'j.id' }),
      }),
      request('Capture order', 'POST', '/v2/checkout/orders/{{order_id}}/capture', {
        source: 'shop/server.mjs (paypalReturn)',
        description: 'After the buyer approves, the merchant captures at once.',
        body: json({}),
        events: save({ capture_id: 'j.purchase_units?.[0]?.payments?.captures?.[0]?.id' }),
      }),
      request('Create order with saved wallet', 'POST', '/v2/checkout/orders', {
        source: 'shop/server.mjs (checkout, vault_id)',
        description: 'The agent pays by itself with the buyer\'s saved wallet: PayPal charges it at once, with no checkout screen. The request ID is the record hash, so one record can never be charged twice.',
        headers: [{ key: 'PayPal-Request-Id', value: 'blackbox-{{record_hash}}' }],
        body: json({ intent: 'CAPTURE', purchase_units: [ORDER_UNIT], payment_source: { paypal: { vault_id: '{{vault_id}}' } } }),
        events: save({ order_id: 'j.id', capture_id: 'j.purchase_units?.[0]?.payments?.captures?.[0]?.id' }),
      }),
    ] },
    { name: '2. Saved wallet (the live demo\'s /wallet)', item: [
      request('Create setup token', 'POST', '/v3/vault/setup-tokens', {
        source: 'lab/live.mjs (/wallet/connect)',
        description: 'Starts saving the buyer\'s PayPal wallet. The buyer approves once at the `approve` link.',
        body: json({ payment_source: { paypal: {
          usage_type: 'MERCHANT', usage_pattern: 'IMMEDIATE',
          description: 'Lets the shopping agent pay at Driftwood Outfitters without a checkout screen',
          experience_context: { return_url: 'https://black-box-342881585799.us-central1.run.app/wallet/return', cancel_url: 'https://black-box-342881585799.us-central1.run.app/wallet', vault_instruction: 'ON_PAYER_APPROVAL', shipping_preference: 'NO_SHIPPING' },
        } } }),
        events: save({ setup_token: 'j.id' }),
      }),
      request('Create payment token', 'POST', '/v3/vault/payment-tokens', {
        source: 'lab/live.mjs (/wallet/return)',
        description: 'Turns the approved setup token into the saved wallet (`vault_id`).',
        body: json({ payment_source: { token: { id: '{{setup_token}}', type: 'SETUP_TOKEN' } } }),
        events: save({ vault_id: 'j.id' }),
      }),
      request('Delete payment token', 'DELETE', '/v3/vault/payment-tokens/{{vault_id}}', {
        source: 'lab/live.mjs (/wallet/forget)',
        description: 'Forgets the saved wallet.',
      }),
    ] },
    { name: '3. Webhooks', item: [
      request('Register webhook', 'POST', '/v1/notifications/webhooks', {
        source: 'executor/webhook.mjs (--register)',
        description: 'Subscribes Black Box to dispute events.',
        body: json({ url: '{{webhook_url}}', event_types: [{ name: 'CUSTOMER.DISPUTE.CREATED' }, { name: 'CUSTOMER.DISPUTE.UPDATED' }] }),
        events: save({ webhook_id: 'j.id' }),
      }),
      request('Verify webhook signature', 'POST', '/v1/notifications/verify-webhook-signature', {
        source: 'executor/webhook.mjs (paypalVerifier)',
        description: 'Every delivery is checked with PayPal before Black Box acts on it. The values come from the delivery\'s `PayPal-*` headers and its body.',
        body: json({ auth_algo: 'SHA256withRSA', cert_url: '', transmission_id: '', transmission_sig: '', transmission_time: '', webhook_id: '{{webhook_id}}', webhook_event: {} }),
      }),
    ] },
    { name: '4. Dispute resolution (executor)', item: [
      request('List disputes', 'GET', '/v1/customer/disputes?page_size=50', {
        source: 'executor/watch.mjs (openDisputes)',
        description: 'The watcher polls this; open disputes go to the autopilot.',
        events: save({ dispute_id: 'j.items?.[0]?.dispute_id' }),
      }),
      request('Get dispute', 'GET', '/v1/customer/disputes/{{dispute_id}}', {
        source: 'executor/core.mjs (resolveDispute)',
        description: '`disputed_transactions[0].custom` is the record hash; the seller, buyer and amount feed the record checks, and `links` say which actions PayPal allows now.',
        events: save({ capture_id: 'j.disputed_transactions?.[0]?.seller_transaction_id' }),
      }),
      request('Get capture', 'GET', '/v2/payments/captures/{{capture_id}}', {
        source: 'executor/core.mjs (resolveDispute)',
        description: 'Finds the order behind the disputed capture.',
        events: save({ order_id: 'j.supplementary_data?.related_ids?.order_id' }),
      }),
      request('Get order', 'GET', '/v2/checkout/orders/{{order_id}}', {
        source: 'executor/core.mjs (resolveDispute)',
        description: 'The order\'s `create_time`: the shop\'s pages must be signed before it, and an unsigned mandate counts only if the payer had no passkey yet.',
      }),
      request('Escalate (USER: an inquiry, before evidence)', 'POST', '/v1/customer/disputes/{{dispute_id}}/escalate', {
        source: 'executor/core.mjs (escalate)',
        description: 'PayPal takes evidence only on a claim, so an inquiry is escalated once first.',
        body: json({ note: 'Black Box verdict USER (rule 6): the purchase was within the buyer\'s mandate. Escalating so PayPal can review the evidence. Record {{record_hash}}.' }),
      }),
      request('Accept claim (MERCHANT: full refund)', 'POST', '/v1/customer/disputes/{{dispute_id}}/accept-claim', {
        source: 'executor/core.mjs (act, claimAcceptance)',
        description: 'The merchant\'s own hidden text misled the agent: refund in full. On an AGENT case where the buyer disputed only the overage, the same call refunds that amount in full.',
        body: json({ note: NOTE, accept_claim_type: 'REFUND', refund_amount: usd('240.00') }),
      }),
      request('Accept claim (AGENT: the amount over budget)', 'POST', '/v1/customer/disputes/{{dispute_id}}/accept-claim', {
        source: 'executor/core.mjs (act, claimAcceptance)',
        description: 'A refund smaller than the disputed amount is sent as `PARTIAL_REFUND`. The code notes that PayPal refuses it on an "incorrect amount" claim for only the overage, which is why that case accepts in full (the request above).',
        body: json({ note: 'Black Box verdict AGENT (rule 5). Record {{record_hash}}.', accept_claim_type: 'PARTIAL_REFUND', refund_amount: usd('90.00') }),
      }),
      request('Make offer (AGENT, "unauthorised")', 'POST', '/v1/customer/disputes/{{dispute_id}}/make-offer', {
        source: 'executor/core.mjs (act)',
        description: 'Offers the amount over budget; the buyer must accept.',
        body: json({ note: 'Black Box verdict AGENT (rule 5). Record {{record_hash}}.', offer_type: 'REFUND', offer_amount: usd('90.00') }),
      }),
      request('Provide evidence (USER)', 'POST', '/v1/customer/disputes/{{dispute_id}}/provide-evidence', {
        source: 'executor/core.mjs (act)',
        description: 'Defends an honest purchase: a checked note, the statements it was written from and the full record, as one text file. Choose the file for `file1` in Postman.',
        body: { mode: 'formdata', formdata: [
          { key: 'input', type: 'text', contentType: 'application/json', value: JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: 'Black Box verdict USER (rule 6). Record {{record_hash}}.', documents: [{ name: 'blackbox-evidence.txt' }] }] }) },
          { key: 'file1', type: 'file', src: [] },
        ] },
      }),
    ] },
    { name: '5. Payouts (the operator repays the merchant)', item: [
      request('Create payout', 'POST', '/v1/payments/payouts', {
        source: 'executor/payout.mjs (reimburse)',
        token: 'operator_access_token',
        description: 'On an AGENT verdict the merchant refunded the overage; the agent operator\'s account pays it back. PayPal refuses a second batch with the same `sender_batch_id`.',
        body: json({
          sender_batch_header: {
            sender_batch_id: 'blackbox-{{dispute_id}}',
            email_subject: 'Agent operator reimbursement',
            email_message: 'Reimbursing the refund on dispute {{dispute_id}}: the agent exceeded the buyer\'s mandate.',
          },
          items: [{ recipient_type: 'PAYPAL_ID', receiver: '{{merchant_id}}', amount: { currency: 'USD', value: '90.00' }, sender_item_id: '{{dispute_id}}',
            note: 'Black Box verdict AGENT on {{dispute_id}}: the operator\'s agent overspent; this repays the merchant\'s refund.' }],
        }),
        events: save({ payout_batch_id: 'j.batch_header?.payout_batch_id' }),
      }),
      request('Get payout batch', 'GET', '/v1/payments/payouts/{{payout_batch_id}}', {
        source: 'executor/payout.mjs (reimburse, refreshPayout)',
        token: 'operator_access_token',
        description: 'The batch and item status, logged after a payout and on `--refresh`.',
      }),
    ] },
  ],
};

if (import.meta.main) {
  writeFileSync(OUT, JSON.stringify(COLLECTION, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
}
