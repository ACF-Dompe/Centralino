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
| `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` | — | Default `true`. **Keep it true against Entra ID** — see below |
| `BREAKGLASS_ENABLED` | — | Default `false`. Emergency local login (see below) |
| `BREAKGLASS_IP_ALLOWLIST` | — | CIDRs allowed to reach the break-glass endpoint |

Secrets should be stored as **Azure Key Vault references** in ACA environment variables.
The full list, including the remaining `BREAKGLASS_*` thresholds, is documented in `.env.example`.

### Why `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` must stay true

`@node-saml/node-saml` injects, by default, a `RequestedAuthnContext` of
`urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` with
`Comparison="exact"` into every AuthnRequest. Entra ID honours that constraint,
so a user who signed in with certificate-based authentication, Windows Hello or
FIDO2 cannot satisfy it and the login fails with:

```
AADSTS75011: Authentication method 'X509, MultiFactor, X509Device' by which the
user authenticated with the service doesn't match requested authentication
method 'Password, ProtectedTransport'.
```

Which authentication methods are acceptable is decided by Conditional Access and
Authentication Strength policies in Entra — not by this service provider. The
strategy therefore omits the element (`backend/src/auth/saml.ts`).

## Break-glass access

A local username/password login for when Entra ID / SAML SSO is unavailable.

> ⚠️ It bypasses Entra Conditional Access and MFA and, by explicit decision,
> carries **no second factor**. This is a documented, accepted deviation —
> see `COMPLIANCE.md`. It is disabled by default.

Compensating controls, all implemented rather than aspirational:

- `BREAKGLASS_ENABLED` defaults to `false`; the endpoint returns `404` until enabled
- optional CIDR allowlist (`BREAKGLASS_IP_ALLOWLIST`), evaluated before anything
  else and fail-closed on a malformed list; callers outside it get `404` and never
  see the link in the UI
- scrypt password hashes (`auth/password.ts`, Node's own `node:crypto` — no new
  dependency); plaintext is never stored, logged or returned
- per-account lockout persisted in `breakglass_users`, so it holds across every
  ACA replica; only a wrong password advances it, so guessing cannot extend a lock
  indefinitely against the legitimate operator
- per-source-IP sliding-window throttle (in memory, therefore per replica)
- constant-cost password check and one single generic error for every failure
  reason, so neither timing nor wording can be used to enumerate accounts
- session regeneration on success plus a shortened cookie lifetime
- every attempt, allowed or denied, logged at `warn` level for alerting

It depends on PostgreSQL, so it covers an **Entra/SSO outage — not a database
outage**, which would already have taken sessions down with it.

### Managing accounts

Accounts exist only through the CLI; there is deliberately no HTTP endpoint for
creating or editing them, since an authenticated management API would let anyone
who compromised a normal session mint a permanent SSO bypass.

```bash
# Locally, from the repository root (tsx, no build needed)
make breakglass ARGS="list"
make breakglass ARGS='set bg.operator --display "Break Glass" --expires 2027-12-31'

# In production, inside the backend container (inherits the UAMI Entra token).
# WORKDIR is /app and the build lands in /app/backend/dist, so the path matches
# the container's own CMD (`node backend/dist/index.js`).
node backend/dist/scripts/breakglass.js list
node backend/dist/scripts/breakglass.js unlock bg.operator
node backend/dist/scripts/breakglass.js disable bg.operator
```

`set` prints a generated password once — file it in the password manager
immediately, it is not recoverable. Pass `--stdin-password` to supply your own
instead. The password is never accepted as a command-line argument: argv is
visible in shell history and in the container's process list.

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
