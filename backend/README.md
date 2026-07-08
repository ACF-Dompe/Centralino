# Backend — Cisco Guest Desk API

Express + TypeScript API for the Cisco Catalyst 9800 Guest Management Desk.

## Architecture

```
src/
├── auth/           # SAML 2.0 SSO via passport-saml + express-session
├── db/             # Database migrations, seed, PostgreSQL driver (pg)
├── middleware/     # Express middleware (ensureAuthenticated guard)
├── repositories/  # DB row → domain model mapping (WLC, guests, configs, sedi, logs)
├── routes/        # REST endpoints (health, auth, wlc, guests, configs, logs, sedi)
├── services/      # Business logic (WLC WebUI login, SSH commands, email, timers)
├── types/         # Additional type declarations (connect-pg-simple)
├── utils/         # Credential generation, time formatting
├── __tests__/     # Unit tests (vitest)
├── config.ts      # Centralised env-var configuration
├── index.ts       # Server entry point
├── logger.ts      # Pino-based structured logging
└── types.ts       # Domain types (Guest, WlcConfig, EmailConfig, etc.)
```

## Key Design Decisions

- **Stateless**: No local filesystem state. All data in PostgreSQL.
- **SSO SAML 2.0**: Authentication via Microsoft Entra ID. Falls back to WLC-only when unconfigured.
- **Entra ID for DB**: Zero-password DB auth via `DefaultAzureCredential` when `DATABASE_URL` has no password.
- **One-time passwords**: Guest passwords are generated in RAM, never persisted. Returned once in API response.

## Configuration

See `.env.example` at the project root. All configuration is via environment variables:

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | Session signing secret |
| `SAML_ENTRY_POINT` | per env | Empty = SSO disabled |
| `SAML_ISSUER` | per env | App Entity ID in Azure AD |
| `SAML_CALLBACK_URL` | per env | ACS URL |
| `SAML_CERT` | per env | Azure AD public cert (PEM) |

Secrets should be stored as **Azure Key Vault references** in ACA environment variables.

## Development

```bash
# Prerequisites: PostgreSQL running locally
cp ../.env.example ../.env  # adjust DATABASE_URL
npm install
npm run dev                  # tsx watch (hot reload)
```

## Testing

```bash
npm test                     # vitest (unit tests, no infrastructure needed)
npm run test:watch           # vitest in watch mode
```

The backend uses [vitest](https://vitest.dev/) for unit tests. All external dependencies
(DB, WLC, SMTP) are mocked — tests run offline with zero infrastructure.

## API Surface

See `src/routes/index.ts` for all endpoints:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | ❌ | Liveness probe |
| POST | `/api/wlc/login` | ✅ | WLC WebUI auth |
| GET | `/api/guests` | ✅ | List guests |
| POST | `/api/guests` | ✅ | Create guest |
| ... | (see full list in root README.md) | | |
