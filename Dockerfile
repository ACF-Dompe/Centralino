# syntax=docker/dockerfile:1.7
# =============================================================================
# Backend — Azure Container Apps target
# =============================================================================
# Builds and serves the Node.js Express API. Designed for ACA:
#   - No iptables (ACA handles networking natively)
#   - No SQLite (PostgreSQL via Entra ID / managed identity)
#   - No entrypoint.sh (ACA injects env vars directly)
#   - Stateless: no volumes, no local data directory
#   - Healthcheck via /api/healthz endpoint (ACA probes this)
# =============================================================================

# ---------- Stage 1: build ----------
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/package.json

# Install all deps (build needs devDeps for tsc)
RUN npm config set fund false && npm config set audit false \
    && npm install --no-audit --no-fund --workspaces --include-workspace-root

# Copy backend source only
COPY backend ./backend

# Build backend (tsc)
RUN npm run build -w backend

# ---------- Stage 2: production dependencies ----------
# Resolved in a separate stage so that the runtime image never needs npm.
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/package.json
RUN npm install --omit=dev --workspace=backend --include-workspace-root --no-audit --no-fund

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime

# Upgrade system packages to latest available versions
RUN apk upgrade --no-cache

# Remove the package managers shipped with the base image. The container only
# ever runs `node` (app, migration job, seed and break-glass CLIs all invoke
# backend/dist/*.js directly), while npm vendors its own dependency tree
# (tar, glob, minimatch, sigstore, ip-address, ...) that Trivy flags on every
# scan even though nothing at runtime can reach it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    PORT=3000

# Add a non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# The manifests are still needed at runtime: backend/package.json declares
# "type": "module", which is what makes Node load dist/*.js as ESM.
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY --from=deps /app/node_modules ./node_modules

# Copy built artifacts only
COPY --from=build /app/backend/dist ./backend/dist

USER app
EXPOSE 3000

# Health check via the /api/healthz endpoint (no curl needed)
# Uses /api/healthz (liveness) per standard platform guidelines §4.10.
# The /api/health endpoint is deprecated and kept only for backward compat.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "backend/dist/index.js"]
