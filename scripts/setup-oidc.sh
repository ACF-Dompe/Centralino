#!/usr/bin/env bash
# =============================================================================
# Guest Portal — Pipeline OIDC Identity (DOCUMENTATION / READ-ONLY PREFLIGHT)
# =============================================================================
# CONSUME-ONLY MODEL: the pipeline's OIDC identity (App Registration + service
# principal + federated credentials) and its Key Vault RBAC are created by the
# INFRASTRUCTURE TEAM, NOT by the app. This script therefore does NOT create or
# modify anything. It only:
#   1. Prints the exact specification the infra team must apply.
#   2. Optionally (--verify) checks, read-only, that the expected federated
#      credentials already exist (`az ad app ... list`, no create).
#
# Prerequisites:
#   - Azure CLI (az) logged in with read access to Entra ID (for --verify)
#   - Your GitHub repository owner/name (e.g. "my-org/centralino")
#
# Usage:
#   ./scripts/setup-oidc.sh <github-repo> [--app-name <name>] [--verify]
#
# Examples:
#   ./scripts/setup-oidc.sh my-org/centralino
#   ./scripts/setup-oidc.sh my-org/centralino --verify
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
VERIFY=false
APP_NAME="Guest Portal GitHub Actions OIDC"
GITHUB_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) VERIFY=true; shift ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --app-name=*) APP_NAME="${1#*=}"; shift ;;
    -*)
      err "Unknown option: $1"
      echo "Usage: $0 <github-repo> [--app-name <name>] [--verify]"
      exit 1
      ;;
    *)  GITHUB_REPO="$1"; shift ;;
  esac
done

if [[ -z "$GITHUB_REPO" ]]; then
  err "Missing GitHub repository argument."
  echo "Usage: $0 <github-repo> [--app-name <name>] [--verify]"
  exit 1
fi

# Federated credential subjects the infra team must configure.
SUBJECTS=(
  "repo:${GITHUB_REPO}:ref:refs/heads/main"
  "repo:${GITHUB_REPO}:ref:refs/heads/staging"
  "repo:${GITHUB_REPO}:environment:dev"
  "repo:${GITHUB_REPO}:environment:stg"
  "repo:${GITHUB_REPO}:environment:prod"
)

# ── Print the specification for the infrastructure team ──────────────────────
print_spec() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Pipeline OIDC identity — spec for the INFRASTRUCTURE TEAM     ${NC}"
  echo -e "${CYAN}  (created by infra, NOT by this repo)                          ${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${YELLOW}1) App Registration (single-tenant) + service principal${NC}"
  echo "   Display name (suggested): ${APP_NAME}"
  echo "   Sign-in audience:         AzureADMyOrg (single tenant)"
  echo "   Purpose:                  GitHub Actions OIDC for ${GITHUB_REPO}"
  echo ""
  echo -e "${YELLOW}2) Federated credentials${NC}"
  echo "   Issuer:    https://token.actions.githubusercontent.com"
  echo "   Audience:  api://AzureADTokenExchange"
  echo "   Subjects:"
  for s in "${SUBJECTS[@]}"; do
    echo "     - ${s}"
  done
  echo ""
  echo -e "${YELLOW}3) GitHub repository secrets to configure${NC}"
  echo "   (values returned by the infra team after creating the identity)"
  echo "     AZURE_CLIENT_ID        = <App Registration application (client) ID>"
  echo "     AZURE_TENANT_ID        = <Entra ID tenant ID>"
  echo "     AZURE_SUBSCRIPTION_ID  = <Azure subscription ID>"
  echo ""
  echo -e "${YELLOW}4) Key Vault RBAC (also infra)${NC}"
  echo "   Grant 'Key Vault Secrets User' on the platform Key Vault to the"
  echo "   pipeline identity and to the backend UAMI. Not done by this repo."
  echo ""
  echo "   Run with --verify to check (read-only) that the federated"
  echo "   credentials already exist in Entra ID."
  echo ""
}

# ── Read-only verification (no create) ───────────────────────────────────────
verify_credentials() {
  info "Verifying prerequisites (read-only)..."
  if ! command -v az &>/dev/null; then
    err "Azure CLI not found. Install from https://aka.ms/install-azure-cli"
    exit 1
  fi
  if ! az account show &>/dev/null; then
    err "Not logged into Azure. Run: az login"
    exit 1
  fi

  info "Looking up App Registration '${APP_NAME}' (read-only)..."
  local object_id
  object_id=$(az ad app list --filter "displayName eq '${APP_NAME}'" --query "[0].id" -o tsv 2>/dev/null || echo "")
  if [[ -z "$object_id" ]]; then
    warn "App Registration '${APP_NAME}' not found — ask the infra team to create it."
    return 1
  fi
  ok "App Registration found (object id: ${object_id})."

  local missing=0
  for subject in "${SUBJECTS[@]}"; do
    local found
    found=$(az ad app federated-credential list --id "$object_id" \
      --query "[?subject=='${subject}'].name" -o tsv 2>/dev/null || echo "")
    if [[ -n "$found" ]]; then
      ok "Federated credential present: ${subject}"
    else
      warn "MISSING federated credential: ${subject}"
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    err "One or more federated credentials are missing — ask the infra team to add them."
    return 1
  fi
  ok "All expected federated credentials are present."
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Guest Portal — Pipeline OIDC identity (consume-only)         ${NC}"
  echo -e "${CYAN}  GitHub repo: ${GITHUB_REPO}${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"

  print_spec

  if [[ "$VERIFY" == true ]]; then
    verify_credentials || exit 1
  else
    info "Documentation mode. Re-run with --verify to check existing credentials."
  fi
}

main "$@"
