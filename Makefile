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
#   make compose-up     # Start full stack with Docker Compose
#   make compose-build  # Rebuild and start Docker images
# =============================================================================

.PHONY: help install dev build typecheck test test-backend test-frontend
.PHONY: compose-up compose-build compose-down compose-logs compose-ps compose-clean compose-restart
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

# ── Docker Compose (full-stack containers) ─────────────────────────────────

compose-up: ## Start full stack with Docker Compose (detached)
	docker compose up -d
	@echo 'Frontend: http://localhost:8080'
	@echo 'Backend:  http://localhost:3000'

compose-build: ## Rebuild images and start Docker Compose
	docker compose up --build -d
	@echo 'Frontend: http://localhost:8080'
	@echo 'Backend:  http://localhost:3000'

compose-down: ## Stop and remove containers (preserves data volume)
	docker compose down

compose-clean: ## Stop and remove everything (including PostgreSQL data)
	docker compose down -v

compose-logs: ## Tail logs from all services
	docker compose logs -f

compose-ps: ## Show container status
	docker compose ps

compose-restart: ## Rebuild and restart a specific service (usage: make compose-restart SVC=frontend)
	docker compose up -d --build $(SVC)

# ── Docker image scanning ──────────────────────────────────────────────────

docker-scan: ## Build images locally and run Trivy vulnerability scan (requires Trivy CLI)
	@echo '==> Building backend image...'
	docker build -t cgd-backend:ci-scan -f Dockerfile .
	@echo '==> Building frontend image...'
	docker build -t cgd-frontend:ci-scan -f Dockerfile.frontend .
	@echo ''
	@echo '==> Scanning backend image...'
	trivy image --severity CRITICAL,HIGH cgd-backend:ci-scan
	@echo ''
	@echo '==> Scanning frontend image...'
	trivy image --severity CRITICAL,HIGH cgd-frontend:ci-scan
