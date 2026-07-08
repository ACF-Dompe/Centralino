# Frontend — Cisco Guest Desk UI

React 18 + Vite + TypeScript + Tailwind CSS operator console.

## Architecture

```
src/
├── api/            # API client (fetch-based, typed endpoints)
├── components/     # UI components (Login, Dashboard, GuestTable, ConfigPanel…)
├── i18n/           # Italian / English translations
├── utils/          # Time formatting helpers
├── App.tsx         # Auth state machine (loading → SSO → WLC login → Dashboard)
├── main.tsx        # Entry point
└── types.ts        # Shared TypeScript types
```

## Auth Flow

The frontend implements a 4-phase auth state machine:

```
     loading
        │
        ▼
  ┌─ sso-required ──→ sso-authenticated ──→ wlc-login ──→ dashboard
  │                                               │
  └── sso-unavailable ────────────────────────────┘
```

## State Machine

| Phase | Trigger | UI |
|-------|---------|----|
| `loading` | App mount | Spinner |
| `sso-required` | `/api/auth/me` → 401 | SSO login screen (Accedi con SSO) |
| `sso-authenticated` | `/api/auth/me` → 200 (SAML user) | SSO user tag + WLC login |
| `sso-unavailable` | `/api/auth/me` → 404 | WLC login (no SSO) |
| `wlc-login` | Sede selected | WLC credentials form |
| `dashboard` | WLC authenticated | Guest table, stats, config |

## Development

```bash
cd frontend
npm install
npm run dev         # Vite dev server on :5173 (proxies /api → :3000)
```

## Testing

E2E tests use [Playwright](https://playwright.dev/):

```bash
npm run test:e2e              # headless (requires built app + backend)
npm run test:e2e:ui           # interactive UI mode
```

Two test suites are available:

| Suite | File | Description | CI |
|-------|------|-------------|----|
| SSO | `e2e/sso.spec.ts` | 17 tests — SSO login screen, Dashboard actions | `e2e-sso.yml` (frontend-only) |
| Calendar | `e2e/calendar.spec.ts` | Guest modal / registration | `e2e-postgres.yml` (full stack) |

See `playwright.config.ts` for configuration details.

## Key Components

| Component | Path | Purpose |
|-----------|------|---------|
| `SsoLogin` | `components/SsoLogin.tsx` | SSO login button / corporate branding |
| `Login` | `components/Login.tsx` | WLC credentials form (host, port, username, password) |
| `Dashboard` | `components/Dashboard.tsx` | Main console — guest table, stats, toolbar |
| `GuestTable` | `components/GuestTable.tsx` | Guest list with actions (activate, delete, resend, badge) |
| `ConfigPanel` | `components/ConfigPanel.tsx` | SMTP / WLC / SMS configuration modal |
| `BadgeModal` | `components/BadgeModal.tsx` | Send credentials email to guest |
| `LockOverlay` | `components/Dashboard.tsx` | PIN lock screen (client-side) |
