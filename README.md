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
| `SAML_ENTRY_POINT` | — | Entra ID SSO endpoint (see §SSO) |
| `SAML_ISSUER` | — | SAML Entity ID (see §SSO) |
| `SAML_CALLBACK_URL` | — | SAML ACS URL (see §SSO) |
| `SAML_CERT` | — | Entra ID cert (see §SSO) |
| `SAML_DECRYPTION_KEY` | — | Private key for encrypted assertions |
| `SESSION_SECRET` | — | Session cookie signing secret |
| `SAML_LOGOUT_URL` | — | SLO endpoint (optional) |
| `SAML_LOGOUT_CALLBACK_URL` | — | SLO callback destination |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | Azure App Insights (optional) |

## Project layout

```
.
├── backend/                    # Express + TypeScript API
│   ├── src/
│   │   ├── auth/               # SAML strategy, session config
│   │   ├── db/                 # Migrations, seed, PostgreSQL driver
│   │   ├── middleware/          # ensureAuthenticated guard
│   │   ├── services/           # WLC HTTPS + SSH + background timer
│   │   ├── repositories/       # DB row → domain mapping
│   │   ├── routes/             # REST endpoints (+ auth routes)
│   │   ├── types/              # Additional type declarations
│   │   ├── utils/              # Credential gen, time formatting
│   │   ├── config.ts           # Centralised env-var config
│   │   ├── logger.ts           # Pino-based structured logging
│   │   └── index.ts            # Server entry (wires session, passport, routes)
│   ├── package.json
│   └── tsconfig.json
├── frontend/                   # React + Vite + Tailwind
│   ├── src/
│   │   ├── components/         # SsoLogin, Login, Dashboard, GuestTable…
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
| GET    | `/api/auth/me` | Return current SSO user profile (401/404 if unauthenticated) |
| GET    | `/api/health` | Liveness probe (public, no auth required) |
| POST   | `/api/wlc/login` | Verify WLC HTTPS credentials |
| POST   | `/api/wlc/create-user` | Create guest account on the WLC (SSH) |
| PUT    | `/api/wlc/status-user` | Enable / disable a guest |
| POST   | `/api/wlc/delete-user` | Remove a guest |
| POST   | `/api/wlc/get-users` | List users on the WLC |
| POST   | `/api/wlc/import-users` | Import WLC users into local DB |
| GET    | `/api/guests` | List guests (filter `?search&status&sedeId`) |
| POST   | `/api/guests` | Create guest (returns one-time password) |
| PUT    | `/api/guests/:id` | Update guest |
| DELETE | `/api/guests/:id` | Delete guest |
| POST   | `/api/guests/:id/resend-credentials` | Regenerate + re-send credentials |
| GET/PUT| `/api/config/{wlc,email,sms}` | Channel configuration |
| GET/DEL| `/api/sync-logs` | WLC operation history |
| GET    | `/api/sedi` | List sites (sedi) |
| GET    | `/api/sedi/:id` | Get site with WLC connection params |


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

| Secret                          | Description                                              |
|---------------------------------|----------------------------------------------------------|
| `ACA_ENVIRONMENT_DEFAULT_DOMAIN` | ACA env default domain (from Azure Portal → Container Apps Environment) |
| `ACR_NAME`                      | Azure Container Registry name                           |
| `AZURE_CLIENT_ID`               | Da `./scripts/setup-oidc.sh <org>/centralino` (crea App Registration + federated credential) |
| `AZURE_TENANT_ID`               | Azure AD tenant ID                                      |
| `AZURE_SUBSCRIPTION_ID`         | Azure subscription ID                                   |
| `DATABASE_URL`                  | PostgreSQL connection string; Entra ID auth, no password. User MUST be the backend UAMI name (`uami-guestportal-backend-{env}`) |
| `POSTGRES_SERVER_NAME`          | PostgreSQL Flexible Server name                         |
| `POSTGRES_ADMIN_USER`           | Entra admin (group/user) used only to bootstrap the DB + Entra principal |
| `SAML_ENTRY_POINT`              | Entra ID SAML SSO endpoint URL                          |
| `SAML_ISSUER`                   | Application Entity ID                                   |
| `SAML_CALLBACK_URL`             | ACS callback URL                                        |
| `MAIL_GRAPH_CLIENT_ID`          | Graph API App Registration client ID (per email)       |
| `MAIL_GRAPH_USER_ID`            | Graph API mailbox user ID/UPN (per email)              |

> 🔑 `ACA_ENVIRONMENT_DEFAULT_DOMAIN` can be found in the Azure Portal under
> the Container Apps Environment resource → "Default Domain" property.
> Alternatively, via Azure CLI:
> ```bash
> az containerapp env show \
>   --name cae-guestportal-dev \
>   --resource-group rg-guestportal-dev \
>   --query "properties.defaultDomain" \
>   --output tsv
> ```
> It looks like `icydune-01234567.westeurope.azurecontainerapps.io`.

### Pipeline Flow

1. **Initial provisioning** (platform team): Create ACA container apps, Key Vault,
   UAMI, set secrets in Key Vault, configure GitHub secrets
2. **Every deployment** (CI/CD pipeline):
   - Stage 4 (Deploy) → `Deploy backend to ACA (with env vars)` step
     sets/updates all env vars with KV references AND deploys the new image
     in a single atomic command
   - This is idempotent: existing values are updated, new ones added
3. **Secret rotation**: Update the secret in Key Vault, then restart the ACA
   revision for changes to take effect

---

> 📄 **Changelog** — See [CHANGELOG.md](./CHANGELOG.md) for the full history of changes, security fixes, and updates.