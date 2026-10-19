# The hosted replay, bench, study and live lab on Cloud Run. Committed fixtures only: no keys,
# no PayPal calls. Cloud Run sets PORT.
FROM node:24.11.1-slim
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 NODE_ENV=production
USER node
CMD ["node", "lab/hosted.mjs"]
