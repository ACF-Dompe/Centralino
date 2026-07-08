# syntax=docker/dockerfile:1.7
# =============================================================================
# Backend — Azure Container Apps target
# =============================================================================
# Builds and serves the Node.js Express API. Designed for ACA:
#   - No iptables (ACA handles networking natively)
#   - No SQLite (PostgreSQL via Entra ID / managed identity)
#   - No entrypoint.sh (ACA injects env vars directly)
#   - Stateless: no volumes, no local data directory
#   - Healthcheck via /api/health endpoint (ACA probes this)
# =============================================================================

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

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

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Add a non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Install only backend production deps
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/package.json
RUN npm install --omit=dev --workspace=backend --no-audit --no-fund \
    && npm cache clean --force

# Copy built artifacts only
COPY --from=build /app/backend/dist ./backend/dist

USER app
EXPOSE 3000

# Health check via the /api/health endpoint (no curl needed)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "backend/dist/index.js"]
