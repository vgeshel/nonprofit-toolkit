FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/slack-bot/package.json apps/slack-bot/
COPY apps/runner/package.json apps/runner/
COPY packages/letter/package.json packages/letter/
COPY packages/types/package.json packages/types/
COPY packages/bq/package.json packages/bq/
COPY packages/connectors/package.json packages/connectors/
RUN bun install --frozen-lockfile
COPY packages/ packages/
COPY apps/slack-bot/ apps/slack-bot/
RUN bun build apps/slack-bot/src/main.ts --outdir dist --target bun \
    --external playwright --external playwright-core --external @slack/bolt --external @slack/web-api

FROM oven/bun:1
RUN apt-get update && apt-get install -y \
    chromium fonts-liberation libgbm1 libnss3 libxss1 libasound2 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV LOGO_PATH=/app/packages/letter/assets/logo.png
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/letter/assets ./packages/letter/assets
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "dist/main.js"]
