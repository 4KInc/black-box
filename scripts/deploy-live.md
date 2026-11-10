# Deploying the hosted live demo

Three Cloud Run services in project `black-box-4kinc`, region `us-central1`, all from the one image
this repo builds, all against the PayPal **sandbox**:

| Service | Runs | URL |
|---|---|---|
| `black-box` | `lab/hosted.mjs` with `LIVE_DIR`: the replay, bench, study and lab, plus `/mandate/`, `/operator`, `/paypal/webhook` and the dispute autopilot | https://black-box-342881585799.us-central1.run.app |
| `driftwood-outfitters` | `shop/main.mjs`, `SHOP_ROLE=shop`, `SHOP_VARIANTS=on`: the demo shop, with its hidden note for AI agents, and its control and honest-price variants under `/v/control/` and `/v/<key>/` (the bench's Llama recordings were made on these) | https://driftwood-outfitters-342881585799.us-central1.run.app |
| `northline-audio` | `shop/main.mjs`, `SHOP_ROLE=shop`, `SHOP_CATALOG=audio`: the headphones shop of study setup 2, signed with its own key; the recordings of runs that bought nothing were made on it and on Driftwood | https://northline-audio-342881585799.us-central1.run.app |
| `trailhead-reviews` | `shop/main.mjs`, `SHOP_ROLE=reviews`: the third-party review platform's key set, and a home page listing the reviews it signed, linked to the shop | https://trailhead-reviews-342881585799.us-central1.run.app |

Live runs, their PayPal execution logs, and the mandates and passkeys made on the site are kept in
the bucket `gs://black-box-4kinc-live`, mounted at `/data` in `black-box`. That service runs as one
instance (`--max-instances 1`), so only one autopilot ever acts.

Every command below passes `--project black-box-4kinc`. No secret value is printed. The commands
read each value from the local `.env`, `killtest/.env` or a freshly generated key.

## 1. Secrets

Turn on the API once: `gcloud services enable secretmanager.googleapis.com --project black-box-4kinc`.

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
gcloud run deploy trailhead-reviews --image $IMG --region us-central1 --project $P --quiet \
  --command node --args shop/main.mjs \
  --set-env-vars SHOP_ROLE=reviews,SHOP_ORIGIN=https://driftwood-outfitters-342881585799.us-central1.run.app,AUDIO_SHOP_ORIGIN=https://northline-audio-342881585799.us-central1.run.app,REVIEWS_ORIGIN=https://trailhead-reviews-342881585799.us-central1.run.app \
  --set-secrets REVIEWS_JWK=reviews-jwk:latest
gcloud run deploy driftwood-outfitters --image $IMG --region us-central1 --project $P --quiet --min-instances 1 \
  --command node --args shop/main.mjs \
  --set-env-vars SHOP_ROLE=shop,SHOP_VARIANTS=on,SHOP_VAULT_PAY=on,SHOP_ORIGIN=https://driftwood-outfitters-342881585799.us-central1.run.app,REVIEWS_ORIGIN=https://trailhead-reviews-342881585799.us-central1.run.app \
  --set-secrets SHOP_JWK=shop-jwk:latest,REVIEWS_JWK=reviews-jwk:latest,PAYPAL_CLIENT_ID=paypal-client-id:latest,PAYPAL_CLIENT_SECRET=paypal-client-secret:latest
# Northline Audio, added 2026-11-06, with its own key (shop-audio-jwk, made like shop-jwk in step 1).
gcloud run deploy northline-audio --image $IMG --region us-central1 --project $P --quiet \
  --command node --args shop/main.mjs \
  --set-env-vars SHOP_ROLE=shop,SHOP_CATALOG=audio,SHOP_ORIGIN=https://northline-audio-342881585799.us-central1.run.app,REVIEWS_ORIGIN=https://trailhead-reviews-342881585799.us-central1.run.app \
  --set-secrets SHOP_JWK=shop-audio-jwk:latest,REVIEWS_JWK=reviews-jwk:latest,PAYPAL_CLIENT_ID=paypal-client-id:latest,PAYPAL_CLIENT_SECRET=paypal-client-secret:latest
# Public like black-box: the project does not allow allUsers IAM bindings, so the invoker check is off.
for s in trailhead-reviews driftwood-outfitters northline-audio; do gcloud run services update $s --region us-central1 --project $P --no-invoker-iam-check --quiet; done
```

## 5. PayPal's webhook

```sh
node executor/webhook.mjs --register https://black-box-342881585799.us-central1.run.app/paypal/webhook
# prints PAYPAL_WEBHOOK_ID=...; set it on the service (it is an ID, not a secret). Registered 2026-11-03: 4E918476RU7982112
gcloud run services update black-box --region us-central1 --project $P --update-env-vars PAYPAL_WEBHOOK_ID=<id>
```

Until it is set, the autopilot still picks up new disputes by polling every 30 seconds.

## 6. Muse Spark on /operator (optional)

The agent can also run on Meta's Muse Spark (`muse-spark-1.3`) through Meta's Model API. It is
offered on `/operator` only when the service has `MODEL_API_KEY`. Added 2026-11-03:

```sh
val MODEL_API_KEY .env | tr -d '\n' | gcloud secrets create model-api-key --data-file=- --project $P
gcloud secrets add-iam-policy-binding model-api-key --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $P
gcloud run services update black-box --region us-central1 --project $P --update-secrets MODEL_API_KEY=model-api-key:latest
```

`--update-secrets` adds the key and keeps the service's other settings; no rebuild is needed. The
Meta team behind the key needs billing set up first, or every call fails with HTTP 402.

## 7. OpenAI, Google and xAI models on /operator (optional)

GPT-5.5, GPT-4o mini, Gemini 3.1 Pro, Gemini 3.5 Flash-Lite, Grok 4.7 and Grok 4.20 are offered
on `/operator` only when the service has that provider's key. Added 2026-11-07:

```sh
for k in openai-api-key:OPENAI_API_KEY gemini-api-key:GEMINI_API_KEY xai-api-key:XAI_API_KEY; do
  val ${k#*:} .env | tr -d '\n' | gcloud secrets create ${k%%:*} --data-file=- --project $P
  gcloud secrets add-iam-policy-binding ${k%%:*} --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $P
done
gcloud run services update black-box --region us-central1 --project $P \
  --update-secrets OPENAI_API_KEY=openai-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest,XAI_API_KEY=xai-api-key:latest
```

The small open models from the study (Qwen, Mistral, Llama) run on a local `mlx_lm.server`, so
the hosted demo cannot offer them.

## 8. The agent pays by itself (saved PayPal wallet)

Driftwood runs with `SHOP_VAULT_PAY=on` (step 4), so an agent may pay with the buyer's saved
PayPal wallet: PayPal charges it at once, with no approval screen. The buyer saves it once on
`/wallet` (operator password), approving on PayPal; the saved token stays in the bucket as
`wallet.json` and is never shown or recorded. `/operator` then pays from it by default. The
sandbox app needs PayPal's saved payment methods (vault), which it has. Added 2026-11-07; on a
running shop: `gcloud run services update driftwood-outfitters --region us-central1 --project $P --update-env-vars SHOP_VAULT_PAY=on`.

## 9. Caps on the live demo (submission deploy, 2026-11-08)

`/operator` allows `LIVE_MAX_RUNS_PER_DAY` agent runs per UTC day (default 25, counted in
`LIVE_DIR/live-runs.json`) and offers only the models in `LIVE_MODELS`. Run for the submission,
on top of the settings above (`--update-env-vars` keeps every other variable and secret):

```sh
gcloud run deploy black-box --source . --region us-central1 --project $P --quiet \
  --update-env-vars '^;^LIVE_MAX_RUNS_PER_DAY=25;LIVE_MODELS=claude-haiku-4-5-20251001,claude-sonnet-5-5,gpt-4o-mini-2024-07-18'
node scripts/live.mjs preflight   # preflight ok: Anthropic key answers, PayPal sandbox token issued, flagger on
```

That made revision `black-box-00063-752`. The front-page change after it was deployed with the
same command and no flags (every setting above is kept), as revision `black-box-00064-4mh`, the animated front page after it as `black-box-00065-cfc`, the "shopping app" wording as `black-box-00066-z6h`, the shorter pages as `black-box-00067-pkd`, the data plate as `black-box-00068-7qv`, the nav link to the AG Grid explorer as `black-box-00069-f4r`, the links into its ledger and fact tables as `black-box-00070-dh2`, the judges' page as `black-box-00071-hpc`, its visual cards as `black-box-00072-b8r`, the simpler cards as `black-box-00073-xfw`, the page-wide polish as `black-box-00074-cnl`, the plainer pages as `black-box-00075-6xj`, the shorter demo intro as `black-box-00076-55t`, and the hardened executor (attempts, settlement, timeouts) as `black-box-00077-hsn`, with the shops driftwood-outfitters `00006-r5p` and northline-audio `00002-plh` redeployed on its image for the PayPal client timeouts, and the lab banner that shows its work as `black-box-00078-jkd`. The
shops were not redeployed: their code did not change. Checked:
`/demo`, `/lab`, `/bench` and `/lab/facts` return 200; `/operator` and `/mandate/` return 401
without the password; `/bench` reads 62 of 62; `/operator` shows "25 of 25 runs left today" and
offers exactly the three models above. Judges without a passkey device use a mandate approved in
advance: approve one at `/mandate/` valid for 40 days, so it is in force through judging
(15 December 2026), since `/operator` offers only mandates in force.

## 10. Check it

- `https://driftwood-outfitters-…/` and `https://northline-audio-…/` show the shops; `/.well-known/jwks.json` returns each one's key.
- `https://black-box-…/operator` asks for the operator password (the user name can be anything).
- `https://black-box-…/mandate/`: enrol Touch ID once for the buyer's payer ID on this domain, then
  approve a mandate. Run the agent from `/operator`, pay through the link it gives, and dispute in
  the sandbox. The run appears on Recordings, tagged **Live run**, with PayPal's outcome once the
  autopilot has acted.
- Logs: `gcloud run services logs read black-box --region us-central1 --project $P`.
