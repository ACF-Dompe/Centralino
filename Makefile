# =============================================================================
# Cisco Guest Desk — Makefile
# =============================================================================
# Convenience shortcuts for common development commands.
#
# Usage:
#   make help           # List all available targets
#   make install        # npm install (all workspaces)
#   make dev            # Start local dev (backend + frontend) without Docker
#   make test           # Run all unit tests (backend + frontend)
#   make docker-scan    # Build images locally and run a Trivy scan
#
# NOTE: Per platform guidelines (§11) this repo ships NO docker-compose stack
# or local runtime emulators. Development happens on the Development
# environment via the deploy pipeline; local dev uses `make dev`.
# =============================================================================

.PHONY: help install dev build typecheck test test-backend test-frontend
.PHONY: docker-scan lint

# ── Help ─────────────────────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Local development (without Docker) ──────────────────────────────────────

install: ## Install all dependencies (all workspaces)
	npm install --no-audit --no-fund

dev: ## Start local dev servers (backend :3000 + frontend :5173)
	npm run dev

build: ## Build backend + frontend (TypeScript + Vite)
	npm run build

typecheck: typecheck-backend typecheck-frontend ## Run TypeScript type checking on both workspaces

typecheck-backend: ## TypeCheck backend
	npx -w backend tsc --noEmit

typecheck-frontend: ## TypeCheck frontend
	npx -w frontend tsc --noEmit

test: test-backend test-frontend ## Run all unit tests

test-backend: ## Run backend unit tests (Vitest)
	npm run test -w backend

test-frontend: ## Run frontend unit tests (Vitest)
	npm run test -w frontend

lint: ## Run ESLint (if configured)
	@echo 'No linter configured — run typecheck instead'
	$(MAKE) typecheck

# ── Docker image scanning ──────────────────────────────────────────────────

docker-scan: ## Build images locally and run Trivy vulnerability scan (requires Trivy CLI)
	@echo '==> Building backend image...'
	docker build -t guestportal-backend:ci-scan -f Dockerfile .
	@echo '==> Building frontend image...'
	docker build -t guestportal-frontend:ci-scan -f Dockerfile.frontend .
	@echo ''
	@echo '==> Scanning backend image...'
	trivy image --severity CRITICAL,HIGH guestportal-backend:ci-scan
	@echo ''
	@echo '==> Scanning frontend image...'
	trivy image --severity CRITICAL,HIGH guestportal-frontend:ci-scan
