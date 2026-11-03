# The hosted replay, bench, study and live lab on Cloud Run, from the committed fixtures. The same
# image runs the hosted live demo (LIVE_DIR set) and the hosted shop and review platform
# (shop/main.mjs with SHOP_ROLE); see scripts/deploy-live.md. Cloud Run sets PORT.
FROM node:24.11.1-slim
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 NODE_ENV=production
USER node
CMD ["node", "lab/hosted.mjs"]
