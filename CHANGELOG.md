# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

#### CI/CD & Workflows
- **`.github/workflows/docker-security.yml`** — New workflow that builds both Docker images and runs Trivy vulnerability scan (CRITICAL/HIGH) on every push/PR to main/develop. Uploads SARIF results to GitHub Security tab. Uses `continue-on-error` pattern to ensure all scans and uploads complete before the gating step.
- **`.github/dependabot.yml`** — Dependabot configured for non-breaking PRs only (minor+patch, direct dependencies, ignore major versions). npm, Docker, and GitHub Actions ecosystems.
- **`Makefile`** — 15 developer shortcuts: `make test`, `make compose-up`, `make typecheck-backend`, `make docker-scan`, etc. All CI workflows now use Makefile targets for consistency (`make typecheck-backend`, `make test-backend`).
- **`.github/workflows/ci.yml`** — Now uses `make typecheck-backend`, `make typecheck-frontend`, `make test-backend`, `make test-frontend` instead of inline npx/npm commands.
- **`.github/workflows/deploy-azure.yml`** — Uses `make typecheck-backend`, `make typecheck-frontend`, `make test-backend` for Stage 1.

#### Documentation
- **`README.md`** — Added Docker Security badge, Security badge (0 critical, 0 high, 0 moderate, 1 low), Docker Compose quick start section, `make install` step in quick start, updated project layout.
- **`CHANGELOG.md`** — This file.

#### Docker & Local Development
- **`docker-compose.yml`** — Full-stack local testing with PostgreSQL 15, backend (port 3000), frontend (port 8080). Overrides nginx config to proxy `/api/*` to the backend container.
- **`docker/nginx.local.conf`** — Custom nginx config for docker-compose: proxies `/api/*` and `/ws` (WebSocket) to backend, SPA fallback, all temp paths in `/tmp` for non-root nginx user.
- **`docker/nginx.main.conf`** — Custom nginx main config with `pid /tmp/nginx.pid` to support non-root nginx user.
- **`.env.example`** — Added `POSTGRES_PASSWORD` and `COMPOSE_PROJECT_NAME` documentation for Docker Compose users.

### Fixed

#### Security — npm Dependencies
- **`nodemailer`**: `6.10.1` → `9.0.3` — Fixed **8 high-severity CVEs** (SSRF, injection, DoS, info leak). Replaced `@types/nodemailer@^6.4.24` with `@types/nodemailer@^8.0.1` for type compatibility.
- **`uuid`**: `10.0.0` → `11.1.1` — Fixed 1 moderate CVE (weak entropy in `v1()`). Project only uses `v4()` so impact was low.
- **`vite`**: `5.4.8` → `6.4.0` — Fixed 2 CVEs in `esbuild` (path traversal). Upgraded `@vitejs/plugin-react` for compatibility.
- **`package-lock.json`** — Synchronized with `npm install --package-lock-only` after dependency upgrades.

**Result:** From 26 Dependabot alerts → 1 low severity remaining (esbuild Windows-only).

#### Security — Docker Images
- **`Dockerfile`** (backend): Added `RUN apk upgrade --no-cache` to runtime stage — ensures Alpine packages are patched at build time.
- **`Dockerfile.frontend`** (frontend): Added `RUN apk upgrade --no-cache` to runtime stage — fixes 14-month stale nginx base image.
- **`Dockerfile`** (backend): Added `--include-workspace-root` to runtime `npm install` — fixes `ERR_MODULE_NOT_FOUND` for root dependency `@microsoft/microsoft-graph-client`.
- **`.dockerignore`**: Strengthened from 13 to 23 exclusions — added `**/node_modules`, `.github/`, `scripts/`, `.env.example`, `._DS_Store`, `.dockerignore`, `*.tsconfig.tsbuildinfo`, and more.

#### Bug Fixes — Discovered During Docker Compose Testing
- **`backend/src/db/migrate.ts`**: Fixed hardcoded `ssl: { rejectUnauthorized: false }` to respect `config.db.sslEnabled` env var. Migration CLI now works with local PostgreSQL without SSL.
- **`Dockerfile`**: `--include-workspace-root` addition (see Security section above).
- **`docker/nginx.local.conf`**: Multiple nginx startup fixes for non-root user — all 5 temp path directives (`client_body_temp_path`, `proxy_temp_path`, `fastcgi_temp_path`, `uwsgi_temp_path`, `scgi_temp_path`) set to `/tmp`. Added `proxy_buffering off` for WebSocket locations. Removed unused `proxy_cache_path`. Fixed duplicate WebSocket headers.
- **`docker/nginx.main.conf`**: PID file at `/tmp/nginx.pid` (writable by nginx user vs default `/var/run/nginx.pid`).

### Metrics

| Metric | Before | After |
|---|---|---|
| Unit tests | 391 (170 frontend + 221 backend) | Same — all pass |
| E2E tests | 22/22 | Same — all pass |
| TypeScript errors | 0 | 0 |
| CRITICAL/HIGH CVEs | 6 | **0** |
| Total real vulnerabilities | 11 | **1** (low, Windows-only) |
| CI/CD workflows | 6 | **7** |
| Commits today | — | **40+** |
| New files created | — | **8** |
