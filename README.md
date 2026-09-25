# Cisco Catalyst 9800 — Guest Management Desk

[![CI — TypeCheck & Unit Tests](https://github.com/ACF-Dompe/Centralino/actions/workflows/ci.yml/badge.svg)](https://github.com/ACF-Dompe/Centralino/actions/workflows/ci.yml)
[![E2E Postgres](https://github.com/ACF-Dompe/Centralino/actions/workflows/e2e-postgres.yml/badge.svg)](https://github.com/ACF-Dompe/Centralino/actions/workflows/e2e-postgres.yml)
[![E2E SSO](https://github.com/ACF-Dompe/Centralino/actions/workflows/e2e-sso.yml/badge.svg)](https://github.com/ACF-Dompe/Centralino/actions/workflows/e2e-sso.yml)
[![Deploy to ACA](https://github.com/ACF-Dompe/Centralino/actions/workflows/deploy-azure.yml/badge.svg)](https://github.com/ACF-Dompe/Centralino/actions/workflows/deploy-azure.yml)
[![Docker Security — Trivy Scan](https://github.com/ACF-Dompe/Centralino/actions/workflows/docker-security.yml/badge.svg)](https://github.com/ACF-Dompe/Centralino/actions/workflows/docker-security.yml)
[![Security — 0 critical · 0 high · 0 moderate · 1 low](https://img.shields.io/badge/Security-0%20critical%20%7C%200%20high%20%7C%200%20moderate%20%7C%201%20low-brightgreen?logo=npm)](https://github.com/ACF-Dompe/Centralino/security/dependabot)
[![Compliance — 12/16 🟢](https://img.shields.io/badge/Compliance-12%2F16%20%F0%9F%9F%A2-green?logo=azuredevops)](./COMPLIANCE.md)

A full-stack operator console for administering a **Cisco Catalyst 9800 WLC**:
authenticate (HTTPS + SSH), create/manage guest Wi-Fi accounts, send credentials
via **SMS**, **Email**, or **Print Badge**, monitor active sessions with a
real-time timer, and keep working in **Demo / Sandbox** when the controller is
unreachable.

Deployed on **Azure Container Apps** behind **Application Gateway (WAF v2)**,
with **SSO SAML 2.0** authentication via **Microsoft Entra ID**.

## Stack

| Layer           | Tech                                                                 |
|-----------------|----------------------------------------------------------------------|
| Frontend        | React 18 + Vite + TypeScript + Tailwind CSS                          |
| Backend         | Node.js 20 + Express + TypeScript                                    |
| Database        | PostgreSQL 15+ (via Azure Database for PostgreSQL Flexible Server)   |
| Authentication  | SSO SAML 2.0 via Microsoft Entra ID (passport-saml / express-session)|
| WLC access      | `https` (WebUI login) + `ssh2` (IOS-XE commands)                     |
| Container       | Docker multi-stage (Dockerfile + Dockerfile.frontend)                |
| Registry        | Azure Container Registry (immutable tags + mutable env aliases)      |
| Deployment      | Azure Container Apps (5-stage CI/CD pipeline via GitHub Actions)     |
| Ingress         | Azure Application Gateway WAF v2 (path-based routing)                |
| Secrets         | Azure Key Vault (Key Vault references in ACA environment vars)       |

## Features

- **SSO SAML 2.0** via Microsoft Entra ID — optional, fallback to WLC-only in dev
- **Single Logout (SLO)** — destroys both local and IdP sessions
- **Break-glass access** — audited emergency local login for an Entra/SSO outage, off by default
- **WLC Login** with HTTPS Basic Auth to `/webui/index.html`
- **Demo / Sandbox** mode when the WLC is unreachable (10s timeout)
- **Guest CRUD** with auto-generated credentials (`g.{slug}{3digits}` / `DOMPE-{4digits}`)
- **Real-time timer** running server-side, polled every 5s
- **Auto-expiry** and periodic sync (every 30s)
- **Badge Modal** with Print / SMS / Email tabs, scannable Wi-Fi QR code
- **Channel configuration** (SMTP, SMS gateway, WLC) persisted in PostgreSQL
- **IT / EN** translations, hot-swappable without page reload
- **Professional UI** with navy/red corporate palette
- **Containerised**, non-root runtime, health-check
- **Entra ID Managed Identity** for PostgreSQL (no password secrets needed)

## Quick start (local dev)

```bash
# Prerequisites: Node.js 22+, PostgreSQL running locally
cp .env.example .env       # adjust DATABASE_URL for your local Postgres
make install               # npm install across all workspaces
npm run dev                # runs backend (3000) and frontend (5173) in parallel
# open http://localhost:5173
```

The backend boots, runs migrations and seeds demo data automatically.

> 🧪 **SSO is disabled by default in dev.** Set `SAML_ENTRY_POINT`, `SAML_ISSUER`,
> `SAML_CALLBACK_URL` and `SAML_CERT` to enable it. Without SAML, the app shows
> the WLC login screen directly.

## Containers

The backend and frontend ship as two independent images
(`Dockerfile` → `guestportal-backend`, `Dockerfile.frontend` → `guestportal-frontend`),
built with `apk upgrade --no-cache` in the runtime stages.

| Service   | Port | Base image | Runs as |
|-----------|------|------------|---------|
| Backend   | `3000` | `node:22-alpine`     | `app` (non-root) |
| Frontend  | `3000` | `nginx:1.28-alpine`  | `nginx` (non-root) |

> Per the Azure Container Platform guidelines (§11), this repository does **not**
> ship a `docker compose` stack or local runtime emulators. Local development
> uses `make dev` (backend :3000 + frontend :5173); container validation happens
> on the **Development** environment via the deploy pipeline
> (`.github/workflows/deploy-azure.yml`). In production, `/api/*` routing is
> handled by the Azure Application Gateway, not by the frontend nginx.

## SSO SAML 2.0 via Microsoft Entra ID

The application supports **Single Sign-On** via SAML 2.0 using **Microsoft Entra ID**
as the Identity Provider. When enabled, users must authenticate with their
corporate account before accessing the console.

If SAML is not configured (local dev), the app falls back to WLC-only
authentication so development does not require an Azure AD tenant.

---

### 1. Register the application in Azure AD

1. Go to [Azure Portal → Entra ID → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps) (or follow [Microsoft's quickstart guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app))
2. Click **New registration**
3. Fill in:
   - **Name**: `Cisco Guest Desk — {environment}` (e.g. `Cisco Guest Desk — Dev`)
   - **Supported account types**: `Accounts in this organizational directory only (Single tenant)`
   - **Redirect URI (optional)**: Leave empty (configured later via SAML)
4. Click **Register**
5. Note the **Application (client) ID** — this is **not** the Entity ID (set in step 2)

### 2. Configure SAML SSO

> **Hostname convention** (corporate zone `dompe.com`): prod is
> `guestportal.dompe.com` (**no suffix**); non-prod is `guestportal-stg.dompe.com`
> and `guestportal-dev.dompe.com`. The examples below use dev.

1. In the app registration, go to **Manage → Authentication**
2. Under **Platform configurations**, click **Add a platform** → **Web**
3. Set **Redirect URI** to your public callback URL:
   ```
   https://guestportal-dev.dompe.com/api/auth/callback
   ```
4. Go to **Manage → Certificates & secrets** → **Federation metadata XML**
   — download the XML file. You will extract the values from it.

#### Entity ID (Identifier)

From the Federation Metadata XML, find:
```xml
<EntityDescriptor entityID="https://login.microsoftonline.com/<tenant-id>/saml2">
```

Alternatively, use a custom URI specific to this app instance, e.g.:
```
https://guestportal-dev.dompe.com/saml
```
This must match the `SAML_ISSUER` env var.

#### Reply URL (Assertion Consumer Service)

The Assertion Consumer Service URL where Entra ID POSTs the SAML response:
```
https://guestportal-dev.dompe.com/api/auth/callback
```
This must match the `SAML_CALLBACK_URL` env var and the Redirect URI set in
Azure AD app registration.

#### Certificate

Download the **Base64 certificate** from:
**Enterprise Applications** → your app → **Single sign-on** → **SAML Certificates**.
The `SAML_CERT` env var expects the PEM-encoded certificate (including the
`-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` markers).

In production, store the certificate as a **Key Vault secret** and reference it
in ACA environment variables.

### 3. Claims mapping

Configure the following **user attributes & claims** in Azure AD:

| Claim | Source attribute | Required | Used for |
|-------|-----------------|----------|----------|
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `user.mail` | ✅ | Display + audit |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name` | `user.displayName` | ✅ | UI header |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | `user.givenName` | ✅ | Profile |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` | `user.surname` | ✅ | Profile |
| `http://schemas.microsoft.com/identity/claims/objectidentifier` | `user.objectId` | — | Audit trail |
| `nameID` | `user.userPrincipalName` | ✅ | SAML subject identifier |

To configure:
1. Go to **Enterprise Applications** → your app → **Single sign-on** → **Attributes & Claims**
2. Edit the claim mappings to include the attributes above
3. Ensure `nameID` format is set to **Persistent** (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`)
   and the `nameID` source attribute is set to `user.userPrincipalName` or `user.mail`

### 4. Logout URL (Single Logout)

1. In the app registration, go to **Manage → Authentication**
2. Under **Front-channel logout URL**, set:
   ```
   https://guestportal-dev.dompe.com/api/auth/slo/callback
   ```
3. In ACA backend env vars, set:
   - `SAML_LOGOUT_URL` — the IdP's SingleLogoutService endpoint (found in the Federation Metadata XML)
   - `SAML_LOGOUT_CALLBACK_URL` — where the IdP sends the LogoutResponse
     (defaults to `{SAML_CALLBACK_URL}` with `/callback` → `/slo/callback`)

When a user clicks **Logout** in the app:
1. The local session is destroyed
2. The browser redirects to Entra ID SLO endpoint
3. Entra ID terminates the SSO session
4. Entra ID POSTs a LogoutResponse to `/api/auth/slo/callback`
5. The backend validates the LogoutResponse and redirects the browser to the frontend (`/`)
6. The frontend detects the user is no longer authenticated and shows the SSO login screen

If SLO fails (e.g. IdP is unreachable), the local logout still succeeds — the user
is logged out of the app even if the IdP session persists.

### 5. Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SAML_ENTRY_POINT` | ✅ | IdP SAML SSO endpoint (from Federation Metadata XML) |
| `SAML_ISSUER` | ✅ | Application Entity ID (must match Azure AD config) |
| `SAML_CALLBACK_URL` | ✅ | Public ACS URL (must match Azure AD Redirect URI) |
| `SAML_CERT` | ✅ | Azure AD public certificate (PEM) |
| `SESSION_SECRET` | ✅ | Random string for session cookie signing |
| `SAML_DECRYPTION_KEY` | — | Private key (only if assertions are encrypted) |
| `SAML_IDENTIFIER_FORMAT` | — | NameID format (default: persistent) |
| `SAML_LOGOUT_URL` | — | IdP SLO endpoint (enables Single Logout) |
| `SAML_LOGOUT_CALLBACK_URL` | — | IdP LogoutResponse destination |
| `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` | — | Default `true`; keep it true (see §7) |

In ACA production, all secrets (`SAML_CERT`, `SAML_DECRYPTION_KEY`, `SESSION_SECRET`)
should be stored as **Key Vault secrets** and referenced via:
```
@Microsoft.KeyVault(SecretUri=https://kv-guestportal-{env}.vault.azure.net/secrets/{name}/)
```

### 6. Verify the setup

1. Set the env vars and restart the backend
2. Open the app — you should see the **SSO login screen** with "Accedi con SSO"
3. Click the button — you should be redirected to `login.microsoftonline.com`
4. Authenticate with your corporate credentials
5. After successful auth, you are redirected back to the app and can proceed
   to WLC authentication
6. Click **SSO Logout** in the header — the session is destroyed

If SSO is not configured, the app skips the SSO screen entirely and shows the
WLC login directly (useful for local development without Azure AD access).

### 7. The application must not dictate the authentication method

`@node-saml/node-saml` injects, by default, a `RequestedAuthnContext` of
`urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` with
`Comparison="exact"` into every AuthnRequest. Entra ID honours that, so a user
who signed in with certificate-based authentication, Windows Hello or FIDO2
cannot satisfy it and the login fails with:

```
AADSTS75011: Authentication method 'X509, MultiFactor, X509Device' by which the
user authenticated with the service doesn't match requested authentication
method 'Password, ProtectedTransport'.
```

Which methods are acceptable is a Conditional Access / Authentication Strength
decision inside Entra, not a service-provider one, so the strategy omits the
element entirely (`SAML_DISABLE_REQUESTED_AUTHN_CONTEXT`, default `true`).

**There is nothing to change on the Entra side for this**: a SAML enterprise
application has no supported switch to make Entra ignore a `RequestedAuthnContext`
it receives. The fix belongs in the application.

To confirm the fix on a deployed instance, open `/api/auth/login`, take the
`SAMLRequest` parameter from the redirect towards `login.microsoftonline.com`,
then URL-decode → base64-decode → inflate it: the XML must contain no
`RequestedAuthnContext` element.

---

## Break-glass access (emergency login)

A local username/password login that works when Entra ID / SAML SSO is down.
Disabled by default (`BREAKGLASS_ENABLED=false`).

> ⚠️ It bypasses Entra Conditional Access and MFA and, by explicit decision,
> carries **no second factor**. This is a documented, accepted deviation —
> see `COMPLIANCE.md` for the compensating controls and the residual risk.

When enabled, the SSO screen shows a discreet **"Accesso di emergenza"** link
(only to clients inside `BREAKGLASS_IP_ALLOWLIST`, if one is set). A break-glass
session shows a persistent banner in the dashboard, has a shorter lifetime than
an SSO session, and every login attempt is logged at `warn` level for alerting.

Accounts live in the `breakglass_users` table and are managed only with the CLI:

```bash
make breakglass ARGS="list"
make breakglass ARGS='set bg.operator --display "Break Glass" --expires 2027-12-31'
```

Setup, operations and the Log Analytics alert query are in
[GUIDA-DEPLOY-guestportal-prod.md](GUIDA-DEPLOY-guestportal-prod.md) §1.3;
the design rationale is in [backend/README.md](backend/README.md).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `WLC_DEFAULT_HOST` | `172.18.106.100` | Default WLC host |
| `WLC_DEFAULT_PORT` | `443` | HTTPS port |
| `WLC_DEFAULT_SSH_PORT` | `22` | SSH port |
| `WLC_DEFAULT_USERNAME` | `admin_guest` | Default admin user |
| `WLC_DEFAULT_PASSWORD` | — | Set via env var (never hardcoded) |
| `WLC_DEFAULT_SSID` | `Dompe Guest` | Default SSID |
| `WLC_HTTP_TIMEOUT_MS` | `10000` | HTTPS request timeout |
| `WLC_SSH_TIMEOUT_MS` | `10000` | SSH connection timeout |
| `WLC_SSH_VERIFY_HOST_KEY` | `false` | Verify the WLC SSH host key — off by design, see COMPLIANCE.md |
| `WLC_SSH_HOST_KEY` | — | Expected host key; used only when verification is on |
| `KEY_VAULT_URL` | — | Vault with the `WLC-PASSWORD-<CODE>` secrets, read at startup and on reload, editable from the admin panel (COMPLIANCE.md D4). Empty = env vars only |
| `AZURE_CLIENT_ID` | — | Client id of the backend's user-assigned identity, for `DefaultAzureCredential` (Key Vault, Graph) |
| `DIRECTORY_SEARCH_ENABLED` | `false` | Live Entra ID search for the Referente field (needs Graph `User.Read.All` on the backend identity) |
| `DIRECTORY_UPN_DOMAINS` | `dompe.com,ext.dompe.com` | UPN domains the Referente search may return |
| `SAML_ENTRY_POINT` | — | Entra ID SSO endpoint (see §SSO) |
| `SAML_ISSUER` | — | SAML Entity ID (see §SSO) |
| `SAML_CALLBACK_URL` | — | SAML ACS URL (see §SSO) |
| `SAML_CERT` | — | Entra ID cert (see §SSO) |
| `SAML_DECRYPTION_KEY` | — | Private key for encrypted assertions |
| `SESSION_SECRET` | — | Session cookie signing secret |
| `SAML_LOGOUT_URL` | — | SLO endpoint (optional) |
| `SAML_LOGOUT_CALLBACK_URL` | — | SLO callback destination |
| `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` | `true` | Omit RequestedAuthnContext — keep true on Entra ID |
| `BREAKGLASS_ENABLED` | `false` | Emergency local login (see §Break-glass) |
| `BREAKGLASS_IP_ALLOWLIST` | — | CIDRs allowed to reach the break-glass endpoint |
| `BREAKGLASS_SESSION_TTL_MINUTES` | `120` | Break-glass session lifetime |
| `BREAKGLASS_MAX_FAILED_ATTEMPTS` | `5` | Wrong passwords before the account locks |
| `BREAKGLASS_LOCKOUT_MINUTES` | `15` | How long the lock lasts |
| `BREAKGLASS_MAX_ATTEMPTS_PER_IP` | `10` | Failures allowed per source IP in the window |
| `BREAKGLASS_IP_WINDOW_MINUTES` | `15` | Per-IP throttle window |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | Azure App Insights (optional) |

## Project layout

```
.
├── backend/                    # Express + TypeScript API
│   ├── src/
│   │   ├── auth/               # SAML strategy, session config, break-glass passwords
│   │   ├── db/                 # Migrations, seed, PostgreSQL driver
│   │   ├── middleware/          # ensureAuthenticated guard
│   │   ├── scripts/            # breakglass CLI (account management)
│   │   ├── services/           # WLC HTTPS + SSH + background timer
│   │   ├── repositories/       # DB row → domain mapping
│   │   ├── routes/             # REST endpoints (+ auth routes)
│   │   ├── types/              # Additional type declarations
│   │   ├── utils/              # Credential gen, time formatting, login guards
│   │   ├── config.ts           # Centralised env-var config
│   │   ├── logger.ts           # Pino-based structured logging
│   │   └── index.ts            # Server entry (wires session, passport, routes)
│   ├── package.json
│   └── tsconfig.json
├── frontend/                   # React + Vite + Tailwind
│   ├── src/
│   │   ├── components/         # SsoLogin, BreakGlassLogin, Login, Dashboard…
│   │   ├── i18n/               # IT/EN translations
│   │   ├── api/                # API client (+ auth methods)
│   │   ├── utils/              # Time formatting
│   │   ├── types.ts
│   │   ├── App.tsx             # Auth state machine (4 phases)
│   │   └── main.tsx
│   ├── package.json
│   ├── tailwind.config.js
│   └── vite.config.ts
├── .github/workflows/          # CI/CD pipelines
│   ├── ci.yml                  # TypeCheck + unit tests on every push
│   ├── deploy-azure.yml        # 5-stage: Build → Bootstrap → Migrate → Deploy → Verify
│   ├── docker-security.yml     # Trivy vulnerability scan on every push/PR
│   ├── e2e-postgres.yml        # Full E2E suite (calls e2e-reusable.yml)
│   ├── e2e-reusable.yml        # Reusable E2E workflow (PostgreSQL + full suite)
│   ├── e2e-sso.yml             # SSO SAML login screen tests (frontend-only, lightweight)
│   └── provision-infra.yml     # Azure resource provisioning (manual workflow_dispatch)
├── Dockerfile                  # Backend Docker image (multi-stage)
├── Dockerfile.frontend         # Frontend Docker image (nginx)
├── .env.example
├── .dockerignore
└── README.md
```

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/auth/login` | Initiate SSO SAML login (redirect to Entra ID) |
| POST   | `/api/auth/callback` | SAML ACS — receive AuthnResponse from Entra ID |
| POST   | `/api/auth/logout` | Logout (local + SLO redirect to Entra ID) |
| POST   | `/api/auth/slo/callback` | Receive LogoutResponse from Entra ID (SLO) |
| GET    | `/api/auth/me` | Current user profile, `authMethod`, plus `role` / `status` / `sedeIds` (401/404 if unauthenticated). Answers 200 even for an unprofiled user — it is how the UI knows *why* they are blocked |
| GET    | `/api/auth/breakglass/status` | Whether the emergency login is usable by this client |
| POST   | `/api/auth/breakglass/login` | Emergency local login (404 when disabled or IP not allowed) |
| GET    | `/api/health` | Liveness probe (public, no auth required) |
| GET    | `/api/session/context` | Who is signed in, what they may do, and which site they are on. The client bootstrap |
| DELETE | `/api/session/sede` | Release the current site without signing out ("Cambia sede") |
| POST   | `/api/wlc/login` | Connect this session to a site. Takes `{ sedeId }` only — host, port and username come from the site record, the password from Key Vault |
| POST   | `/api/wlc/create-user` | Create guest account on the WLC (SSH) — **admin** |
| PUT    | `/api/wlc/status-user` | Enable / disable a guest — **admin** |
| POST   | `/api/wlc/delete-user` | Remove a guest — **admin** |
| POST   | `/api/wlc/get-users` | List users on the WLC — **admin** |
| POST   | `/api/wlc/import-users` | Import WLC users into local DB — **admin** |
| GET    | `/api/directory/users?q=` | Live Entra ID people search for the Referente field (display names only, UPN on `DIRECTORY_UPN_DOMAINS`, never cached) — **operator** / **admin** |
| GET    | `/api/guests` | List guests for the session's site (filter `?search&status`) |
| POST   | `/api/guests` | Create guest (returns one-time password) — **operator** |
| PUT    | `/api/guests/:id` | Update guest — **operator** |
| DELETE | `/api/guests/:id` | Delete guest — **operator** |
| POST   | `/api/guests/:id/resend-credentials` | Regenerate + re-send credentials — **operator** |
| GET    | `/api/config/wlc` | *Deprecated* — resolves the session's site. Use `/api/session/context` |
| GET/PUT| `/api/config/sms` | SMS channel configuration — **admin** |
| GET/DEL| `/api/sync-logs` | WLC operation history — **operator** / **admin** |
| GET    | `/api/sedi` | Sites in service that the caller may reach. Controller parameters are stripped for non-admins |
| GET    | `/api/sedi/:id` | Get a site the caller may reach |

### Administration — all under `requireRole('admin')`

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/admin/users` | User directory (filter `?status&search`) |
| PATCH  | `/api/admin/users/:id` | Profile a user: role, status, granted sites |
| DELETE | `/api/admin/users/:id` | Remove a directory entry (re-created, blocked, at the next sign-in). Refused on yourself, on the last active admin and on an administrator by convention |
| GET    | `/api/admin/sedi` | Every site, with connectivity diagnostics |
| POST   | `/api/admin/sedi` | Create a site (starts out of service) |
| PUT    | `/api/admin/sedi/:id` | Update a site. The code is immutable — it resolves the Key Vault secret |
| PATCH  | `/api/admin/sedi/:id/active` | Put a site in or out of service |
| POST   | `/api/admin/sedi/:id/test` | Probe the controller. Diagnostics only: touches no session |
| DELETE | `/api/admin/sedi/:id` | Delete a site, refused while it still has guests |
| GET    | `/api/admin/sedi/:id/password` | Read the controller password live from Key Vault. Audited, `no-store` (COMPLIANCE.md D4) |
| PUT    | `/api/admin/sedi/:id/password` | Store a new controller password in Key Vault and use it at once. Audited; the controller itself is not changed |
| POST   | `/api/admin/wlc/reload` | Re-read every site's password from Key Vault, without a restart |
| GET    | `/api/admin/breakglass` | Emergency accounts and their state |
| POST   | `/api/admin/breakglass/:username/{enable,disable,unlock}` | Enable, disable, clear a lockout |

There is deliberately **no** endpoint that creates a break-glass account or
rotates its password: those stay in `make breakglass`, so a compromised admin
session cannot mint a credential that bypasses Entra (COMPLIANCE.md D1).

The WLC controller password is the accepted exception in the other direction
(COMPLIANCE.md D4): an admin can read and replace it, one site at a time, and
every read and write is logged at `warn`. It never appears in a list or in the
site record.

## Roles

Every user who completes SSO gets a directory entry at their first sign-in, and
that entry starts **blocked**: the tenant can authenticate, but nothing is
granted until an administrator profiles it.

| Role | Can |
|---|---|
| `viewer` | See the dashboard and the guest list for the sites they were granted |
| `operator` | The above, plus create, revoke and re-send credentials |
| `admin` | The above at every site, plus the administration panel |

Authorization is resolved per request and is **not** stored in the session, so a
change takes effect within `RBAC_CACHE_TTL_SECONDS` (15s by default) rather than
at the user's next sign-in.

### Administrators by convention

An address of the form `admin365-<anything>@dompe.onmicrosoft.com` is a platform
administrator without anybody profiling it. The role is written into the
directory on every login *and* enforced at every authorization lookup, so it
cannot be edited away — the admin panel shows such a row with an "Admin
automatico" badge and its role and status locked.

Both halves of the rule are required, and the domain is not decoration: it is
what keeps an Entra guest (B2B) account from qualifying, since a guest's UPN
belongs to their own tenant. Configured with `RBAC_AUTO_ADMIN_PREFIXES` and
`RBAC_AUTO_ADMIN_DOMAINS`; an empty domain list disables the rule rather than
widening it.

Bootstrapping a fresh deployment: the migration creates `bk.guestportal` when
`BREAKGLASS_SEED_PASSWORD` is set, and that account can profile the first
administrators. Without exposing the emergency login to a network, the same can
be done with `make appusers ARGS="grant <email> --role admin --sedi MIL,AQ"`,
run inside the container with `az containerapp exec`.


## Key Vault & ACA Configuration

The application integrates with **Azure Key Vault** for secret management via
**ACA native Key Vault references**. Secrets are NEVER hardcoded in the codebase
or image — all sensitive values are injected as environment variables at runtime.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Azure Container Apps                  │
│  ┌────────────────────┐      ┌──────────────────────┐   │
│  │  Backend ACA       │      │  Frontend ACA        │   │
│  │  ca-guestportal-backend-*  │      │  ca-guestportal-frontend-*   │   │
│  │                    │      │                      │   │
│  │  env SESSION_SECRET│      │  (no secrets —       │   │
│  │    = @Microsoft.   │      │   static SPA/nginx)  │   │
│  │      KeyVault(...) │      │                      │   │
│  │                    │      │                      │   │
│  │  UAMI → gets token │      │                      │   │
│  │       ↓            │      │                      │   │
│  └───────┬────────────┘      └──────────────────────┘   │
│          │                                              │
│          ▼                                              │
│  ┌────────────────────────────────┐                     │
│  │  Azure Key Vault               │                     │
│  │  kv-guestportal-{env}                  │                     │
│  │                                │                     │
│  │  Secrets:                      │                     │
│  │    SESSION-SECRET              │                     │
│  │    SAML-CERT                   │                     │
│  │    WLC-DEFAULT-PASSWORD        │                     │
│  │    ...                         │                     │
│  └────────────────────────────────┘                     │
│                                                          │
│  ┌────────────────────────────────┐                     │
│  │  PostgreSQL Flexible Server   │                     │
│  │  (Entra ID auth — no password)│                     │
│  └────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

### Key Vault Secret Reference Format

Each environment has its own Key Vault: `kv-guestportal-{env}` (e.g. `kv-guestportal-dev`).
Secrets are referenced in ACA environment variables using the native format:

```
@Microsoft.KeyVault(SecretUri=https://kv-guestportal-{env}.vault.azure.net/secrets/{SECRET_NAME}/)
```

### Required Secrets per Environment

| Env var                          | KV Secret Name                | Required | Notes                        |
|----------------------------------|-------------------------------|----------|------------------------------|
| `DATABASE_URL`                   | `DATABASE-URL`                | ✅       | PostgreSQL + Entra ID (no password) |
| `SESSION_SECRET`                 | `SESSION-SECRET`              | ✅       | Random ≥64 chars             |
| `WLC_DEFAULT_PASSWORD`           | `WLC-DEFAULT-PASSWORD`        | ✅       | Admin password for WLC       |
| `SAML_ENTRY_POINT`               | `SAML-ENTRY-POINT`            | ✅       | From Federation Metadata XML |
| `SAML_ISSUER`                    | `SAML-ISSUER`                 | ✅       | Entity ID in Azure AD        |
| `SAML_CALLBACK_URL`              | `SAML-CALLBACK-URL`           | ✅       | ACS URL                      |
| `SAML_CERT`                      | `SAML-CERT`                   | ✅       | Azure AD cert PEM            |
| `SAML_DECRYPTION_KEY`            | `SAML-DECRYPTION-KEY`         | 🔶       | Only if assertions encrypted |
| `SAML_LOGOUT_URL`                | `SAML-LOGOUT-URL`             | 🔶       | Only if SLO enabled          |
| `SAML_LOGOUT_CALLBACK_URL`       | `SAML-LOGOUT-CALLBACK-URL`    | 🔶       | Only if SLO enabled          |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | `APPINSIGHTS-CONNECTION-STRING` | 🔶 | Only if App Insights used    |
| `MAIL_GRAPH_CLIENT_SECRET` | `MAIL-GRAPH-CLIENT-SECRET` | 🔶 | Required only if Graph API email is enabled |

> ✅ = Always required. 🔶 = Required only if the feature is enabled.

### Setting Secrets in Key Vault

```bash
# Login
az login

# Set a plain-text secret
az keyvault secret set \
  --vault-name kv-guestportal-dev \
  --name SESSION-SECRET \
  --value "your-64-char-random-string"

# Set a certificate/key file
az keyvault secret set \
  --vault-name kv-guestportal-dev \
  --name SAML-CERT \
  --file ./saml-cert.pem
```

### UAMI (User-Assigned Managed Identity) Setup

Each container app has a dedicated UAMI that needs the `Key Vault Secrets User`
role on the Key Vault:

```bash
UAMI_PRINCIPAL_ID=$(az identity show \
  --name uami-guestportal-backend-dev \
  --resource-group rg-guestportal-dev \
  --query principalId --output tsv)

az role assignment create \
  --assignee "$UAMI_PRINCIPAL_ID" \
  --role "Key Vault Secrets User" \
  --scope /subscriptions/$(az keyvault show --name kv-guestportal-dev --query id -o tsv)
```

The backend identity has two more grants when the related features are on:

- **Key Vault Secrets Officer**, to change a WLC password from the admin panel
  (COMPLIANCE.md D4). Prefer scoping it to the `WLC-PASSWORD-*` secrets:
  `--scope "$(az keyvault show --name kv-guestportal-dev --query id -o tsv)/secrets/WLC-PASSWORD-MIL"`, one per site.
- The Microsoft Graph **application** permission `User.Read.All` with admin
  consent, for the Referente search (`DIRECTORY_SEARCH_ENABLED=true`). App roles
  are granted to a managed identity through Graph (e.g. PowerShell
  `New-MgServicePrincipalAppRoleAssignment`), not from the portal.

### Internal Backend FQDN

The `BACKEND_BASE_URL` env var provides the internal ACA FQDN for server-side
frontend-to-backend calls (e.g. SSR). It follows the convention:

```
http://ca-guestportal-backend-{env}.{aca-environment-default-domain}
```

This is set automatically by the CI/CD pipeline using the
`ACA_ENVIRONMENT_DEFAULT_DOMAIN` GitHub secret.

### Required GitHub Secrets

The CI/CD pipeline requires the following secrets configured in your GitHub
repository (Settings → Secrets and variables → Actions):

Platform resource **names are parametrized** (consume-only model — supplied by
the infrastructure team; nothing hard-coded):

| Secret                          | Description                                              |
|---------------------------------|----------------------------------------------------------|
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | OIDC federated identity for the pipeline |
| `ACR_NAME`                      | Azure Container Registry name                           |
| `RG_NAME`                       | Resource group (platform-provided)                     |
| `KV_NAME`                       | Key Vault (platform-provided)                          |
| `ACA_ENV_NAME`                  | ACA environment (preflight check)                      |
| `ACA_BACKEND_NAME` / `ACA_FRONTEND_NAME` | Container App names (platform-provided)        |
| `MIGRATION_JOB_NAME`            | Pre-provisioned migration ACA job                      |
| `UAMI_BACKEND_NAME` / `UAMI_FRONTEND_NAME` | Managed identities (preflight check)        |
| `ACA_ENVIRONMENT_DEFAULT_DOMAIN` | ACA env default domain                                |
| `DATABASE_URL`                  | Entra ID auth, no password. User MUST be the backend UAMI name (`UAMI_BACKEND_NAME`) |
| `POSTGRES_SERVER_NAME`          | PostgreSQL Flexible Server name (preflight check)      |
| `SAML_ENTRY_POINT`              | Entra ID SAML SSO endpoint URL                          |
| `SAML_ISSUER`                   | Application Entity ID (`https://guestportal[-<env>].dompe.com/saml`) |
| `SAML_CALLBACK_URL`             | ACS callback URL                                        |
| `MAIL_GRAPH_CLIENT_ID`          | Graph API App Registration client ID (per email)       |
| `MAIL_GRAPH_USER_ID`            | Graph API mailbox user ID/UPN (per email)              |

> 🔑 `ACA_ENVIRONMENT_DEFAULT_DOMAIN` can be found in the Azure Portal under
> the Container Apps Environment resource → "Default Domain" property.

### Pipeline Flow (consume-only)

1. **Provisioning** (platform / infrastructure team, out of this repo): creates
   the Resource Group, Key Vault, ACA environment, the two Container Apps, the
   UAMIs, the PostgreSQL server + database + the Entra role mapped to the backend
   UAMI, the migration ACA job, the ACR and the Application Gateway. Use
   `./scripts/provision.sh <env>` (read-only preflight) to verify they exist.
2. **Every deployment** (CI/CD pipeline — updates only, never creates):
   - Stage 1 build/scan → push image to ACR
   - Stage 2 → start the pre-provisioned migration ACA job
   - Stage 3 (Deploy) → `az containerapp update --image ... --set-env-vars ...`
     sets env vars with Key Vault references and deploys the new image in a
     single atomic command (idempotent)
   - Stage 4 → informational post-deploy note (internal-only apps)
3. **Secret rotation**: Update the secret in Key Vault, then restart the ACA
   revision for changes to take effect

---

> 📄 **Changelog** — See [CHANGELOG.md](./CHANGELOG.md) for the full history of changes, security fixes, and updates.