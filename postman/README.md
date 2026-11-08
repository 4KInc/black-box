# Postman collection

[`black-box.postman_collection.json`](black-box.postman_collection.json) holds every PayPal
sandbox call Black Box makes, with the same method, path and body as the code. Each request names
the file that makes it. A test (`postman/test/collection.test.mjs`) fails if the code calls a
PayPal path the collection does not have, or the other way round.

| Folder | Requests | Made by |
|---|---|---|
| 0. Auth | merchant token, agent operator token | `lib/paypal.mjs` |
| 1. Checkout | create order (record hash in `custom_id`), capture, create order with a saved wallet | `shop/server.mjs` |
| 2. Saved wallet | setup token, payment token, delete | `lab/live.mjs` |
| 3. Webhooks | register, verify a delivery | `executor/webhook.mjs` |
| 4. Dispute resolution | list, get dispute, get capture, get order, escalate, accept claim (full and partial), make offer, provide evidence | `executor/watch.mjs`, `executor/core.mjs` |
| 5. Payouts | create payout, get batch | `executor/payout.mjs` |

## Use it

1. In Postman, **Import** the JSON file.
2. In the collection's variables, set `client_id` and `client_secret` to the merchant's sandbox
   REST app (for the payouts, also `operator_client_id` and `operator_client_secret`). The
   committed file has them empty. Keep the values in Postman, never in this file.
3. Run **0. Auth → Get access token**. Requests then pass IDs along by themselves: creating an
   order saves `order_id`, getting a dispute saves `capture_id`, and so on.

`base_url` is the sandbox. Capture, the saved-wallet order, accept claim, make offer and the payout
move sandbox money.

The JSON is generated: change `postman/build.mjs`, then run `node postman/build.mjs`.
