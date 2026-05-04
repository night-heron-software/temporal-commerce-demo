# =============================================================================
# Temporal Commerce Demo — Worker Dockerfile
# =============================================================================
# Runs the unified Temporal worker process (all 6 domain workers).
# Separate from the Next.js app — deployed as an ECS Fargate task.
#
# Build:  docker build -f deploy/worker.Dockerfile -t temporal-commerce-worker .
# Run:    docker run --env-file .env.local temporal-commerce-worker
# =============================================================================

FROM node:20-slim AS base
WORKDIR /app

# Install dependencies only (layer cache)
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Build layer — copy source and compile
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Copy node_modules (production only) and source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY package.json ./

# tsx is needed at runtime to execute TypeScript directly
RUN npm install tsx

# Health check — worker is healthy if the process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "worker.ts" > /dev/null || exit 1

ENTRYPOINT ["npx", "tsx", "./src/temporal/worker.ts"]
