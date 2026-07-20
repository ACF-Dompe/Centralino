# Azure Platform Preflight (consume-only)

**Operating model: CONSUME-ONLY.** The platform (infrastructure team)
pre-provisions every Azure resource for the **guestportal** app. This repo does
**not** create infrastructure. `scripts/provision.sh` is a **read-only
preflight** that verifies the expected resources exist and prints the
configuration map to hand to the infrastructure team.

## What the platform pre-provisions (NOT created here)

- Resource Group, Key Vault, ACA environment
- The two Container Apps (backend + frontend) and the migration ACA job
- The UAMIs (backend + frontend) and their Key Vault RBAC
- The PostgreSQL server, the app database, and the **Entra role mapped to the
  backend UAMI** (`pgaadauth_create_principal`) with its grants
- The Azure Container Registry (ACR) and the Application Gateway

The pipeline (`.github/workflows/deploy-azure.yml`) only: builds the image →
pushes to ACR → runs the schema migration (DDL in the app's own DB) → updates
the existing Container Apps (`az containerapp update --image` + Key Vault refs).

## Preflight usage

Resource names are **parametrized** — pass the real names (from the infra team)
as environment variables. Nothing is hard-coded.

```bash
az login   # Reader on the resource group is sufficient

RG_NAME=... KV_NAME=... ACA_ENV_NAME=... \
ACA_BACKEND_NAME=... ACA_FRONTEND_NAME=... MIGRATION_JOB_NAME=... \
UAMI_BACKEND_NAME=... UAMI_FRONTEND_NAME=... ACR_NAME=... PG_SERVER_NAME=... \
./scripts/provision.sh <dev|stg|prod>
```

The script:
1. Validates that all required names were provided.
2. Verifies each resource exists via `az ... show` (read-only — no `create`/`set`).
3. Prints the **configuration map** (env var → value / Key Vault reference) for
   the infrastructure team to apply on the backend Container App.

The same preflight runs from GitHub Actions:
`Actions → "Azure Platform Preflight" → Run workflow` (reads the names from the
`*_NAME` GitHub secrets).

## Hostnames (corporate zone `dompe.com`)

| Env | Hostname |
|-----|----------|
| prod | `guestportal.dompe.com` (no suffix) |
| stg  | `guestportal-stg.dompe.com` |
| dev  | `guestportal-dev.dompe.com` |

`SAML_ISSUER` / `SAML_CALLBACK_URL` follow the same hostname.

## Database identity (Entra ID)

- `DATABASE_URL` uses the **backend UAMI name** as the user and carries **no
  password**: `postgres://<UAMI_BACKEND_NAME>@<pg-host>:5432/guestportal_<env>`.
- The Entra token is obtained at runtime via `DefaultAzureCredential`.
- The Entra role on the DB mapped to that UAMI is an **infra prerequisite**
  (e.g. `SELECT * FROM pgaadauth_create_principal('<UAMI_BACKEND_NAME>', false, false)`
  plus grants) — the pipeline does not create it.

## Required GitHub secrets

Parametrized platform names + app configuration:

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | OIDC federated identity |
| `ACR_NAME` | Container Registry name |
| `RG_NAME` | Resource group |
| `KV_NAME` | Key Vault |
| `ACA_ENV_NAME` | ACA environment |
| `ACA_BACKEND_NAME` / `ACA_FRONTEND_NAME` | Container App names |
| `MIGRATION_JOB_NAME` | Pre-provisioned migration ACA job |
| `UAMI_BACKEND_NAME` / `UAMI_FRONTEND_NAME` | Managed identities |
| `ACA_ENVIRONMENT_DEFAULT_DOMAIN` | ACA env default domain |
| `POSTGRES_SERVER_NAME` | PostgreSQL server (preflight check only) |
| `DATABASE_URL` | `postgres://<UAMI_BACKEND_NAME>@<host>:5432/guestportal_<env>` (no password) |
| `SAML_ENTRY_POINT` | `https://login.microsoftonline.com/<tid>/saml2` |
| `SAML_ISSUER` | `https://guestportal[-<env>].dompe.com/saml` |
| `SAML_CALLBACK_URL` | `https://guestportal[-<env>].dompe.com/api/auth/callback` |
| `MAIL_GRAPH_CLIENT_ID` / `MAIL_GRAPH_USER_ID` | Graph API email |

Secret **values** (Key Vault contents such as `SESSION-SECRET`, `SAML-CERT`,
`WLC-DEFAULT-PASSWORD`, …) are managed by the platform/owner, not by this repo.

## OIDC federated credential (`setup-oidc.sh`)

Under the consume-only model the pipeline's OIDC identity (App Registration +
service principal + federated credentials) and its Key Vault RBAC are created by
the **infrastructure team**, not by this repo. `scripts/setup-oidc.sh` no longer
creates anything: it prints the exact spec the infra team must apply and, with
`--verify`, checks read-only that the expected federated credentials already
exist (`az ad app ... list`). The infra team returns `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` to configure as GitHub secrets.

## Prerequisites

| Tool | Version |
|------|---------|
| Azure CLI | 2.50+ |

Read (Reader) access on the resource group is sufficient for the preflight.
