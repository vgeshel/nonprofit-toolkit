# Donations ETL Docker Image
# Build: docker build -t donations-etl .
# Run:   docker run donations-etl daily

# === Build Stage ===
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY packages/connectors/package.json packages/connectors/
COPY packages/bq/package.json packages/bq/
COPY packages/letter/package.json packages/letter/
COPY apps/runner/package.json apps/runner/
COPY apps/service/package.json apps/service/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the project
RUN bun run build

# === Runtime Stage ===
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Create non-root user for security (use IDs that don't conflict with base image)
RUN groupadd --gid 10001 etl && \
    useradd --uid 10001 --gid etl --shell /bin/bash --create-home etl

# Copy built artifacts and runtime dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules

# Set environment
ENV NODE_ENV=production

# Switch to non-root user
USER etl

# Default command (can be overridden via Cloud Run args)
CMD ["bun", "dist/apps/runner/main.js", "daily"]
