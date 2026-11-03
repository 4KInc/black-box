# Deploying the hosted live demo

Three Cloud Run services in project `black-box-4kinc`, region `us-central1`, all from the one image
this repo builds, all against the PayPal **sandbox**:

| Service | Runs | URL |
|---|---|---|
| `black-box` | `lab/hosted.mjs` with `LIVE_DIR`: the replay, bench, study and lab, plus `/mandate/`, `/operator`, `/paypal/webhook` and the dispute autopilot | https://black-box-342881585799.us-central1.run.app |
| `driftwood-outfitters` | `shop/main.mjs`, `SHOP_ROLE=shop`: the demo shop, with its hidden note for AI agents | https://driftwood-outfitters-342881585799.us-central1.run.app |
| `trailhead-reviews` | `shop/main.mjs`, `SHOP_ROLE=reviews`: the third-party review platform's key set | https://trailhead-reviews-342881585799.us-central1.run.app |

Live runs, their PayPal execution logs, and the mandates and passkeys made on the site are kept in
the bucket `gs://black-box-4kinc-live`, mounted at `/data` in `black-box`. That service runs as one
instance (`--max-instances 1`), so only one autopilot ever acts.

Every command below passes `--project black-box-4kinc`. No secret value is printed. The commands
read each value from the local `.env`, `killtest/.env` or a freshly generated key.

## 1. Secrets

```sh
P=black-box-4kinc
val() { grep "^$1=" "$2" | cut -d= -f2-; }
node -e 'import("./lib/sig.mjs").then(m=>process.stdout.write(JSON.stringify(m.generateKey())))' | gcloud secrets create shop-jwk --data-file=- --project $P
node -e 'import("./lib/sig.mjs").then(m=>process.stdout.write(JSON.stringify(m.generateKey())))' | gcloud secrets create reviews-jwk --data-file=- --project $P
val PAYPAL_CLIENT_ID killtest/.env     | tr -d '\n' | gcloud secrets create paypal-client-id --data-file=- --project $P
val PAYPAL_CLIENT_SECRET killtest/.env | tr -d '\n' | gcloud secrets create paypal-client-secret --data-file=- --project $P
val ANTHROPIC_API_KEY .env             | tr -d '\n' | gcloud secrets create anthropic-api-key --data-file=- --project $P
# The operator password: kept in .env (gitignored) as OPERATOR_KEY, never printed.
grep -q '^OPERATOR_KEY=' .env || echo "OPERATOR_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')" >> .env
val OPERATOR_KEY .env                  | tr -d '\n' | gcloud secrets create operator-key --data-file=- --project $P

SA=$(gcloud iam service-accounts list --project $P --filter='email~compute@developer' --format='value(email)')
for s in shop-jwk reviews-jwk paypal-client-id paypal-client-secret anthropic-api-key operator-key; do
  gcloud secrets add-iam-policy-binding $s --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $P
done
```

## 2. The bucket

```sh
gcloud storage buckets create gs://black-box-4kinc-live --location us-central1 --uniform-bucket-level-access --project $P
gcloud storage buckets add-iam-policy-binding gs://black-box-4kinc-live --member serviceAccount:$SA --role roles/storage.objectAdmin --project $P
```

## 3. Black Box (builds the image)

```sh
gcloud run deploy black-box --source . --region us-central1 --project $P --quiet \
  --min-instances 1 --max-instances 1 --execution-environment gen2 \
  --add-volume name=live,type=cloud-storage,bucket=black-box-4kinc-live --add-volume-mount volume=live,mount-path=/data \
  --set-env-vars LIVE_DIR=/data,PUBLIC_ORIGIN=https://black-box-342881585799.us-central1.run.app,SHOP_URL=https://driftwood-outfitters-342881585799.us-central1.run.app,AUTO_EXECUTE=on,BUYER_PAYER_ID=$(val BUYER_PAYER_ID .env) \
  --set-secrets PAYPAL_CLIENT_ID=paypal-client-id:latest,PAYPAL_CLIENT_SECRET=paypal-client-secret:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,OPERATOR_KEY=operator-key:latest
IMG=$(gcloud run services describe black-box --region us-central1 --project $P --format='value(spec.template.spec.containers[0].image)')
```

## 4. The review platform and the shop (same image)

```sh
gcloud run deploy trailhead-reviews --image $IMG --region us-central1 --project $P --quiet --allow-unauthenticated \
  --command node --args shop/main.mjs --set-env-vars SHOP_ROLE=reviews --set-secrets REVIEWS_JWK=reviews-jwk:latest
gcloud run deploy driftwood-outfitters --image $IMG --region us-central1 --project $P --quiet --allow-unauthenticated --min-instances 1 \
  --command node --args shop/main.mjs \
  --set-env-vars SHOP_ROLE=shop,SHOP_ORIGIN=https://driftwood-outfitters-342881585799.us-central1.run.app,REVIEWS_ORIGIN=https://trailhead-reviews-342881585799.us-central1.run.app \
  --set-secrets SHOP_JWK=shop-jwk:latest,REVIEWS_JWK=reviews-jwk:latest,PAYPAL_CLIENT_ID=paypal-client-id:latest,PAYPAL_CLIENT_SECRET=paypal-client-secret:latest
```

## 5. PayPal's webhook

```sh
node executor/webhook.mjs --register https://black-box-342881585799.us-central1.run.app/paypal/webhook
# prints PAYPAL_WEBHOOK_ID=...; set it on the service (it is an ID, not a secret):
gcloud run services update black-box --region us-central1 --project $P --update-env-vars PAYPAL_WEBHOOK_ID=<id>
```

Until it is set, the autopilot still picks up new disputes by polling every 30 seconds.

## 6. Check it

- `https://driftwood-outfitters-…/` shows the shop; `/.well-known/jwks.json` returns its key.
- `https://black-box-…/operator` asks for the operator password (the user name can be anything).
- `https://black-box-…/mandate/`: enrol Touch ID once for the buyer's payer ID on this domain, then
  approve a mandate. Run the agent from `/operator`, pay through the link it gives, and dispute in
  the sandbox. The run appears on Recordings, tagged **Live run**, with PayPal's outcome once the
  autopilot has acted.
- Logs: `gcloud run services logs read black-box --region us-central1 --project $P`.
