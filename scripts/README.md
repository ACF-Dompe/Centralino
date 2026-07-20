# Azure Infrastructure Provisioning

Idempotent provisioning script for the **Cisco Guest Desk** Azure infrastructure.

## Quick Start

```bash
# 0. OIDC Setup (one-time only)
./scripts/setup-oidc.sh <org>/centralino

# 1. Prerequisites
az login --tenant "<tenant-id>"
          # oppure: az login

# 2. Provision dev environment
./scripts/provision.sh dev
```

OIDC è un **passaggio una tantum** per tutto il repository, da eseguire prima del primo `provision.sh`.
Lo script chiederà il nome dell'**ACR** (Azure Container Registry) all'avvio.

## Prerequisites

| Tool | Versione | Installazione |
|------|----------|---------------|
| Azure CLI | 2.50+ | [aka.ms/install-azure-cli](https://aka.ms/install-azure-cli) |
| jq | 1.6+ | `apt install jq` / `brew install jq` |
| openssl | qualsiasi | Preinstallato su Linux/macOS |

### Permessi Azure necessari

L'utente che esegue lo script deve avere i seguenti ruoli RBAC sulla subscription:

- **Contributor** (per creare/modificare risorse)
- **User Access Administrator** (per assegnare ruoli RBAC alle UAMI)
- **Key Vault Secrets Officer** (per gestire i secret) — assegnato automaticamente dallo script

Per lo script `setup-oidc.sh` servono inoltre:
- **Application Administrator** (per creare App Registration in Entra ID)

## Usage

```bash
./scripts/provision.sh <environment> [--dry-run]

Arguments:
  <environment>    dev | stg | prd
  --dry-run, -n    Print all az commands without executing them
```

### Esempi

```bash
# Preview commands for dev (nessuna risorsa creata/modificata)
./scripts/provision.sh dev --dry-run

# Provisioning completo per staging
./scripts/provision.sh stg

# Provisioning completo per produzione
./scripts/provision.sh prd
```

## Dry-run Mode

Con `--dry-run` (o `-n`), lo script stampa tutti i comandi `az` che verrebbero eseguiti senza effettuarli.

**Limitazione nota**: i comandi capturati via `$(run ...)` (es. per ottenere resource ID, domini) stampano il testo del comando invece del reale output Azure. Di conseguenza:

- Le variabili popolate da queste capture conterranno testo placeholder
- Il sommario finale mostrerà valori placeholder per UAMI ID, ACA domain, ecc.
- Solo `az account show` (prerequisite check) viene eseguito realmente

Per vedere i valori reali delle risorse, eseguire senza `--dry-run`.

## Risorse Provisionate

Ogni ambiente (`dev`, `stg`, `prd`) crea le seguenti risorse Azure:

| Categoria | Nome | Descrizione |
|-----------|------|-------------|
| **Resource Group** | `rg-guestportal-{env}` | Contenitore di tutte le risorse dell'ambiente |
| **Key Vault** | `kv-guestportal-{env}` | Secret management con RBAC authorization |
| **UAMI Backend** | `uami-guestportal-backend-{env}` | Managed Identity per backend ACA |
| **UAMI Frontend** | `uami-guestportal-frontend-{env}` | Managed Identity per frontend ACA |
| **ACA Environment** | `cae-guestportal-{env}` | Container Apps Environment (workload profiles disabilitati) |
| **ACA Backend** | `ca-guestportal-backend-{env}` | Express API (1 CPU, 2Gi RAM, 1 replica, internal ingress) |
| **ACA Frontend** | `ca-guestportal-frontend-{env}` | nginx SPA (0.5 CPU, 1Gi RAM, 1 replica, internal ingress) |
| **Migration Job** | `job-guestportal-migrate-{env}` | ACA job manuale per DB migration |

### Backend ACA — Env Vars

Lo script configura automaticamente le seguenti variabili d'ambiente sul backend ACA:

| Env Var | Fonte | Note |
|---------|-------|------|
| `NODE_ENV` | inline | `production` |
| `PORT` | inline | `3000` |
| `LOG_LEVEL` | inline | `info` |
| `DATABASE_URL` | placeholder | Sostituire con la connessione PostgreSQL reale |
| `SESSION_SECRET` | KV reference | `@Microsoft.KeyVault(SecretUri=...)` |
| `SAML_ENTRY_POINT` | placeholder | Sostituire con l'endpoint Entra ID reale |
| `SAML_ISSUER` | placeholder | Sostituire con l'Entity ID reale |
| `SAML_CALLBACK_URL` | placeholder | Sostituire con l'ACS URL reale |
| `SAML_CERT` | KV reference | Upload manuale del certificato PEM |
| `WLC_DEFAULT_PASSWORD` | KV reference | `az keyvault secret set` |
| `SAML_DECRYPTION_KEY` | KV reference | Opzionale |
| `SAML_LOGOUT_URL` | KV reference | Opzionale (SLO) |
| `SAML_LOGOUT_CALLBACK_URL` | KV reference | Opzionale (SLO) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | KV reference | Opzionale |
| `BACKEND_BASE_URL` | auto | `http://ca-guestportal-backend-{env}.{aca-domain}` |

## Key Vault Secrets

Lo script popola automaticamente i seguenti secret in Key Vault (solo se non esistono già):

| Secret Name | Valore Iniziale | Azione Richiesta |
|-------------|-----------------|------------------|
| `SESSION-SECRET` | Random 64-char (auto-generato) | ✅ Nessuna |
| `SAML-CERT` | `PLACEHOLDER-upload-real-certificate...` | ⚠️ Upload manuale |
| `WLC-DEFAULT-PASSWORD` | `PLACEHOLDER-set-real-wlc-password` | ⚠️ Impostare valore reale |
| `SAML-DECRYPTION-KEY` | `""` (vuoto) | Opzionale |
| `SAML-LOGOUT-URL` | `""` (vuoto) | Opzionale (SLO) |
| `SAML-LOGOUT-CALLBACK-URL` | `""` (vuoto) | Opzionale (SLO) |
| `APPINSIGHTS-CONNECTION-STRING` | `""` (vuoto) | Opzionale |

### Comandi per aggiornare i secret

```bash
# Certificato SAML
az keyvault secret set --vault-name kv-guestportal-dev --name SAML-CERT --file ./saml-cert.pem

# WLC password
az keyvault secret set --vault-name kv-guestportal-dev --name WLC-DEFAULT-PASSWORD --value "<real-password>"
```

## OIDC Setup per GitHub Actions

Prima di tutto, configurare il **federated identity credential** che permette a GitHub Actions
di autenticarsi su Azure senza secret fissi (OIDC).

### Script automatico

```bash
./scripts/setup-oidc.sh <org>/centralino
```

> **Nota**: servono permessi di **Application Administrator** in Entra ID (oltre a Contributor sulla subscription).

Lo script:
1. Crea un'**App Registration** in Microsoft Entra ID (riusa se già esistente)
2. Crea un **service principal** per l'app
3. Configura **5 federated credentials** per GitHub Actions:
   - `ref:refs/heads/main` → push su main (prod)
   - `ref:refs/heads/staging` → push su staging (stg)
   - `environment:dev`, `environment:stg`, `environment:prd` → workflow_dispatch
4. Assegna il ruolo **Key Vault Secrets User** su tutti i Key Vault esistenti
5. Output dei tre valori da inserire come GitHub secrets

### Permessi necessari

- **Application Administrator** in Entra ID (per creare App Registrations)
- **Contributor** sulla subscription (per assegnare ruoli RBAC su Key Vault)

### Cosa inserire in GitHub Secrets

Dopo aver eseguito lo script, configurare in:
`Settings → Secrets and variables → Actions → Repository secrets`

| Secret | Valore |
|--------|--------|
| `AZURE_CLIENT_ID` | App ID dell'App Registration (output dello script) |
| `AZURE_TENANT_ID` | Tenant ID (output dello script) |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID (output dello script) |

### Verifica

Una volta configurati i secret, eseguire il workflow di provisioning in dry-run:
 `GitHub → Actions → Provision Azure Infrastructure → Run workflow (dry_run=true)`

---

## Post-Provisioning: GitHub Secrets

Dopo il provisioning, configurare i seguenti **GitHub Actions secrets** in:
`Settings → Secrets and variables → Actions → Repository secrets`

| Secret | Valore |
|--------|--------|
| `ACA_ENVIRONMENT_DEFAULT_DOMAIN` | `{domain}.azurecontainerapps.io` (dallo script) |
| `ACR_NAME` | Nome ACR inserito durante il provisioning |
| `AZURE_CLIENT_ID` | Output di `setup-oidc.sh` (vedi [OIDC Setup](#oidc-setup-per-github-actions) sopra) |
| `AZURE_TENANT_ID` | Tenant ID (dallo script) |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID (dallo script) |
| `DATABASE_URL` | `postgres://uami-guestportal-backend-{env}@{host}:5432/guestportal_{env}` (user = nome UAMI, no password) |
| `POSTGRES_SERVER_NAME` | Nome PostgreSQL Flexible Server |
| `POSTGRES_ADMIN_USER` | Entra admin (usato solo per bootstrap DB + principal) |
| `SAML_ENTRY_POINT` | `https://login.microsoftonline.com/{tid}/saml2` |
| `SAML_ISSUER` | `https://guestportal-{env}.dompe.com/saml` |
| `SAML_CALLBACK_URL` | `https://guestportal-{env}.dompe.com/api/auth/callback` |
| `MAIL_GRAPH_CLIENT_ID` | Client ID della App Registration Graph API (email) |
| `MAIL_GRAPH_USER_ID` | User ID/UPN della mailbox che invia le email |

## Integrazione con CI/CD Pipeline

Dopo il provisioning e la configurazione dei GitHub secrets, la pipeline
`.github/workflows/deploy-azure.yml` gestisce i deploy successivi:

1. **Stage 1** — Build & Scan (typecheck, test, Trivy, push ad ACR)
2. **Stage 2** — DB Bootstrap (crea database e utente PostgreSQL)
3. **Stage 3** — DB Migration (esegue ACA job)
4. **Stage 4** — Deploy (aggiorna immagine + env vars su ACA)
5. **Stage 5** — Verify (health check + App Gateway pool update)

## Troubleshooting

| Problema | Causa | Soluzione |
|----------|-------|-----------|
| `AADSTS50173` | Token Azure scaduto | `az logout && az login` |
| `Authorization failed` | Permessi RBAC insufficienti | Verificare Contributor + User Access Admin |
| `ACR not found` | Nome ACR errato | Verificare con `az acr list --query "[].name"` |
| ACA env non si crea | Location non supportata | Verificare che `westeurope` supporti ACA |
