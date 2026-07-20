#!/usr/bin/env bash
# =============================================================================
# Cisco Guest Desk (guestportal) — Platform Preflight / Verify (READ-ONLY)
# =============================================================================
# Operating model: CONSUME-ONLY.
#
# The platform (infrastructure team) pre-provisions every Azure resource:
#   Resource Group, Key Vault, ACA environment, the two Container Apps, the
#   UAMIs (backend/frontend), the PostgreSQL server + database + the Entra role
#   mapped to the backend UAMI, the migration ACA job, the ACR and the
#   Application Gateway.
#
# This script does NOT create anything. It only *verifies* that the expected
# platform resources exist (via `az ... show`) and prints the configuration map
# (env var → Key Vault reference) that the infrastructure team must apply.
#
# Resource names are PARAMETRIZED — pass the real names (provided by the infra
# team) via environment variables; nothing is hard-coded.
#
# Usage:
#   RG_NAME=... KV_NAME=... ACA_ENV_NAME=... ACA_BACKEND_NAME=... \
#   ACA_FRONTEND_NAME=... MIGRATION_JOB_NAME=... UAMI_BACKEND_NAME=... \
#   UAMI_FRONTEND_NAME=... ACR_NAME=... PG_SERVER_NAME=... \
#   ./scripts/provision.sh <dev|stg|prod>
#
# Prerequisites:
#   - Azure CLI (az) installed and logged in (az login)
#   - Read access (Reader) on the resource group is sufficient
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ── Colour output helpers ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Parse arguments ──────────────────────────────────────────────────────────
ENV="${1:-}"
if [[ -z "$ENV" ]]; then
  err "Missing environment argument. Usage: $0 <dev|stg|prod>"
  exit 1
fi
case "$ENV" in
  dev|stg|prod) ;;
  *) err "Invalid environment '$ENV'. Use: dev, stg, or prod."; exit 1 ;;
esac

# ── Parametrized platform resource names (supplied by infra team) ────────────
RG_NAME="${RG_NAME:-}"
KV_NAME="${KV_NAME:-}"
ACA_ENV_NAME="${ACA_ENV_NAME:-}"
ACA_BACKEND_NAME="${ACA_BACKEND_NAME:-}"
ACA_FRONTEND_NAME="${ACA_FRONTEND_NAME:-}"
MIGRATION_JOB_NAME="${MIGRATION_JOB_NAME:-}"
UAMI_BACKEND_NAME="${UAMI_BACKEND_NAME:-}"
UAMI_FRONTEND_NAME="${UAMI_FRONTEND_NAME:-}"
ACR_NAME="${ACR_NAME:-}"
PG_SERVER_NAME="${PG_SERVER_NAME:-}"

# The DB login role MUST be the backend UAMI name (Entra auth).
DB_ENTRA_LOGIN="${UAMI_BACKEND_NAME}"
DB_NAME="${DB_NAME:-guestportal_${ENV}}"

# ── Application hostname (corporate DNS zone dompe.com) ──────────────────────
# prod has NO suffix; dev/stg are suffixed.
app_hostname() {
  case "$1" in
    prod) echo "guestportal.dompe.com" ;;
    stg)  echo "guestportal-stg.dompe.com" ;;
    dev)  echo "guestportal-dev.dompe.com" ;;
  esac
}
APP_HOSTNAME="$(app_hostname "$ENV")"

# ── Pre-flight checks ───────────────────────────────────────────────────────
check_prerequisites() {
  info "Checking prerequisites..."
  if ! command -v az &>/dev/null; then
    err "Azure CLI not found. Install from https://aka.ms/install-azure-cli"
    exit 1
  fi
  if ! az account show &>/dev/null; then
    err "Not logged into Azure. Run: az login"
    exit 1
  fi
  SUBSCRIPTION_ID=$(az account show --query id -o tsv)
  TENANT_ID=$(az account show --query tenantId -o tsv)
  info "Subscription: $SUBSCRIPTION_ID"
  info "Tenant:       $TENANT_ID"
  info "Environment:  ${ENV}"
  ok "Prerequisites satisfied."
}

# ── Verify a required name is provided ───────────────────────────────────────
MISSING_NAMES=0
require_name() {
  local var_name="$1" value="$2"
  if [[ -z "$value" ]]; then
    err "Missing required input: ${var_name} (provided by the infrastructure team)."
    MISSING_NAMES=1
  fi
}

check_inputs() {
  info "Validating parametrized resource names..."
  require_name RG_NAME "$RG_NAME"
  require_name KV_NAME "$KV_NAME"
  require_name ACA_ENV_NAME "$ACA_ENV_NAME"
  require_name ACA_BACKEND_NAME "$ACA_BACKEND_NAME"
  require_name ACA_FRONTEND_NAME "$ACA_FRONTEND_NAME"
  require_name MIGRATION_JOB_NAME "$MIGRATION_JOB_NAME"
  require_name UAMI_BACKEND_NAME "$UAMI_BACKEND_NAME"
  require_name UAMI_FRONTEND_NAME "$UAMI_FRONTEND_NAME"
  if [[ "$MISSING_NAMES" -ne 0 ]]; then
    err "One or more required names are missing. Provide them as env vars (see usage)."
    exit 1
  fi
  ok "All required names provided."
}

# ── Read-only existence checks (no creation) ─────────────────────────────────
VERIFY_FAILED=0
verify() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    ok "${label} exists."
  else
    err "${label} NOT found (must be pre-provisioned by the platform)."
    VERIFY_FAILED=1
  fi
}

verify_resources() {
  info "Verifying platform resources exist (read-only)..."
  verify "Resource Group '${RG_NAME}'" \
    az group show --name "$RG_NAME"
  verify "Key Vault '${KV_NAME}'" \
    az keyvault show --name "$KV_NAME" --resource-group "$RG_NAME"
  verify "ACA environment '${ACA_ENV_NAME}'" \
    az containerapp env show --name "$ACA_ENV_NAME" --resource-group "$RG_NAME"
  verify "Backend Container App '${ACA_BACKEND_NAME}'" \
    az containerapp show --name "$ACA_BACKEND_NAME" --resource-group "$RG_NAME"
  verify "Frontend Container App '${ACA_FRONTEND_NAME}'" \
    az containerapp show --name "$ACA_FRONTEND_NAME" --resource-group "$RG_NAME"
  verify "Migration job '${MIGRATION_JOB_NAME}'" \
    az containerapp job show --name "$MIGRATION_JOB_NAME" --resource-group "$RG_NAME"
  verify "UAMI backend '${UAMI_BACKEND_NAME}'" \
    az identity show --name "$UAMI_BACKEND_NAME" --resource-group "$RG_NAME"
  verify "UAMI frontend '${UAMI_FRONTEND_NAME}'" \
    az identity show --name "$UAMI_FRONTEND_NAME" --resource-group "$RG_NAME"
  if [[ -n "$ACR_NAME" ]]; then
    verify "ACR '${ACR_NAME}'" az acr show --name "$ACR_NAME"
  else
    warn "ACR_NAME not provided — skipping ACR check."
  fi
  if [[ -n "$PG_SERVER_NAME" ]]; then
    verify "PostgreSQL server '${PG_SERVER_NAME}'" \
      az postgres flexible-server show --name "$PG_SERVER_NAME" --resource-group "$RG_NAME"
  else
    warn "PG_SERVER_NAME not provided — skipping PostgreSQL check."
  fi
}

# ── Configuration map to hand to the infra team ──────────────────────────────
print_config_map() {
  local kv_base="https://${KV_NAME}.vault.azure.net/"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Configuration map — apply on the backend Container App        ${NC}"
  echo -e "${CYAN}  (env var → value / Key Vault reference)                       ${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  # Plain (non-secret) values"
  echo "  NODE_ENV=production"
  echo "  PORT=3000"
  echo "  LOG_LEVEL=info"
  echo "  SKIP_MIGRATIONS=true"
  echo "  SEED_ENABLED=false"
  echo "  BACKEND_BASE_URL=http://${ACA_BACKEND_NAME}.<aca-environment-default-domain>"
  echo "  SAML_ENTRY_POINT=https://login.microsoftonline.com/<tenant-id>/saml2"
  echo "  SAML_ISSUER=https://${APP_HOSTNAME}/saml"
  echo "  SAML_CALLBACK_URL=https://${APP_HOSTNAME}/api/auth/callback"
  echo ""
  echo "  # DATABASE_URL — Entra ID auth, NO password. User = backend UAMI name."
  echo "  DATABASE_URL=postgres://${DB_ENTRA_LOGIN}@<pg-host>.postgres.database.azure.com:5432/${DB_NAME}"
  echo ""
  echo "  # Key Vault references (secret values managed by the platform/owner)"
  echo "  SESSION_SECRET=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SESSION-SECRET/)"
  echo "  SAML_CERT=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-CERT/)"
  echo "  SAML_DECRYPTION_KEY=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-DECRYPTION-KEY/)"
  echo "  SAML_LOGOUT_URL=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-LOGOUT-URL/)"
  echo "  SAML_LOGOUT_CALLBACK_URL=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-LOGOUT-CALLBACK-URL/)"
  echo "  # WLC admin password — one Key Vault secret per sede (§2), injected as env:"
  echo "  WLC_PASSWORD_MIL=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-PASSWORD-MIL/)"
  echo "  WLC_PASSWORD_AQ=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-PASSWORD-AQ/)"
  echo "  WLC_PASSWORD_NA=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-PASSWORD-NA/)"
  echo "  WLC_PASSWORD_TIR=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-PASSWORD-TIR/)"
  echo "  WLC_PASSWORD_SM=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-PASSWORD-SM/)"
  echo "  APPLICATIONINSIGHTS_CONNECTION_STRING=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/APPINSIGHTS-CONNECTION-STRING/)"
  echo "  MAIL_GRAPH_CLIENT_SECRET=@Microsoft.KeyVault(SecretUri=${kv_base}secrets/MAIL-GRAPH-CLIENT-SECRET/)"
  echo ""
  echo -e "${YELLOW}Platform prerequisites (infra team) — NOT created by this repo:${NC}"
  echo "  - The backend UAMI '${DB_ENTRA_LOGIN}' must have 'Key Vault Secrets User' on '${KV_NAME}'."
  echo "  - The PostgreSQL Entra role mapped to the backend UAMI must exist, e.g.:"
  echo "      SELECT * FROM pgaadauth_create_principal('${DB_ENTRA_LOGIN}', false, false);"
  echo "    plus GRANTs on database '${DB_NAME}'."
  echo "  - The migration ACA job '${MIGRATION_JOB_NAME}' must reference the backend"
  echo "    UAMI and DATABASE_URL, and run 'node backend/dist/db/migrate.js'."
  echo "  - One Key Vault secret per sede for the WLC admin password (§2):"
  echo "      WLC-PASSWORD-MIL, WLC-PASSWORD-AQ, WLC-PASSWORD-NA, WLC-PASSWORD-TIR, WLC-PASSWORD-SM"
  echo "  - The pipeline OIDC identity (App Registration + federated credentials)"
  echo "    is also created by infra (see scripts/setup-oidc.sh)."
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  guestportal — Platform Preflight (READ-ONLY, consume-only)   ${NC}"
  echo -e "${CYAN}  Environment: ${ENV}   Hostname: ${APP_HOSTNAME}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""

  check_prerequisites
  check_inputs
  verify_resources
  print_config_map

  if [[ "$VERIFY_FAILED" -ne 0 ]]; then
    err "One or more platform resources are missing. Ask the infrastructure team to provision them."
    exit 1
  fi
  ok "Preflight complete — all expected platform resources are present."
}

main "$@"
