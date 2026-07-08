#!/usr/bin/env bash
# =============================================================================
# Cisco Guest Desk — Azure Infrastructure Provisioning Script
# =============================================================================
# Idempotent provisioning of:
#   - Azure Key Vault (per-environment secrets)
#   - User-Assigned Managed Identities (backend + frontend)
#   - Azure Container Apps Environment
#   - Backend ACA container app (with Key Vault references)
#   - Frontend ACA container app (nginx, static SPA)
#   - ACA migration job
#   - Key Vault secrets (initial population)
#
# Usage:
#   ./scripts/provision.sh <environment> [--dry-run]
#
#   <environment>: dev | stg | prd
#   --dry-run / -n: Print all az commands without executing them
#
# Prerequisites:
#   - Azure CLI (az) installed and logged in (az login)
#   - jq installed (for JSON parsing)
#   - Appropriate Azure RBAC permissions (Contributor + User Access Administrator)
#
# ── Dry-run limitation ────────────────────────────────────────────────────────
# In --dry-run mode, commands wrapped with the `run()` function are printed
# instead of executed. However, commands captured via `$(run ...)` command
# substitution (used to fetch resource IDs, domains, etc.) will echo the
# printed command text rather than the real Azure output. This means:
#
#   - Variables populated from `$(run ...)` captures will contain placeholder
#     text (e.g. the echoed command line) instead of real resource IDs.
#   - Consequently, the summary output (UAMI IDs, ACA default domain, etc.)
#     will show garbled/placeholder values — these are not real Azure values.
#   - Only the `az account show` calls in the prerequisite check run for real
#     (they are NOT wrapped) so the subscription/tenant info is accurate.
#
# This is an accepted trade-off inherent to shell-based dry-runs. To see real
# resource values, run without --dry-run or look up resources directly via az.
# ──────────────────────────────────────────────────────────────────────────────
#
# Examples:
#   ./scripts/provision.sh dev             # Provision dev environment
#   ./scripts/provision.sh prd              # Provision production environment
#   ./scripts/provision.sh stg --dry-run    # Preview commands for staging
#
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

# ── Dry-run aware command execution ──────────────────────────────────────────
# If DRY_RUN is true, print the command instead of executing it.
# Otherwise, execute it normally.
run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}az $*${NC}"
  else
    az "$@"
  fi
}

# ── Parse arguments ──────────────────────────────────────────────────────────
DRY_RUN=false
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -n) DRY_RUN=true; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

ENV="${POSITIONAL[0]:-}"
if [[ -z "$ENV" ]]; then
  err "Missing environment argument. Usage: $0 <dev|stg|prd> [--dry-run]"
  exit 1
fi

case "$ENV" in
  dev|stg|prd) ;;
  *) err "Invalid environment '$ENV'. Use: dev, stg, or prd."; exit 1 ;;
esac

if [[ "$DRY_RUN" == true ]]; then
  warn "DRY RUN MODE — commands will be printed but NOT executed."
fi

# ── Configuration ───────────────────────────────────────────────────────────
# Resource naming (matches conventions in .github/workflows/deploy-azure.yml)
RG_NAME="rg-cgd-${ENV}"
LOCATION="westeurope"                          # Change as needed
ACA_ENV_NAME="cae-cgd-${ENV}"
ACR_NAME="${ACR_NAME:-}"                        # Set via prompt if empty, or from env var (e.g. GitHub Actions)
KV_NAME="kv-cgd-${ENV}"
UAMI_BACKEND="uami-cgd-backend-${ENV}"
UAMI_FRONTEND="uami-cgd-frontend-${ENV}"
ACA_BACKEND="ca-cgd-backend-${ENV}"
ACA_FRONTEND="ca-cgd-frontend-${ENV}"
ACA_MIGRATION_JOB="job-cgd-migrate-${ENV}"

# Docker images (update with your ACR name)
BACKEND_IMAGE="${ACR_NAME}.azurecr.io/cgd-backend:latest"
FRONTEND_IMAGE="${ACR_NAME}.azurecr.io/cgd-frontend:latest"

# ACA resource constraints
BACKEND_CPU="1.0"
BACKEND_MEMORY="2.0Gi"
FRONTEND_CPU="0.5"
FRONTEND_MEMORY="1.0Gi"
MIN_REPLICAS=1
MAX_REPLICAS=1  # Autoscaling disabled per platform guidelines

# Entra ID scope for PostgreSQL
AZURE_SCOPE="https://ossrdbms.database.windows.net/.default"

# ── Pre-flight checks ───────────────────────────────────────────────────────
check_prerequisites() {
  info "Checking prerequisites..."

  if ! command -v az &>/dev/null; then
    err "Azure CLI not found. Install from https://aka.ms/install-azure-cli"
    exit 1
  fi

  if ! command -v jq &>/dev/null; then
    err "jq not found. Install: apt install jq / brew install jq"
    exit 1
  fi

  # Verify Azure login
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

# ── Prompt for ACR name if not set ──────────────────────────────────────────
prompt_acr() {
  if [[ -z "$ACR_NAME" ]]; then
    read -rp "Enter ACR name (e.g. crcgddev): " ACR_NAME
    BACKEND_IMAGE="${ACR_NAME}.azurecr.io/cgd-backend:latest"
    FRONTEND_IMAGE="${ACR_NAME}.azurecr.io/cgd-frontend:latest"
  fi
}

# ── Resource Group ──────────────────────────────────────────────────────────
provision_resource_group() {
  info "Ensuring resource group '$RG_NAME' in '$LOCATION'..."
  if run group show --name "$RG_NAME" &>/dev/null; then
    ok "Resource group '$RG_NAME' already exists."
  else
    run group create --name "$RG_NAME" --location "$LOCATION" --tags \
      application="cgd" \
      environment="$ENV" \
      managed-by="provision-script" \
      --output none
    ok "Resource group '$RG_NAME' created."
  fi
}

# ── Key Vault ───────────────────────────────────────────────────────────────
provision_key_vault() {
  info "Ensuring Key Vault '$KV_NAME'..."

  if run keyvault show --name "$KV_NAME" --resource-group "$RG_NAME" &>/dev/null; then
    ok "Key Vault '$KV_NAME' already exists."
  else
    run keyvault create \
      --name "$KV_NAME" \
      --resource-group "$RG_NAME" \
      --location "$LOCATION" \
      --sku standard \
      --enable-rbac-authorization true \
      --output none
    ok "Key Vault '$KV_NAME' created."

    # Grant current user full access to manage secrets
    USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    if [[ -n "$USER_OBJECT_ID" ]]; then
      run role assignment create \
        --assignee "$USER_OBJECT_ID" \
        --role "Key Vault Secrets Officer" \
        --scope "$(run keyvault show --name "$KV_NAME" --query id -o tsv)" \
        --output none
      ok "Granted current user 'Key Vault Secrets Officer' role."
    fi
  fi
}

# ── User-Assigned Managed Identities ────────────────────────────────────────
provision_uami() {
  info "Ensuring UAMI '$UAMI_BACKEND'..."
  local backend_id backend_principal

  if run identity show --name "$UAMI_BACKEND" --resource-group "$RG_NAME" &>/dev/null; then
    ok "UAMI '$UAMI_BACKEND' already exists."
  else
    run identity create \
      --name "$UAMI_BACKEND" \
      --resource-group "$RG_NAME" \
      --location "$LOCATION" \
      --output none
    ok "UAMI '$UAMI_BACKEND' created."
  fi

  backend_id=$(run identity show --name "$UAMI_BACKEND" --resource-group "$RG_NAME" --query id -o tsv)
  backend_principal=$(run identity show --name "$UAMI_BACKEND" --resource-group "$RG_NAME" --query principalId -o tsv)

  info "Ensuring UAMI '$UAMI_FRONTEND'..."
  if run identity show --name "$UAMI_FRONTEND" --resource-group "$RG_NAME" &>/dev/null; then
    ok "UAMI '$UAMI_FRONTEND' already exists."
  else
    run identity create \
      --name "$UAMI_FRONTEND" \
      --resource-group "$RG_NAME" \
      --location "$LOCATION" \
      --output none
    ok "UAMI '$UAMI_FRONTEND' created."
  fi

  local frontend_id
  frontend_id=$(run identity show --name "$UAMI_FRONTEND" --resource-group "$RG_NAME" --query id -o tsv)

  # Assign Key Vault Secrets User role for backend UAMI
  info "Assigning KV Secrets User role to backend UAMI..."
  local kv_scope
  kv_scope=$(run keyvault show --name "$KV_NAME" --query id -o tsv)

  if ! run role assignment list --assignee "$backend_principal" --scope "$kv_scope" --role "Key Vault Secrets User" --query "[].id" -o tsv | grep -q .; then
    run role assignment create \
      --assignee "$backend_principal" \
      --role "Key Vault Secrets User" \
      --scope "$kv_scope" \
      --output none
    ok "Backend UAMI assigned 'Key Vault Secrets User' on '$KV_NAME'."
  else
    ok "Backend UAMI already has 'Key Vault Secrets User' role."
  fi

  # Export for later use
  UAMI_BACKEND_ID="$backend_id"
  UAMI_FRONTEND_ID="$frontend_id"
}

# ── ACA Environment ─────────────────────────────────────────────────────────
provision_aca_environment() {
  info "Ensuring ACA environment '$ACA_ENV_NAME'..."

  if run containerapp env show --name "$ACA_ENV_NAME" --resource-group "$RG_NAME" &>/dev/null; then
    ok "ACA environment '$ACA_ENV_NAME' already exists."
  else
    run containerapp env create \
      --name "$ACA_ENV_NAME" \
      --resource-group "$RG_NAME" \
      --location "$LOCATION" \
      --enable-workload-profiles false \
      --output none
    ok "ACA environment '$ACA_ENV_NAME' created."
  fi

  # Capture the default domain for later use
  ACA_DEFAULT_DOMAIN=$(run containerapp env show \
    --name "$ACA_ENV_NAME" \
    --resource-group "$RG_NAME" \
    --query "properties.defaultDomain" \
    --output tsv)

  if [[ -z "$ACA_DEFAULT_DOMAIN" ]]; then
    warn "Could not determine ACA default domain. ACA environment may still be provisioning."
    ACA_DEFAULT_DOMAIN="<pending>"
  else
    info "ACA default domain: ${ACA_DEFAULT_DOMAIN}"
  fi
}

# ── Backend ACA Container App ────────────────────────────────────────────────
provision_backend_aca() {
  info "Ensuring backend ACA '$ACA_BACKEND'..."

  local kv_base="https://${KV_NAME}.vault.azure.net/"
  local uami_resource_id="$UAMI_BACKEND_ID"

  # Build the full env-var list with inline Key Vault references
  # (matches the format used by the deploy pipeline)
  local ENV_VARS=(
    NODE_ENV=production
    PORT=3000
    LOG_LEVEL=info
    BACKEND_BASE_URL="http://${ACA_BACKEND}.${ACA_DEFAULT_DOMAIN}"
    DATABASE_URL="postgres://cgd_app_${ENV}@<postgres-host>.postgres.database.azure.com:5432/cgd_${ENV}"
    SESSION_SECRET="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SESSION-SECRET/)"
    SAML_ENTRY_POINT="https://login.microsoftonline.com/<tenant-id>/saml2"
    SAML_ISSUER="https://cgd-${ENV}.internal.dompe.com/saml"
    SAML_CALLBACK_URL="https://cgd-${ENV}.internal.dompe.com/api/auth/callback"
    SAML_CERT="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-CERT/)"
    WLC_DEFAULT_PASSWORD="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/WLC-DEFAULT-PASSWORD/)"
    SAML_DECRYPTION_KEY="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-DECRYPTION-KEY/)"
    SAML_LOGOUT_URL="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-LOGOUT-URL/)"
    SAML_LOGOUT_CALLBACK_URL="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/SAML-LOGOUT-CALLBACK-URL/)"
    APPLICATIONINSIGHTS_CONNECTION_STRING="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/APPINSIGHTS-CONNECTION-STRING/)"
    # Microsoft Graph API Email (platform-provided App Registration)
    MAIL_GRAPH_ENABLED=false
    MAIL_GRAPH_TENANT_ID="<tenant-id>"
    MAIL_GRAPH_CLIENT_ID="<client-id>"
    MAIL_GRAPH_CLIENT_SECRET="@Microsoft.KeyVault(SecretUri=${kv_base}secrets/MAIL-GRAPH-CLIENT-SECRET/)"
    MAIL_GRAPH_USER_ID="<user-id>"
    MAIL_GRAPH_FROM_ADDRESS="noreply@dompe.com"
  )

  if run containerapp show --name "$ACA_BACKEND" --resource-group "$RG_NAME" &>/dev/null; then
    ok "Backend ACA '$ACA_BACKEND' already exists."
    # Don't update env vars here — the deploy pipeline handles that
    # via az containerapp update --set-env-vars during Stage 4.
  else
    info "Creating backend ACA '$ACA_BACKEND'..."
    run containerapp create \
      --name "$ACA_BACKEND" \
      --resource-group "$RG_NAME" \
      --environment "$ACA_ENV_NAME" \
      --image "$BACKEND_IMAGE" \
      --cpu "$BACKEND_CPU" \
      --memory "$BACKEND_MEMORY" \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --target-port 3000 \
      --ingress internal \
      --transport http \
      --user-assigned "$uami_resource_id" \
      --env-vars "${ENV_VARS[@]}" \
      --output none
    ok "Backend ACA '$ACA_BACKEND' created."
  fi
}

# ── Frontend ACA Container App ───────────────────────────────────────────────
provision_frontend_aca() {
  info "Ensuring frontend ACA '$ACA_FRONTEND'..."

  local uami_resource_id="$UAMI_FRONTEND_ID"

  if run containerapp show --name "$ACA_FRONTEND" --resource-group "$RG_NAME" &>/dev/null; then
    ok "Frontend ACA '$ACA_FRONTEND' already exists."
  else
    info "Creating frontend ACA '$ACA_FRONTEND'..."
    run containerapp create \
      --name "$ACA_FRONTEND" \
      --resource-group "$RG_NAME" \
      --environment "$ACA_ENV_NAME" \
      --image "$FRONTEND_IMAGE" \
      --cpu "$FRONTEND_CPU" \
      --memory "$FRONTEND_MEMORY" \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --target-port 3000 \
      --ingress internal \
      --transport http \
      --user-assigned "$uami_resource_id" \
      --output none
    ok "Frontend ACA '$ACA_FRONTEND' created."
  fi
}

# ── ACA Migration Job ───────────────────────────────────────────────────────
provision_migration_job() {
  info "Ensuring ACA migration job '$ACA_MIGRATION_JOB'..."

  if run containerapp job show --name "$ACA_MIGRATION_JOB" --resource-group "$RG_NAME" &>/dev/null; then
    ok "Migration job '$ACA_MIGRATION_JOB' already exists."
  else
    run containerapp job create \
      --name "$ACA_MIGRATION_JOB" \
      --resource-group "$RG_NAME" \
      --environment "$ACA_ENV_NAME" \
      --trigger-type Manual \
      --replica-timeout 300 \
      --image "$BACKEND_IMAGE" \
      --command "node backend/dist/db/migrate.js" \
      --registry-server "${ACR_NAME}.azurecr.io" \
      --cpu "0.5" \
      --memory "1.0Gi" \
      --mi-user-assigned "$UAMI_BACKEND_ID" \
      --output none
    ok "Migration job '$ACA_MIGRATION_JOB' created."
  fi
}

# ── Initial Key Vault Secrets ────────────────────────────────────────────────
seed_key_vault_secrets() {
  info "Seeding initial Key Vault secrets (if not already set)..."

  # Helper: set a secret only if it doesn't exist
  set_secret_if_missing() {
    local name="$1"
    local value="$2"
    if run keyvault secret show --vault-name "$KV_NAME" --name "$name" &>/dev/null; then
      ok "Secret '$name' already exists in KV — skipping."
    else
      run keyvault secret set \
        --vault-name "$KV_NAME" \
        --name "$name" \
        --value "$value" \
        --output none
      ok "Secret '$name' created."
    fi
  }

  # Generate a secure random session secret
  local SESSION_SECRET
  SESSION_SECRET=$(openssl rand -base64 48 2>/dev/null || echo "change-me-to-a-random-64-char-string")
  set_secret_if_missing "SESSION-SECRET" "$SESSION_SECRET"

  # SAML certificate (placeholder — operator must upload the real one)
  set_secret_if_missing "SAML-CERT" "PLACEHOLDER-upload-real-certificate-via-az-keyvault-secret-set"

  # WLC default password (placeholder)
  set_secret_if_missing "WLC-DEFAULT-PASSWORD" "PLACEHOLDER-set-real-wlc-password"

  # Optional secrets (set as empty placeholders)
  set_secret_if_missing "SAML-DECRYPTION-KEY" ""
  set_secret_if_missing "SAML-LOGOUT-URL" ""
  set_secret_if_missing "SAML-LOGOUT-CALLBACK-URL" ""
  set_secret_if_missing "APPINSIGHTS-CONNECTION-STRING" ""

  # Microsoft Graph API email client secret (placeholder — set real value after App Registration is created)
  set_secret_if_missing "MAIL-GRAPH-CLIENT-SECRET" ""

  ok "Key Vault secrets initialized."
}

# ── Output GitHub Secrets ───────────────────────────────────────────────────
print_github_secrets() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  GitHub Actions secrets to configure                       ${NC}"
  echo -e "${CYAN}  GitHub → Settings → Secrets and variables → Actions       ${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${YELLOW}Repository secrets:${NC}"
  echo "  ACA_ENVIRONMENT_DEFAULT_DOMAIN  = ${ACA_DEFAULT_DOMAIN:-<pending>}"
  echo "  ACR_NAME                        = ${ACR_NAME}"
  echo "  AZURE_CLIENT_ID                 = <set-your-OIDC-federated-credential-client-id>"
  echo "  AZURE_TENANT_ID                 = ${TENANT_ID}"
  echo "  AZURE_SUBSCRIPTION_ID           = ${SUBSCRIPTION_ID}"
  echo "  DATABASE_URL                    = postgres://cgd_app_${ENV}@<postgres-host>.postgres.database.azure.com:5432/cgd_${ENV}"
  echo "  POSTGRES_SERVER_NAME            = <postgres-flexible-server-name>"
  echo "  POSTGRES_ADMIN_USER             = <postgres-admin-user>"
  echo "  POSTGRES_ADMIN_PASSWORD         = <postgres-admin-password>"
  echo "  POSTGRES_APP_PASSWORD           = <postgres-app-password>"
  echo "  SAML_ENTRY_POINT                = https://login.microsoftonline.com/<tenant-id>/saml2"
  echo "  SAML_ISSUER                     = https://cgd-${ENV}.internal.dompe.com/saml"
  echo "  SAML_CALLBACK_URL               = https://cgd-${ENV}.internal.dompe.com/api/auth/callback"
  echo ""
  echo -e "${YELLOW}UAMI resource IDs (needed for containerapp create/update):${NC}"
  echo "  Backend:  ${UAMI_BACKEND_ID}"
  echo "  Frontend: ${UAMI_FRONTEND_ID}"
  echo ""
  echo -e "${YELLOW}Key Vault:${NC}"
  echo "  Name:      ${KV_NAME}"
  echo "  URI:       https://${KV_NAME}.vault.azure.net/"
  echo "  RBAC:      Assign 'Key Vault Secrets User' role to each UAMI"
  echo ""
  echo -e "${YELLOW}PostgreSQL connection (Entra ID auth):${NC}"
  echo "  DATABASE_URL = postgres://cgd_app_${ENV}@<host>.postgres.database.azure.com:5432/cgd_${ENV}"
  echo "  (No password — Entra ID token is obtained at runtime via DefaultAzureCredential)"
  echo ""
  echo -e "${YELLOW}Next steps:${NC}"
  echo "  1. Upload SAML certificate: az keyvault secret set --vault-name ${KV_NAME} --name SAML-CERT --file ./saml-cert.pem"
  echo "  2. Set WLC password: az keyvault secret set --vault-name ${KV_NAME} --name WLC-DEFAULT-PASSWORD --value <password>"
  echo "  3. Configure GitHub secrets (see above)"
  echo "  4. Run the pipeline: .github/workflows/deploy-azure.yml"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

# ── Summary ──────────────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Provisioning complete for environment: ${ENV}${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Resource Group:               ${RG_NAME}"
  echo "  Key Vault:                    ${KV_NAME}"
  echo "  ACA Environment:              ${ACA_ENV_NAME}"
  echo "  ACA Default Domain:           ${ACA_DEFAULT_DOMAIN}"
  echo "  Backend ACA:                  ${ACA_BACKEND}"
  echo "  Frontend ACA:                 ${ACA_FRONTEND}"
  echo "  Migration Job:                ${ACA_MIGRATION_JOB}"
  echo "  UAMI Backend:                 ${UAMI_BACKEND}"
  echo "  UAMI Frontend:                ${UAMI_FRONTEND}"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Cisco Guest Desk — Azure Infrastructure Provisioner         ${NC}"
  echo -e "${CYAN}  Environment: ${ENV}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""

  check_prerequisites
  prompt_acr

  provision_resource_group
  provision_key_vault
  provision_uami
  provision_aca_environment
  provision_backend_aca
  provision_frontend_aca
  provision_migration_job
  seed_key_vault_secrets

  print_summary
  print_github_secrets

  echo -e "${GREEN}Done.${NC}"
}

main "$@"
