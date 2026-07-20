#!/usr/bin/env bash
# =============================================================================
# Cisco Guest Desk — Azure OIDC Federated Credential Setup
# =============================================================================
# Creates/updates an Azure AD App Registration with federated identity
# credentials for GitHub Actions (OIDC), and outputs the three secrets
# needed by the CI/CD pipelines:
#
#   AZURE_CLIENT_ID       → App Registration Application (client) ID
#   AZURE_TENANT_ID       → Azure AD tenant ID
#   AZURE_SUBSCRIPTION_ID → Azure subscription ID
#
# Prerequisites:
#   - Azure CLI (az) installed and logged in with Azure AD admin rights
#     (Application Administrator + Contributor on the subscription)
#   - jq installed
#   - Your GitHub repository owner/name (e.g. "my-org/centralino")
#
# Usage:
#   ./scripts/setup-oidc.sh <github-repo> [--app-name <name>] [--dry-run]
#
# Examples:
#   ./scripts/setup-oidc.sh my-org/centralino
#   ./scripts/setup-oidc.sh my-org/centralino --app-name "Guest Portal GitHub Actions"
#   ./scripts/setup-oidc.sh my-org/centralino --dry-run
#
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ── Colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Parse arguments ──────────────────────────────────────────────────────────
DRY_RUN=false
APP_NAME="Guest Portal GitHub Actions OIDC"
GITHUB_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -n) DRY_RUN=true; shift ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --app-name=*) APP_NAME="${1#*=}"; shift ;;
    -*)
      err "Unknown option: $1"
      echo "Usage: $0 <github-repo> [--app-name <name>] [--dry-run]"
      exit 1
      ;;
    *)  GITHUB_REPO="$1"; shift ;;
  esac
done

if [[ -z "$GITHUB_REPO" ]]; then
  err "Missing GitHub repository argument."
  echo "Usage: $0 <github-repo> [--app-name <name>] [--dry-run]"
  echo ""
  echo "Examples:"
  echo "  $0 my-org/centralino"
  echo "  $0 my-org/centralino --app-name \"CGD GitHub Actions\""
  exit 1
fi

if [[ "$DRY_RUN" == true ]]; then
  warn "DRY RUN — commands will be printed but NOT executed."
  echo ""
fi

# ── Dry-run helper ──────────────────────────────────────────────────────────
run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}$*${NC}"
  else
    "$@"
  fi
}

# ── Prerequisites check ──────────────────────────────────────────────────────
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
  if ! az account show &>/dev/null; then
    err "Not logged into Azure. Run: az login"
    exit 1
  fi

  # Verify the user has permissions to create App Registrations
  local user_type
  user_type=$(az ad signed-in-user show --query "userPrincipalName" -o tsv 2>/dev/null || echo "")
  if [[ -z "$user_type" ]]; then
    warn "Could not determine current user. You may lack Azure AD read permissions."
  fi

  SUBSCRIPTION_ID=$(az account show --query id -o tsv)
  TENANT_ID=$(az account show --query tenantId -o tsv)
  TENANT_NAME=$(az account show --query tenantDisplayName -o tsv 2>/dev/null || echo "N/A")

  info "Subscription: ${SUBSCRIPTION_ID}"
  info "Tenant:       ${TENANT_ID} (${TENANT_NAME})"
  info "GitHub repo:  ${GITHUB_REPO}"
  ok "Prerequisites satisfied."
}

# ── Create or get existing App Registration ──────────────────────────────────
setup_app_registration() {
  local display_name="$1"
  local app_id app_object_id

  info "Looking for existing app registration '${display_name}'..."

  local existing
  existing=$(az ad app list --filter "displayName eq '${display_name}'" --query "[0]" -o json 2>/dev/null || echo "null")

  if [[ "$existing" != "null" ]] && [[ -n "$existing" ]]; then
    app_id=$(echo "$existing" | jq -r '.appId')
    app_object_id=$(echo "$existing" | jq -r '.id')
    ok "App registration '${display_name}' already exists."
    info "  App ID:        ${app_id}"
    info "  Object ID:     ${app_object_id}"
  else
    info "Creating app registration '${display_name}'..."
    local result
    result=$(run az ad app create \
      --display-name "$display_name" \
      --sign-in-audience AzureADMyOrg \
      --description "OIDC federated credential for GitHub Actions — ${GITHUB_REPO}" \
      --query "{appId:appId, id:id}" \
      -o json 2>/dev/null)

    if [[ "$DRY_RUN" == false ]]; then
      app_id=$(echo "$result" | jq -r '.appId')
      app_object_id=$(echo "$result" | jq -r '.id')
      ok "App registration created."
      info "  App ID:        ${app_id}"
      info "  Object ID:     ${app_object_id}"
    else
      # In dry-run, use placeholders
      app_id="<app-id>"
      app_object_id="<object-id>"
    fi
  fi

  # Create service principal if not exists
  local sp_exists
  sp_exists=$(az ad sp list --filter "appId eq '${app_id}'" --query "[0].id" -o tsv 2>/dev/null || echo "")
  if [[ -z "$sp_exists" ]]; then
    info "Creating service principal for app registration..."
    run az ad sp create --id "$app_id" --output none 2>/dev/null || true
    if [[ "$DRY_RUN" == false ]]; then
      ok "Service principal created."
    fi
  else
    ok "Service principal already exists (ID: ${sp_exists})."
  fi

  APP_ID="$app_id"
  APP_OBJECT_ID="$app_object_id"
}

# ── Create federated identity credentials ────────────────────────────────────
# Each federated credential allows a specific GitHub branch/environment
# to authenticate as the Azure AD application.
setup_federated_credentials() {
  local object_id="$1"
  local repo="$2"
  local credentials_created=0

  # Subjects to create (in order of specificity):
  #   ref:refs/heads/main      → push to main (prod deployments)
  #   ref:refs/heads/staging   → push to staging (stg deployments)
  #   environment:dev          → workflow_dispatch targeting dev
  #   environment:stg          → workflow_dispatch targeting stg
  #   environment:prod         → workflow_dispatch targeting prod
  local subjects=(
    "repo:${repo}:ref:refs/heads/main"
    "repo:${repo}:ref:refs/heads/staging"
  )

  # Add environment-based subjects (for workflow_dispatch with environments)
  for env in dev stg prod; do
    subjects+=("repo:${repo}:environment:${env}")
  done

  info "Configuring federated identity credentials..."

  for subject in "${subjects[@]}"; do
    local cred_name
    # Generate a readable credential name from the subject
    cred_name=$(echo "$subject" | sed 's/[^a-zA-Z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | head -c 80)

    # Check if credential already exists
    local existing_cred
    existing_cred=$(az ad app federated-credential list \
      --id "$object_id" \
      --query "[?subject=='${subject}'].name" \
      -o tsv 2>/dev/null || echo "")

    if [[ -n "$existing_cred" ]]; then
      ok "Federated credential already exists: ${subject}"
      info "  Credential name: ${existing_cred}"
    else
      info "Creating federated credential: ${subject}..."

      local cred_json
      cred_json=$(cat <<EOF
{
  "name": "${cred_name}",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "${subject}",
  "description": "GitHub Actions OIDC: ${GITHUB_REPO} — ${subject}",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
)

      run az ad app federated-credential create \
        --id "$object_id" \
        --parameters "$cred_json" \
        --output none

      if [[ "$DRY_RUN" == false ]]; then
        ok "Federated credential created: ${subject}"
      else
        info "  (would create credential for: ${subject})"
      fi
      ((credentials_created++))
    fi
  done

  if [[ "$credentials_created" -eq 0 ]] && [[ "$DRY_RUN" == false ]]; then
    info "All federated credentials already exist — no changes needed."
  fi
}

# ── Assign RBAC role on Key Vault (so the SP can read secrets) ──────────────
assign_key_vault_role() {
  local app_id="$1"
  local env_suffix="${2:-dev}"

  local kv_name="kv-guestportal-${env_suffix}"

  # Check if Key Vault exists
  if az keyvault show --name "$kv_name" &>/dev/null 2>&1; then
    info "Assigning 'Key Vault Secrets User' role to app registration on '${kv_name}'..."

    local sp_id
    sp_id=$(az ad sp list --filter "appId eq '${app_id}'" --query "[0].id" -o tsv 2>/dev/null || echo "")

    if [[ -n "$sp_id" ]]; then
      local kv_scope
      kv_scope=$(az keyvault show --name "$kv_name" --query id -o tsv 2>/dev/null || echo "")

      if [[ -n "$kv_scope" ]]; then
        # Check if role assignment exists
        local role_exists
        role_exists=$(az role assignment list \
          --assignee "$sp_id" \
          --scope "$kv_scope" \
          --role "Key Vault Secrets User" \
          --query "[].id" \
          -o tsv 2>/dev/null | head -1 || echo "")

        if [[ -z "$role_exists" ]]; then
          run az role assignment create \
            --assignee "$sp_id" \
            --role "Key Vault Secrets User" \
            --scope "$kv_scope" \
            --output none
          if [[ "$DRY_RUN" == false ]]; then
            ok "Assigned 'Key Vault Secrets User' role on '${kv_name}'."
          fi
        else
          ok "Role 'Key Vault Secrets User' already assigned on '${kv_name}'."
        fi
      else
        warn "Could not determine Key Vault scope for '${kv_name}'."
      fi
    else
      warn "Service principal not found for app ID '${app_id}'."
    fi
  else
    info "Key Vault '${kv_name}' does not exist yet — skipping RBAC assignment."
    info "  (Run './scripts/provision.sh ${env}' first, then re-run this script)"
  fi
}

# ── Output secrets ───────────────────────────────────────────────────────────
print_output() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  OIDC Setup Complete — GitHub Secrets Configuration          ${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${YELLOW}Configure these as GitHub Actions repository secrets:${NC}"
  echo "  GitHub → Settings → Secrets and variables → Actions → New repository secret"
  echo ""
  echo "  ┌────────────────────────────────────────────────────────────────────┐"
  echo "  │ ${CYAN}AZURE_CLIENT_ID${NC}         = ${APP_ID}  │"
  echo "  │ ${CYAN}AZURE_TENANT_ID${NC}         = ${TENANT_ID} │"
  echo "  │ ${CYAN}AZURE_SUBSCRIPTION_ID${NC}   = ${SUBSCRIPTION_ID} │"
  echo "  └────────────────────────────────────────────────────────────────────┘"
  echo ""
  echo -e "${YELLOW}Federated credentials configured:${NC}"
  echo "  repo:${GITHUB_REPO}:ref:refs/heads/main     → push to main (prod)"
  echo "  repo:${GITHUB_REPO}:ref:refs/heads/staging  → push to staging (stg)"
  echo "  repo:${GITHUB_REPO}:environment:dev          → workflow_dispatch dev"
  echo "  repo:${GITHUB_REPO}:environment:stg          → workflow_dispatch stg"
  echo "  repo:${GITHUB_REPO}:environment:prod          → workflow_dispatch prod"
  echo ""
  echo -e "${YELLOW}Federated credential details (Azure Portal):${NC}"
  echo "  Entra ID → App registrations → ${APP_NAME} → Certificates & secrets"
  echo "  → Federated credentials"
  echo ""
  echo -e "${YELLOW}App Registration details:${NC}"
  echo "  Name:           ${APP_NAME}"
  echo "  App (client) ID: ${APP_ID}"
  echo "  Object ID:      ${APP_OBJECT_ID}"
  echo ""

  if [[ "$DRY_RUN" == true ]]; then
    warn "DRY RUN — no resources were created."
    echo "  Re-run without --dry-run to execute."
    echo ""
  fi

  echo -e "${YELLOW}Next steps:${NC}"
  echo "  1. Add the three AZURE_* secrets to GitHub repository secrets"
  echo "  2. Run './scripts/provision.sh dev' (if not already done)"
  echo "  3. Re-run this script after provisioning to assign KV RBAC:"
  echo "     ./scripts/setup-oidc.sh ${GITHUB_REPO}"
  echo "  4. Trigger a test workflow: GitHub → Actions → provision-infra.yml"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Guest Portal — Azure OIDC Federated Credential Setup        ${NC}"
  echo -e "${CYAN}  GitHub repo: ${GITHUB_REPO}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""

  check_prerequisites

  setup_app_registration "$APP_NAME"

  setup_federated_credentials "$APP_OBJECT_ID" "$GITHUB_REPO"

  # Try assigning KV role for all three environments
  for env_suffix in dev stg prod; do
    assign_key_vault_role "$APP_ID" "$env_suffix"
  done

  print_output
}

main "$@"
