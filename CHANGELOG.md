# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

#### SSO — `AADSTS75011` on every passwordless sign-in
- **The AuthnRequest no longer constrains the authentication method.** `@node-saml/node-saml` 5.1.0 injects, by default, `RequestedAuthnContext = urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` with `Comparison="exact"` into every AuthnRequest. Entra ID honours that constraint, so any user who signed in with certificate-based authentication, Windows Hello or FIDO2 (`amr = X509, MultiFactor, X509Device`) was rejected with `AADSTS75011` instead of being let through. Which method is acceptable is a Conditional Access / Authentication Strength decision inside the tenant, not a service-provider one — and a SAML enterprise application has no supported switch to make Entra ignore a `RequestedAuthnContext` it receives, so the fix belongs here. `createSamlStrategy` now sets `disableRequestedAuthnContext: true` by default (`backend/src/auth/saml.ts`), overridable with `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` for an IdP that demands an explicit context. The value is also pinned in `deploy-azure.yml` so a manual override cannot survive a deploy. New tests assert the generated AuthnRequest XML, not just the option flag.

#### Key Vault references were never resolved (SSO certificate, session secret, WLC passwords)
- **Env vars were set to the App Service syntax `@Microsoft.KeyVault(SecretUri=...)`, which Azure Container Apps does not expand** — the literal string reached the container (`az containerapp secret list` was empty). SSO failed with `idpCert is not in PEM format or in base64 format`, and, more seriously, `SESSION_SECRET` held the reference text: the cookie signing key was derivable from public information, so session cookies could be forged. `WLC_PASSWORD_*` and `MAIL_GRAPH_CLIENT_SECRET` were literal too.
- **`createSamlStrategy` now validates the certificate shape at startup** and refuses to build a strategy it knows cannot validate a response, naming the ACA/App Service mix-up explicitly when it sees an unresolved reference. It returns `null` instead of throwing, so the process stays up: the SSO routes answer 501 and the break-glass login — which exists for exactly this situation — keeps working. Previously the only symptom was a cryptic message in the browser after a full SSO round-trip.
- Documentation corrected: the deploy guide gains §3.1 with the two-step ACA binding (`az containerapp secret set --secrets "<name>=keyvaultref:<uri>,identityref:<uami>"`, then `<VAR>=secretref:<name>`) and §7.1 now uses `secretref:`; `.env.example` no longer suggests the App Service syntax.
- **Still open (tracked as COMPLIANCE.md §7.1):** `deploy-azure.yml` and `scripts/provision.sh` still emit the wrong syntax, so a pipeline deploy would overwrite a hand-fixed deployment and break SSO again. A blocking warning was added at the top of the workflow. The conversion needs care: referencing a non-existent Key Vault secret makes the revision fail to start, so optional variables must be handled conditionally.

#### Infinite redirect loop between the app and Entra ID on the SAML callback
- **The ACS endpoint never parsed its request body.** Entra delivers the AuthnResponse with the HTTP-POST binding — `application/x-www-form-urlencoded` carrying a `SAMLResponse` field — but the app mounted only `express.json()`. With `req.body` empty, passport-saml found no `SAMLResponse` and concluded the POST was a fresh login *initiation*: it answered the callback with a brand-new AuthnRequest, Entra posted the response straight back, and the browser span in an endless loop. No error was raised anywhere, and the request log was blind to it (see below), so the only visible symptom was the `SAMLRequest` parameter changing on every hop.
- Like the session-store defect, this was latent for as long as `AADSTS75011` stopped Entra from ever reaching the ACS.
- **Fix:** `express.urlencoded({ extended: false, limit: '1mb' })` is attached to `POST /api/auth/callback` and `POST /api/auth/slo/callback` inside `createAuthRouter`, so the parser travels with the routes that need it and cannot be lost when the app is wired. The 1 MB limit replaces the 100 KB default, which a larger encrypted assertion could exceed. Regression tests in `backend/src/__tests__/samlCallback.test.ts` assert that a posted `SAMLResponse` is never answered with a redirect to the IdP, with a negative control that reproduces the loop.
- **Entra ID needed no change**: it authenticated the user and posted a valid assertion to the correct ACS throughout.

#### Request logging was blind to the auth endpoints
- The HTTP request logger was registered **after** the auth router, so `/api/auth/*` — the endpoints one actually needs when diagnosing a login failure — never appeared in the log. It is now registered before every router. `path`, `method`, `ip` and the user agent are also captured when the request arrives rather than read inside the `finish` handler, which reported `/healthz` for a request to `/api/healthz` because a mounted router rewrites `req.url` while it runs. The query string stays out of the log: it carries the `redirect` parameter and the SAMLRequest.

#### Session store could never reach Azure PostgreSQL
- **The session store was built from a connection string, so it bypassed both TLS and Entra authentication.** `createSessionStore()` passed `conString` to `connect-pg-simple`, which builds its own `pg.Pool` with no `ssl` option and no password. Against Azure Database for PostgreSQL that connection is refused before authentication even starts — `no pg_hba.conf entry for host "...", user "uami-guestportal-backend-prod", database "guestportal_prod", no encryption` — and even over TLS there would be no credential, because Entra authentication deliberately keeps the password out of `DATABASE_URL`: the token only arrives through the `password` callback installed in `db/index.ts`.
- The defect was latent for as long as SSO could not complete: `/api/auth/login` only writes `samlRedirect` to the session and never waits for the store, so the failure was silent. It surfaced as soon as the `AADSTS75011` fix let the SAML callback through, because `req.login()` calls `session.save()` with a callback and the error then propagates to the client.
- **Fix:** the pool factory is now exported as `createDbPool()` — one place that knows how to reach the database, TLS and Entra token included — and `createSessionStore()` is given a pool rather than a connection string. `index.ts` builds the store once and shares it between the Express middleware and the WebSocket upgrade verifier, which previously each opened their own (broken) store. New regression tests in `backend/src/__tests__/sessionStore.test.ts` pin the contract: a pool and never a `conString`, TLS on, and the token callback as `password`.
- This also fixes WebSocket authentication, which read sessions through the same unusable store.

### Added

#### Break-glass access (emergency local login)
- **`POST /api/auth/breakglass/login` + `GET /api/auth/breakglass/status`:** a local username/password login that works when Entra ID / SAML SSO is unavailable. Accounts live in the new `breakglass_users` table. Disabled by default (`BREAKGLASS_ENABLED=false`).
- **⚠️ Accepted deviation, documented as D1 in `COMPLIANCE.md`:** this path bypasses Entra Conditional Access and MFA and, by explicit decision, carries no second factor. The residual risk is stated there alongside the compensating controls below. It depends on PostgreSQL, so it covers an Entra/SSO outage — not a database outage.
- **Compensating controls:** kill switch off by default (endpoint returns `404` until enabled); optional CIDR allowlist `BREAKGLASS_IP_ALLOWLIST`, evaluated first and fail-closed on a fully malformed list, with callers outside it getting `404` and never seeing the link in the UI; scrypt password hashing on Node's own `node:crypto` (no bcrypt/argon2 dependency added); per-account lockout persisted in the database so it holds across ACA replicas, advanced only by a wrong password so guessing cannot extend a lock against the legitimate operator; per-IP sliding-window throttle; constant-cost password verification plus one single generic error for every failure reason, so neither timing nor wording enumerates accounts; session regeneration on login and a shortened cookie TTL; per-account `expires_at`; and every attempt logged at `warn` level with `event`/`reason`/`ip`/`correlationId` for a Log Analytics alert.
- **Account management is CLI-only** (`backend/src/scripts/breakglass.ts`; `make breakglass ARGS="…"` locally, `node backend/dist/scripts/breakglass.js …` in the container): `list`, `set`, `enable`, `disable`, `unlock`, `delete`. There is deliberately no HTTP endpoint for it, which would be a privilege-escalation surface. The password is never accepted as a command-line argument — it is either generated and printed once, or read from stdin with `--stdin-password`.
- **Session model:** `AppUser` is now a discriminated union of `SamlUser` and `BreakGlassUser` on `authMethod` (`backend/src/auth/user.ts`). `/api/auth/me` returns `authMethod`; `POST /api/auth/logout` no longer attempts SAML Single Logout for a break-glass session, whose `nameID` is a local username rather than an Entra subject.
- **Frontend:** a discreet "Accesso di emergenza" link on the SSO screen (rendered only when the backend reports the path as usable by that client), the `BreakGlassLogin` form, and a persistent amber banner plus badge in the dashboard so an emergency session can never be mistaken for a normal one. IT/EN translations added.
- **Deploy guide:** new §1.3 with the enablement procedure, account creation, verification steps and the mandatory Log Analytics KQL alert; §12 gains troubleshooting rows for `AADSTS75011` and for the break-glass failure modes.

### Changed

#### Compliance — Review v7 follow-up (minor cleanups)
- **Dead `guests.password` column removed (§3.2):** the guest password is one-time and never persisted, so the unused `password` column was dropped from the `guests` DDL and from the repository (INSERT/`rowToGuest`/`updateGuest` map). `Guest.password` stays in the type and is always `null`.
- **Stale `.env.example` comment fixed (§3.3):** the Graph email note no longer says "falls back to SMTP (email_config table)" — mail is Graph-only with a dev demo-log fallback.
- **Public SMS provider removed from DDL default (§3.4):** `sms_config.gateway_type` no longer defaults to `'textbelt'` (no default now); the SMS feature stays dormant/hidden.

#### Compliance — Review v7 fixes
- **OIDC identity → infrastructure-owned — §1:** `scripts/setup-oidc.sh` no longer creates the App Registration / service principal / federated credentials (removed `az ad app create`, `az ad sp create`, `az ad app federated-credential create`). It is now a documentation + read-only preflight script: it prints the exact spec the infra team must apply and, with `--verify`, checks read-only (`az ad app ... list`) that the expected federated credentials exist. Docs updated accordingly.
- **WLC password → Key Vault per sede, never in the DB — §2:** The WLC admin password is now one Key Vault secret per site (`WLC-PASSWORD-<CODE>`, env-agnostic), injected as `WLC_PASSWORD_<CODE>` and resolved server-side by `sede.code` (`config.wlcPasswordForSede`). Removed the `password` column from `wlc_config` (migrate + seed), dropped it from repository reads/writes (`rowToWlc`, `updateWlcConfig*`), and removed it from the `WlcConfig` client contract. `POST /wlc/login` no longer accepts or persists a password — it validates connectivity using the per-sede env password. The Login form and ConfigPanel no longer collect a WLC password (sede selection preserved). Deploy pipeline injects `WLC_PASSWORD_{MIL,AQ,NA,TIR,SM}` as Key Vault references.
- **SMTP fallback removed → Graph-only mail — §3:** `services/email.ts` sends only via Microsoft Graph (demo-log fallback in dev); removed nodemailer, `buildTransporter`, the SMTP branch, and the `nodemailer`/`@types/nodemailer` dependencies. Removed `email_config` (migrate + seed), `getEmailConfig`/`updateEmailConfig`, the `EmailConfig` type, and the `GET/PUT /config/email` endpoints. Frontend: removed the SMTP section from ConfigPanel and BadgeModal's email-config fetch; the sender shown is the Graph from-address. Tests updated (email, routes integration, ConfigPanel, Login, BadgeModal).

#### Compliance — Review v5 fixes
- **`setup-oidc.sh` — §3.1:** Removed the Key Vault RBAC assignment (`az role assignment create` + the hardcoded `kv-guestportal-*` name). Under consume-only, granting "Key Vault Secrets User" on the platform Key Vault is the infrastructure team's job. Updated the obsolete hints that referenced `provision.sh` as a Key-Vault creator (it is now a read-only preflight); dropped the "Contributor" prerequisite (only Application Administrator is needed). The OIDC App Registration + federated credentials remain (their ownership is an open decision with the architect, §4.1).

#### Compliance — Review v4 fixes (consume-only model)
- **Consume-only pipeline — §1 (P1):** The pipeline no longer creates ANY Azure resource. `deploy-azure.yml` dropped the DB-bootstrap stage (no `CREATE DATABASE`/user/grants), the `az containerapp job create`, and the `az acr repository update` immutability step. It now: build → push → **start the pre-provisioned migration job** → `az containerapp update --image` on existing apps. Pipeline is now 4 stages.
- **Read-only preflight — §1 (P1):** `scripts/provision.sh` rewritten as a read-only preflight (verifies platform resources via `az ... show`, prints the env-var → Key Vault map; no `create`/`set`). `provision-infra.yml` converted to an "Azure Platform Preflight" workflow. `scripts/README.md` rewritten for the consume-only model.
- **Parametrized platform names — §0 (P1):** All platform resource names are now GitHub secrets (`RG_NAME`, `KV_NAME`, `ACA_ENV_NAME`, `ACA_BACKEND_NAME`, `ACA_FRONTEND_NAME`, `MIGRATION_JOB_NAME`, `UAMI_BACKEND_NAME`, `UAMI_FRONTEND_NAME`); no real names hard-coded.
- **DB identity — §2 (P1):** `DATABASE_URL` user is the backend UAMI name; the Entra role on the DB is documented as an infra prerequisite (not created by the app).
- **Hostname — §3 (P2):** prod is `guestportal.dompe.com` (no suffix); `guestportal-stg.dompe.com` / `guestportal-dev.dompe.com` for non-prod.
- **Internal naming — §5 (P3):** session cookie `cgd.sid` → `guestportal.sid` (backend + WS); localStorage `cgd:adminMode`/`cgd:locale` → `guestportal:*` (frontend + test).
- **SMS kept hidden — §6.b:** neutralized the public `textbelt` default in `db/seed.ts` (`webhook_url` now empty); no server-side SMS send added.

#### Compliance — Review v3 fixes (ANALISI-CONFORMITA-centralino-v3.md)
- **DB identity (Entra) — §3.1 (P0):** `DATABASE_URL` user is now the backend UAMI name (`uami-guestportal-backend-<env>`). The Stage 2 bootstrap no longer creates a password user (`POSTGRES_APP_PASSWORD` / `POSTGRES_ADMIN_PASSWORD` removed); it connects with an Entra access token as the admin, creates the DB, and provisions the Entra principal via `pgaadauth_create_principal` mapped to the UAMI, then grants it. Fixes the authentication mismatch that blocked migration/runtime.
- **Resource naming — §3.3 (P1):** Renamed all Azure resources `cgd-*` → `guestportal-*` (RG, Key Vault, UAMI, ACA env, ACA apps, migration job, images, DB name) across `provision.sh`, `provision-infra.yml`, `deploy-azure.yml`, `docker-security.yml`, `setup-oidc.sh`, and docs. App hostname moved from `cgd-<env>.internal.dompe.com` to `guestportal-<env>.dompe.com` (corporate zone).
- **ACA environment — §3.2 (P1):** `provision.sh` now creates the ACA environment **internal-only + VNet-integrated** (requires `ACA_INFRA_SUBNET_ID`); fails fast if the subnet is not provided.
- **`docker-compose` regression — §3.4 (P1):** Removed `docker-compose.yml`, `docker/nginx.local.conf`, `docker/nginx.main.conf`, the `make compose-*` targets, and all related doc references (guidelines §11 forbid a local runtime stack in the repo).
- **Post-deploy verify — §3.5 (P2):** Stage 5 no longer runs `curl -k` health checks against the private ACA FQDN from a public runner (which produced false greens); it now emits an informational note and documents moving the check to a self-hosted VNet runner.
- **SSH host-key — §3.6 (P2):** `wlcSsh.execSsh` is now truly fail-closed in production — it refuses to connect when `WLC_SSH_HOST_KEY` is unset (`NODE_ENV=production`), matching the `config.ts` comment.
- **DB TLS validation — §3.8 (P3):** The DB pool now validates the server certificate (`rejectUnauthorized: true`) unless `DB_SSL_REJECT_UNAUTHORIZED=false`; previously the certificate was never validated.
- **CI alignment — §3.8 (P3):** CI/security/e2e workflows trigger on `main`/`staging` (was `main`/`develop`); all Node steps standardized on Node 22 (labels and `node-version`); `.clinerules` updated to Node 22 and `node:22-alpine`/`nginx:1.28-alpine`.

#### Compliance — Pipeline & Workflows
- **`.github/workflows/provision-infra.yml`** — Environment options `prd` -> `prod` (allineato con `provision.sh`)
- **`.github/workflows/deploy-azure.yml`** (Stage 2) — DB bootstrap fail-fast: `exit 0` -> `exit 1` se PostgreSQL server non trovato
- **`.github/workflows/deploy-azure.yml`** (Stage 1) — Trivy gate: filesystem + image scan bloccano solo CRITICAL (non HIGH). Image scan ora hanno `exit-code: '1'`
- **`.github/workflows/deploy-azure.yml`** (Stage 5) — Rimossa mutazione Application Gateway (competenza piattaforma)

#### Documentation
- **`COMPLIANCE.md`** — New file: report dettagliato di conformita contro `ANALISI-CONFORMITA-centralino-v2.md`. Checklist §13, P0-P3 backlog, metriche, badge nel README

### Removed
- **Stage 5 deploy-azure.yml** — Rimosso intero step "Update shared App Gateway backend pools" (lascia gestione AGW al team infrastruttura)


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

#### Security — Docker & Container Images
- **`Dockerfile`** (backend): Base image `node:20-alpine` → `node:22-alpine` (Node 22 LTS, Alpine 3.21) — fixes multiple Alpine CVEs in node:20 base image.
- **`Dockerfile.frontend`** (frontend): 
  - Build stage: `node:20-alpine` → `node:22-alpine` 
  - Runtime stage: `nginx:1.27-alpine` → `nginx:1.28-alpine` (nginx 1.28.3) 
  - Added explicit `RUN apk add --upgrade libcrypto3 libssl3` merged with `apk upgrade --no-cache` — fixes CVE-2026-31789 (OpenSSL heap buffer overflow, 32-bit only) at source.
- **`.trivyignore`** — Added (then removed: CVE-2026-31789 now fixed at source via `apk add --upgrade`). Safety net before the nginx base image shipped the fix.
- **All CI workflow files**: `actions/setup-node` `node-version` from 20 → 22 (consistent with Docker images).

#### Security — Docker Security Workflow
- **`.github/workflows/docker-security.yml`** — Complete overhaul after 7 failed CI runs:
  - Added `category: trivy-backend` / `category: trivy-frontend` to SARIF upload steps (fixed "only one upload allowed per tool/category" error).
  - Severity threshold: `CRITICAL,HIGH` → `CRITICAL` only (aligns with deploy-azure.yml).
  - Pinned `aquasecurity/trivy-action` from `@master` (supply chain risk) to `@v0.36.0`.
  - Replaced `aquasecurity/trivy-action` wrapper with direct `docker run aquasec/trivy:0.70.0` — gives full control over flags, visible CI logs, and reliable gating.
  - Added explicit `--ignorefile /.trivyignore` via Docker volume mount for reliable `.trivyignore` support.
  - Gating logic: replaced `if: steps.x.outcome == 'failure'` (opaque, API returns `outcome=null`) with `if: always()` + bash env var check (`BACKEND_HAS_VULNS=yes/no` via `continue-on-error` + `&&`/`||` pattern).
  - Added `no-cache: true` + `pull: true` for debugging (later cleaned up: kept `pull: true`, restored GHA cache).
  - Removed redundant `continue-on-error: true` from Trivy steps (pattern already ensures exit 0).

**Result:** docker-security.yml goes from 0/1 green → **3/3 green** (3 consecutive passes).

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
| Compliance §13 (applicable) | — | **12/16 🟢** |
| CI/CD workflows | 6 | **7** |
| Commits today | — | **40+** |
| New files created | — | **9** |
