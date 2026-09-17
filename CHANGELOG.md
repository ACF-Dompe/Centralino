# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

#### One operator's "Disconnetti" could stop provisioning at another site
- `updateWlcConfig()` wrote `WHERE id = (SELECT id FROM wlc_config ORDER BY id ASC LIMIT 1)` — **always the first row**, whatever site the operator was working on. That would be cosmetic if `authenticated` were only a UI flag, but it is not: `timer.ts` skipped the periodic sync for a site when it was false, and the guest routes skipped the SSH push and logged `(offline)`. So an operator pressing "Disconnetti" at L'Aquila switched off synchronisation **and** provisioning for Milan, where a different operator carried on creating guests that never reached the controller, with no error anywhere.
- The flag is gone, split into the three separate things it was conflating: `sedi.active` ("this site is in service", written by an admin), `sedi.wlc_last_check_*` ("the last probe succeeded", written only by a probe, as diagnostics) and `req.session.sedeId` / `wlcConnected` ("this operator is connected here"). **No server-side decision is taken on a boolean the UI can write any more.** `getWlcConfig()` and `updateWlcConfig()` were removed outright rather than fixed — a site-less lookup is what made the bug possible — and `WlcConfig.sedeId` became non-nullable so the compiler located every caller.

#### Any authenticated user could read another site's guests
- `GET /api/guests?sedeId=` let the client name the site and the server obeyed. The site now comes from the session; a mismatched query parameter is answered with 403 rather than silently honoured, so the bug that produced it shows up instead of hiding.

#### Guest events leaked across sites over the WebSocket
- `broadcast()` sent every event to every connected client, so an operator in one city saw guest names appear from another. Each connection now carries the site it may hear about, and the upgrade re-checks authorization — a valid session cookie was previously enough to keep a socket open after the account had been suspended.

#### The register form could create a guest account lasting for ever
- The free-form minutes box bypassed the one-week cap, which was only applied to the custom end-date branch, and `validateDurationMinutes` was imported by the guest route and never called. The box is gone (presets and an end date cover every case) and the endpoint validates the value it is handed.

### Added

#### Application user directory with roles and per-site grants
- The app had no concept of an application user: anyone who completed SSO could do everything, at every site. A directory entry is now created at the first successful sign-in and starts **blocked** — the tenant can authenticate, but nothing is granted until an administrator profiles it (role `admin` / `operator` / `viewer`, plus the sites the user may connect to).
- Authorization is resolved **per request** by `middleware/authorize.ts` and deliberately never stored in the session, which lasts a day: a suspended account has to lose access in seconds. A 15-second per-replica cache bounds the staleness, chosen to sit below the dashboard's 30-second poll so a suspended user is locked out at their next automatic refresh without clicking anything. Every failure path is closed — an unknown user is 403 `user_not_provisioned`, a failed lookup is 503, never a default profile.
- Signing in cannot change a role or a status: the provisioning statement leaves both out of its `ON CONFLICT DO UPDATE`, so a login can never undo an administrator's decision. It is a single statement, so concurrent logins cannot race.
- `RBAC_ENFORCEMENT=log-only` records what would have been refused and lets it through, for watching the first rollout. The code ships enforcing.
- **Administrators by convention**: an address of the form `admin365-<anything>@dompe.onmicrosoft.com` is a platform administrator without anybody profiling it, so an administrator can reach a fresh deployment without going through the break-glass account. The role is written into the directory on every login *and* enforced at every authorization lookup, so an accidental demotion — or a row edited straight in the database — cannot lock such an account out; the panel shows the row with its role and status locked. Both halves of the rule are required: the domain is what keeps an Entra guest (B2B) account from qualifying, since a guest's UPN belongs to their own tenant and `admin365-x@attacker.com` would otherwise arrive as an administrator here. An empty `RBAC_AUTO_ADMIN_DOMAINS` disables the rule rather than widening it.
- New `make appusers` CLI, runnable with `az containerapp exec`. It exists for the bootstrap: every SSO user starts blocked, so without a way in from outside the web surface a fresh deployment would have nobody able to unblock anybody. Safer than the alternative, which is exposing the break-glass login to a network.

#### Administration panel
- Users, sites and emergency accounts, behind `requireRole('admin')`. It replaces the "Configura Canali" dialog, which edited the same controller fields through the path that carried the bug above, and whose "Test Connessione" was not a test — it called the login endpoint and then wrote `authenticated: true`, changing which controller the application considered live as a side effect of a diagnostic.
- Guards that keep the application administrable: an admin cannot change their own role or status, the last active admin cannot be demoted or suspended, and the last usable break-glass account cannot be disabled.

#### Break-glass: bootstrap account, and a read-mostly admin surface
- The migration creates `bk.guestportal` (role `admin`) when `BREAKGLASS_SEED_PASSWORD` is set and at least 16 characters, and **only if it is missing** — it does not rotate a password somebody has already changed, nor re-enable an account somebody turned off. With no password configured it creates nothing and says so: a built-in default would be a backdoor published in the repository, and a generated one would be a credential nobody knows.
- `/api/admin/breakglass` exposes read, enable, disable and unlock. **Creating an account and rotating a password stay in the CLI**, so a compromised admin session cannot mint a permanent SSO bypass. Documented against COMPLIANCE.md D1, whose compensating-controls table and known limits were updated in the same change.

### Changed

#### WLC parameters moved off the login screen and into the database
- The screen after sign-in asked every operator to retype the controller's address, ports, admin account and SSID at each session, and sent them back to be saved. They live on the site record now: choosing a site *is* connecting to it, and `POST /api/wlc/login` accepts only a site id. Host, port and username are no longer accepted from the client at all — which also closes an SSH command-injection surface, since that username flowed into the guest CRUD commands.
- `wlc_config` was folded into `sedi`. The two tables were 1:1 but linked from both sides, and the links could disagree — hence the defensive `OR` in every read and a uniqueness index created in a `try/catch` with the comment "best-effort". The backfill is guarded so the migration, which replays on every start, cannot overwrite what an administrator has just changed. The old table is still written and will be dropped in a later release.
- Sites can be created from the panel, but **a new site still needs its Key Vault secret**, which means a platform-team request and a new ACA revision. The panel names both identifiers and keeps the site out of service until a connection test succeeds.
- The seed no longer updates existing sites. It rewrote name, city and address on every start, which was harmless while those values only existed in source and would now silently revert an administrator's edit.

#### Smaller UI corrections
- The header showed the mail address twice, because Entra releases the UPN as the `name` claim for this tenant and the tag printed it beside the address. The display name is now composed from the given name and surname, and only the name is shown, with the address in the tooltip.
- "Disconnetti" became **"Cambia sede"** — it keeps the session and returns to the site selector — and "Logout SSO" became **"Logout"**. They also had the same icon, which was half the confusion.
- The "Conclusi" summary card summed two different outcomes; "Scaduto" and "Revocato" are now separate cards.
- Re-sending credentials is a single action again. Two buttons called the same endpoint, and one of them went through a preview that showed a subject line different from the one actually sent and printed `Password: null`, because the guest password is never persisted. The preview and its component are gone.
- The one-time password notice no longer explains where the password is not stored.


#### SSO — `AADSTS75011` on every passwordless sign-in
- **The AuthnRequest no longer constrains the authentication method.** `@node-saml/node-saml` 5.1.0 injects, by default, `RequestedAuthnContext = urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` with `Comparison="exact"` into every AuthnRequest. Entra ID honours that constraint, so any user who signed in with certificate-based authentication, Windows Hello or FIDO2 (`amr = X509, MultiFactor, X509Device`) was rejected with `AADSTS75011` instead of being let through. Which method is acceptable is a Conditional Access / Authentication Strength decision inside the tenant, not a service-provider one — and a SAML enterprise application has no supported switch to make Entra ignore a `RequestedAuthnContext` it receives, so the fix belongs here. `createSamlStrategy` now sets `disableRequestedAuthnContext: true` by default (`backend/src/auth/saml.ts`), overridable with `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` for an IdP that demands an explicit context. The value is also pinned in `deploy-azure.yml` so a manual override cannot survive a deploy. New tests assert the generated AuthnRequest XML, not just the option flag.

### Added

#### Seed CLI, so a production database can get its reference data
- The 5 sedi with their WLC hosts, SSIDs and addresses live in `db/seed.ts`, and there is no API to create a sede — so a database that never ran the seed leaves the app at *"Nessuna sede configurata"* right after sign-in, with no way forward. Production runs with `SEED_ENABLED=false`, and the deploy guide never covered populating it: a genuine gap in the procedure, found the first time an SSO login actually reached the app.
- `node backend/dist/db/seed.js` now runs it as a one-off, mirroring the migration CLI (same Entra token authentication, exit 0/1, idempotent — sedi are matched by `code`). This replaces toggling `SEED_ENABLED` on a running app, which needs two revisions and, if left on, makes every restart overwrite each sede name, city and address with the hardcoded values, silently undoing later edits. Documented as a mandatory step in the deploy guide §6.1, added to the go-live checklist and to §12 troubleshooting.
- The file header now states plainly that this is master data rather than demo data, since the name suggests otherwise.
- `createMigrationClient()` reports a missing `DATABASE_URL` explicitly instead of letting `new URL()` fail with "Invalid URL" — this is shared by the migration, seed and breakglass CLIs.

### Changed

#### WLC channel verification documented as a deliberate posture
- `WLC_TLS_REJECT_UNAUTHORIZED=false` is now the documented production setting, recorded as accepted deviation **D3** in `COMPLIANCE.md`: a Catalyst 9800 presents a self-signed certificate, which verification always rejects. The **code default stays secure** (true in production) — the deviation lives in the environment, not in the codebase.
- Deploy guide §7.1 now sets `WLC_SSH_VERIFY_HOST_KEY=false` and `WLC_TLS_REJECT_UNAUTHORIZED=false` explicitly, with a note stating the consequence: the channel to the controllers is unauthenticated and carries the WLC admin password and the guest credentials, acceptable only because the path is the restricted internal network. §12 gains a row for the self-signed certificate error.
- D2 and D3 are cross-referenced: both remove *server* authentication on the same network path, so the risk is cumulative on one channel rather than spread over two.
- Per-sede TLS pinning (`WLC_TLS_CA_<CODE>`) is tracked as the P1 that would close D3 while keeping verification on and without touching the controllers.
- Note: the deploy pipeline does **not** set `WLC_TLS_REJECT_UNAUTHORIZED`, so a value set by hand survives future pipeline deploys.

#### WLC connection failures no longer all claim the host is unreachable
- Every request error — network **and** TLS — was reported as `Host irraggiungibile: <message>`. When the Catalyst 9800 presented its self-signed certificate and `WLC_TLS_REJECT_UNAUTHORIZED=true` refused it, the operator was told the host was unreachable and went looking at egress, routing and the container network. The controller had answered fine; only verification had failed.
- `loginWebUi` now classifies the error and says what to do: a refused certificate names `WLC_TLS_REJECT_UNAUTHORIZED` and states explicitly that the controller responded; an expired certificate, a refused connection (port closed), an unresolvable hostname and a genuine timeout each get their own message. Only real unreachability is called unreachable. Classification prefers `err.code` and falls back to matching the message, since a wrapped socket error sometimes carries the token only in the text. The error `code` is now in the log line too.
- 6 tests in `wlcWebui.test.ts`, including the exact production case.

#### WLC SSH host key verification is now an explicit, off-by-default flag
- Requested by the operator, and recorded as accepted deviation **D2** in `COMPLIANCE.md`. Previously the SSH client refused to connect in production unless `WLC_SSH_HOST_KEY` was set (fail-closed). That could never work here: the five controllers have five different host keys while `WLC_SSH_HOST_KEY` is a single value compared against all of them, so verification would let at most one sede connect and fail the other four closed.
- `WLC_SSH_VERIFY_HOST_KEY` (default `false`) now gates it. With verification **on**, a missing expected key still fails closed — asking for verification and then connecting anyway would be worse than not asking.
- **The disabled state is not silent**: the backend logs a warning the first time it opens an unverified connection, once per process so the 30-second background sync cannot bury it. The SSH session is unauthenticated and carries the WLC admin password and the guest credentials, so that state belongs in the logs.
- Closing the deviation needs per-sede keys (`WLC_SSH_HOST_KEY_<CODE>`, mirroring `wlcPasswordForSede`) plus the five fingerprints; tracked as a P1 in the remediation backlog. Tests: `wlcSshHostKey.test.ts`.

#### Seed no longer plants a public SMS provider
- `sms_config` was seeded with `gateway_type = textbelt`. The DDL default had already been removed for compliance §3.4, but the seed still wrote it — and with the seed about to run in production for the first time, it would have landed there. It now inserts `NULL`; the SMS feature stays dormant.

### Fixed

#### `InResponseTo is not valid`: AuthnRequest IDs are now persisted
- node-saml records the ID of each AuthnRequest and checks the response `InResponseTo` against it — real replay protection. Its default store is process memory, and its own documentation states it "will NOT be sufficient" when request and response can be handled by different processes. On Container Apps that is the normal case: a restart between the sign-in redirect and the IdP posting back is enough, and more than one replica makes it routine. The user then gets `InResponseTo is not valid` with no way to recover. node-saml also consumes the ID from its error path, so every failed attempt spends one.
- **Fix:** a PostgreSQL-backed `CacheProvider` (`auth/samlRequestCache.ts`) over a new `saml_request_ids` table, so the check survives restarts and works across replicas. Expiry is enforced in SQL rather than by the prune, and the pool is created lazily so building a SAML strategy stays free of I/O. Replay protection is unchanged — it is now simply reliable. Tests: `samlRequestCache.test.ts`.

#### `Invalid document signature`: response-level signing is now configurable
- Entra ID signs the `<Assertion>` but **not** the enclosing `<samlp:Response>` unless the Enterprise Application Signing Option is changed from its default ("Sign SAML assertion"). The app requires both (`wantAuthnResponseSigned: true`, hardening §5.5), so every login was rejected with `Invalid document signature`. Confirmed by decoding the real assertion from a captured HAR: RSA-SHA256, valid certificate, signature present inside the Assertion only.
- **The preferred fix is on the IdP** — Signing Option = "Sign SAML response and assertion" — so the strict default stays. `SAML_WANT_AUTHN_RESPONSE_SIGNED` now exists for tenants where that setting cannot be changed, turning what would be a code change into a configuration one. Assertion signing stays unconditional, so the identity claims are protected either way.

#### `Unknown authentication strategy "saml"` when the SAML strategy cannot be built
- An unusable `SAML_CERT` makes `createSamlStrategy` return null, so passport never receives the strategy — but the SSO routes were mounted regardless and answered `Unknown authentication strategy "saml"`, which says nothing about the cause. This was a gap in the certificate-validation change: its own comment claimed the caller disabled SSO on a null strategy, and the caller did not.
- `createAuthRouter` now distinguishes three states instead of two: SAML usable, SAML configured but broken, SAML not configured. In the broken state `/login`, `/callback` and `/slo/callback` return a 501 that names the likely cause and points at the startup logs, while `/api/auth/me` returns **401 rather than 404** — a 404 means "SSO does not exist" to the frontend, which would skip the sign-in screen and with it the emergency-login link. The break-glass endpoints stay reachable throughout, which is the whole point of that path.
- `index.ts` logs an error (not info) when SAML is configured but the strategy is missing. Regression tests in `samlCallback.test.ts`.

#### Key Vault references were never resolved (SSO certificate, session secret, WLC passwords)
- **Env vars were set to the App Service syntax `@Microsoft.KeyVault(SecretUri=...)`, which Azure Container Apps does not expand** — the literal string reached the container (`az containerapp secret list` was empty). SSO failed with `idpCert is not in PEM format or in base64 format`, and, more seriously, `SESSION_SECRET` held the reference text: the cookie signing key was derivable from public information, so session cookies could be forged. `WLC_PASSWORD_*` and `MAIL_GRAPH_CLIENT_SECRET` were literal too.
- **`createSamlStrategy` now validates the certificate shape at startup** and refuses to build a strategy it knows cannot validate a response, naming the ACA/App Service mix-up explicitly when it sees an unresolved reference. It returns `null` instead of throwing, so the process stays up: the SSO routes answer 501 and the break-glass login — which exists for exactly this situation — keeps working. Previously the only symptom was a cryptic message in the browser after a full SSO round-trip.
- Documentation corrected: the deploy guide gains §3.1 with the two-step ACA binding (`az containerapp secret set --secrets "<name>=keyvaultref:<uri>,identityref:<uami>"`, then `<VAR>=secretref:<name>`) and §7.1 now uses `secretref:`; `.env.example` no longer suggests the App Service syntax.
- **Still open (tracked as COMPLIANCE.md §7.1):** `deploy-azure.yml` and `scripts/provision.sh` still emit the wrong syntax, so a pipeline deploy would overwrite a hand-fixed deployment and break SSO again. A blocking warning was added at the top of the workflow. The conversion needs care: referencing a non-existent Key Vault secret makes the revision fail to start, so optional variables must be handled conditionally.

#### Infinite redirect loop between the app and Entra ID on the SAML callback
- **The ACS endpoint never parsed its request body.** Entra delivers the AuthnResponse with the HTTP-POST binding — `application/x-www-form-urlencoded` carrying a `SAMLResponse` field — but the app mounted only `express.json()`. With `req.body` empty, passport-saml found no `SAMLResponse` and concluded the POST was a fresh login *initiation*: it answered the callback with a brand-new AuthnRequest, Entra posted the response straight back, and the browser span in an endless loop. No error was raised anywhere, and the request log was blind to it (see below), so the only visible symptom was the `SAMLRequest` parameter changing on every hop.
- Like the session-store defect, this was latent for as long as `AADSTS75011` stopped Entra from ever reaching the ACS.
- **Fix:** `express.urlencoded({ extended: false, limit: '1mb' })` is attached to `POST /api/auth/callback` and `POST /api/auth/slo/callback` inside `createAuthRouter`, so the parser travels with the routes that need it and cannot be lost when the app is wired. The 1 MB limit replaces the 100 KB default, which a larger encrypted assertion could exceed. Regression tests in `backend/src/__tests__/samlCallback.test.ts` assert that a posted `SAMLResponse` is never answered with a redirect to the IdP, with a negative control that reproduces the loop.
- **Entra ID needed no change**: it authenticated the user and posted a valid assertion to the correct ACS throughout.

#### Request logging was blind to the auth endpoints
- The HTTP request logger was registered **after** the auth router, so `/api/auth/*` — the endpoints one actually needs when diagnosing a login failure — never appeared in the log. It is now registered before every router. `path`, `method`, `ip` and the user agent are also captured when the request arrives rather than read inside the `finish` handler, which reported `/healthz` for a request to `/api/healthz` because a mounted router rewrites `req.url` while it runs. The query string stays out of the log: it carries the `redirect` parameter and the SAMLRequest.

#### Session store could never reach Azure PostgreSQL
- **The session store was built from a connection string, so it bypassed both TLS and Entra authentication.** `createSessionStore()` passed `conString` to `connect-pg-simple`, which builds its own `pg.Pool` with no `ssl` option and no password. Against Azure Database for PostgreSQL that connection is refused before authentication even starts — `no pg_hba.conf entry for host "...", user "uami-guestportal-backend-prod", database "guestportal_prod", no encryption` — and even over TLS there would be no credential, because Entra authentication deliberately keeps the password out of `DATABASE_URL`: the token only arrives through the `password` callback installed in `db/index.ts`.
- The defect was latent for as long as SSO could not complete: `/api/auth/login` only writes `samlRedirect` to the session and never waits for the store, so the failure was silent. It surfaced as soon as the `AADSTS75011` fix let the SAML callback through, because `req.login()` calls `session.save()` with a callback and the error then propagates to the client.
- **Fix:** the pool factory is now exported as `createDbPool()` — one place that knows how to reach the database, TLS and Entra token included — and `createSessionStore()` is given a pool rather than a connection string. `index.ts` builds the store once and shares it between the Express middleware and the WebSocket upgrade verifier, which previously each opened their own (broken) store. New regression tests in `backend/src/__tests__/sessionStore.test.ts` pin the contract: a pool and never a `conString`, TLS on, and the token callback as `password`.
- This also fixes WebSocket authentication, which read sessions through the same unusable store.

### Added

#### Break-glass access (emergency local login)
- **`POST /api/auth/breakglass/login` + `GET /api/auth/breakglass/status`:** a local username/password login that works when Entra ID / SAML SSO is unavailable. Accounts live in the new `breakglass_users` table. Disabled by default (`BREAKGLASS_ENABLED=false`).
- **⚠️ Accepted deviation, documented as D1 in `COMPLIANCE.md`:** this path bypasses Entra Conditional Access and MFA and, by explicit decision, carries no second factor. The residual risk is stated there alongside the compensating controls below. It depends on PostgreSQL, so it covers an Entra/SSO outage — not a database outage.
- **Compensating controls:** kill switch off by default (endpoint returns `404` until enabled); optional CIDR allowlist `BREAKGLASS_IP_ALLOWLIST`, evaluated first and fail-closed on a fully malformed list, with callers outside it getting `404` and never seeing the link in the UI; scrypt password hashing on Node's own `node:crypto` (no bcrypt/argon2 dependency added); per-account lockout persisted in the database so it holds across ACA replicas, advanced only by a wrong password so guessing cannot extend a lock against the legitimate operator; per-IP sliding-window throttle; constant-cost password verification plus one single generic error for every failure reason, so neither timing nor wording enumerates accounts; session regeneration on login and a shortened cookie TTL; per-account `expires_at`; and every attempt logged at `warn` level with `event`/`reason`/`ip`/`correlationId` for a Log Analytics alert.
- **Account management is CLI-only** (`backend/src/scripts/breakglass.ts`; `make breakglass ARGS="…"` locally, `node backend/dist/scripts/breakglass.js …` in the container): `list`, `set`, `enable`, `disable`, `unlock`, `delete`. There is deliberately no HTTP endpoint for it, which would be a privilege-escalation surface. The password is never accepted as a command-line argument — it is either generated and printed once, or read from stdin with `--stdin-password`.
- **Session model:** `AppUser` is now a discriminated union of `SamlUser` and `BreakGlassUser` on `authMethod` (`backend/src/auth/user.ts`). `/api/auth/me` returns `authMethod`; `POST /api/auth/logout` no longer attempts SAML Single Logout for a break-glass session, whose `nameID` is a local username rather than an Entra subject.
- **Frontend:** a discreet "Accesso di emergenza" link on the SSO screen (rendered only when the backend reports the path as usable by that client), the `BreakGlassLogin` form, and a persistent amber banner plus badge in the dashboard so an emergency session can never be mistaken for a normal one. IT/EN translations added.
- **Deploy guide:** new §1.3 with the enablement procedure, account creation, verification steps and the mandatory Log Analytics KQL alert; §12 gains troubleshooting rows for `AADSTS75011` and for the break-glass failure modes.

### Changed

#### Compliance — Review v7 follow-up (minor cleanups)
- **Dead `guests.password` column removed (§3.2):** the guest password is one-time and never persisted, so the unused `password` column was dropped from the `guests` DDL and from the repository (INSERT/`rowToGuest`/`updateGuest` map). `Guest.password` stays in the type and is always `null`.
- **Stale `.env.example` comment fixed (§3.3):** the Graph email note no longer says "falls back to SMTP (email_config table)" — mail is Graph-only with a dev demo-log fallback.
- **Public SMS provider removed from DDL default (§3.4):** `sms_config.gateway_type` no longer defaults to `'textbelt'` (no default now); the SMS feature stays dormant/hidden.

#### Compliance — Review v7 fixes
- **OIDC identity → infrastructure-owned — §1:** `scripts/setup-oidc.sh` no longer creates the App Registration / service principal / federated credentials (removed `az ad app create`, `az ad sp create`, `az ad app federated-credential create`). It is now a documentation + read-only preflight script: it prints the exact spec the infra team must apply and, with `--verify`, checks read-only (`az ad app ... list`) that the expected federated credentials exist. Docs updated accordingly.
- **WLC password → Key Vault per sede, never in the DB — §2:** The WLC admin password is now one Key Vault secret per site (`WLC-PASSWORD-<CODE>`, env-agnostic), injected as `WLC_PASSWORD_<CODE>` and resolved server-side by `sede.code` (`config.wlcPasswordForSede`). Removed the `password` column from `wlc_config` (migrate + seed), dropped it from repository reads/writes (`rowToWlc`, `updateWlcConfig*`), and removed it from the `WlcConfig` client contract. `POST /wlc/login` no longer accepts or persists a password — it validates connectivity using the per-sede env password. The Login form and ConfigPanel no longer collect a WLC password (sede selection preserved). Deploy pipeline injects `WLC_PASSWORD_{MIL,AQ,NA,TIR,SM}` as Key Vault references.
- **SMTP fallback removed → Graph-only mail — §3:** `services/email.ts` sends only via Microsoft Graph (demo-log fallback in dev); removed nodemailer, `buildTransporter`, the SMTP branch, and the `nodemailer`/`@types/nodemailer` dependencies. Removed `email_config` (migrate + seed), `getEmailConfig`/`updateEmailConfig`, the `EmailConfig` type, and the `GET/PUT /config/email` endpoints. Frontend: removed the SMTP section from ConfigPanel and BadgeModal's email-config fetch; the sender shown is the Graph from-address. Tests updated (email, routes integration, ConfigPanel, Login, BadgeModal).

#### Compliance — Review v5 fixes
- **`setup-oidc.sh` — §3.1:** Removed the Key Vault RBAC assignment (`az role assignment create` + the hardcoded `kv-guestportal-*` name). Under consume-only, granting "Key Vault Secrets User" on the platform Key Vault is the infrastructure team's job. Updated the obsolete hints that referenced `provision.sh` as a Key-Vault creator (it is now a read-only preflight); dropped the "Contributor" prerequisite (only Application Administrator is needed). The OIDC App Registration + federated credentials remain (their ownership is an open decision with the architect, §4.1).

#### Compliance — Review v4 fixes (consume-only model)
- **Consume-only pipeline — §1 (P1):** The pipeline no longer creates ANY Azure resource. `deploy-azure.yml` dropped the DB-bootstrap stage (no `CREATE DATABASE`/user/grants), the `az containerapp job create`, and the `az acr repository update` immutability step. It now: build → push → **start the pre-provisioned migration job** → `az containerapp update --image` on existing apps. Pipeline is now 4 stages.
- **Read-only preflight — §1 (P1):** `scripts/provision.sh` rewritten as a read-only preflight (verifies platform resources via `az ... show`, prints the env-var → Key Vault map; no `create`/`set`). `provision-infra.yml` converted to an "Azure Platform Preflight" workflow. `scripts/README.md` rewritten for the consume-only model.
- **Parametrized platform names — §0 (P1):** All platform resource names are now GitHub secrets (`RG_NAME`, `KV_NAME`, `ACA_ENV_NAME`, `ACA_BACKEND_NAME`, `ACA_FRONTEND_NAME`, `MIGRATION_JOB_NAME`, `UAMI_BACKEND_NAME`, `UAMI_FRONTEND_NAME`); no real names hard-coded.
- **DB identity — §2 (P1):** `DATABASE_URL` user is the backend UAMI name; the Entra role on the DB is documented as an infra prerequisite (not created by the app).
- **Hostname — §3 (P2):** prod is `guestportal.dompe.com` (no suffix); `guestportal-stg.dompe.com` / `guestportal-dev.dompe.com` for non-prod.
- **Internal naming — §5 (P3):** session cookie `cgd.sid` → `guestportal.sid` (backend + WS); localStorage `cgd:adminMode`/`cgd:locale` → `guestportal:*` (frontend + test).
- **SMS kept hidden — §6.b:** neutralized the public `textbelt` default in `db/seed.ts` (`webhook_url` now empty); no server-side SMS send added.

#### Compliance — Review v3 fixes (ANALISI-CONFORMITA-centralino-v3.md)
- **DB identity (Entra) — §3.1 (P0):** `DATABASE_URL` user is now the backend UAMI name (`uami-guestportal-backend-<env>`). The Stage 2 bootstrap no longer creates a password user (`POSTGRES_APP_PASSWORD` / `POSTGRES_ADMIN_PASSWORD` removed); it connects with an Entra access token as the admin, creates the DB, and provisions the Entra principal via `pgaadauth_create_principal` mapped to the UAMI, then grants it. Fixes the authentication mismatch that blocked migration/runtime.
- **Resource naming — §3.3 (P1):** Renamed all Azure resources `cgd-*` → `guestportal-*` (RG, Key Vault, UAMI, ACA env, ACA apps, migration job, images, DB name) across `provision.sh`, `provision-infra.yml`, `deploy-azure.yml`, `docker-security.yml`, `setup-oidc.sh`, and docs. App hostname moved from `cgd-<env>.internal.dompe.com` to `guestportal-<env>.dompe.com` (corporate zone).
- **ACA environment — §3.2 (P1):** `provision.sh` now creates the ACA environment **internal-only + VNet-integrated** (requires `ACA_INFRA_SUBNET_ID`); fails fast if the subnet is not provided.
- **`docker-compose` regression — §3.4 (P1):** Removed `docker-compose.yml`, `docker/nginx.local.conf`, `docker/nginx.main.conf`, the `make compose-*` targets, and all related doc references (guidelines §11 forbid a local runtime stack in the repo).
- **Post-deploy verify — §3.5 (P2):** Stage 5 no longer runs `curl -k` health checks against the private ACA FQDN from a public runner (which produced false greens); it now emits an informational note and documents moving the check to a self-hosted VNet runner.
- **SSH host-key — §3.6 (P2):** `wlcSsh.execSsh` is now truly fail-closed in production — it refuses to connect when `WLC_SSH_HOST_KEY` is unset (`NODE_ENV=production`), matching the `config.ts` comment.
- **DB TLS validation — §3.8 (P3):** The DB pool now validates the server certificate (`rejectUnauthorized: true`) unless `DB_SSL_REJECT_UNAUTHORIZED=false`; previously the certificate was never validated.
- **CI alignment — §3.8 (P3):** CI/security/e2e workflows trigger on `main`/`staging` (was `main`/`develop`); all Node steps standardized on Node 22 (labels and `node-version`); `.clinerules` updated to Node 22 and `node:22-alpine`/`nginx:1.28-alpine`.

#### Compliance — Pipeline & Workflows
- **`.github/workflows/provision-infra.yml`** — Environment options `prd` -> `prod` (allineato con `provision.sh`)
- **`.github/workflows/deploy-azure.yml`** (Stage 2) — DB bootstrap fail-fast: `exit 0` -> `exit 1` se PostgreSQL server non trovato
- **`.github/workflows/deploy-azure.yml`** (Stage 1) — Trivy gate: filesystem + image scan bloccano solo CRITICAL (non HIGH). Image scan ora hanno `exit-code: '1'`
- **`.github/workflows/deploy-azure.yml`** (Stage 5) — Rimossa mutazione Application Gateway (competenza piattaforma)

#### Documentation
- **`COMPLIANCE.md`** — New file: report dettagliato di conformita contro `ANALISI-CONFORMITA-centralino-v2.md`. Checklist §13, P0-P3 backlog, metriche, badge nel README

### Removed
- **Stage 5 deploy-azure.yml** — Rimosso intero step "Update shared App Gateway backend pools" (lascia gestione AGW al team infrastruttura)


### Added

#### CI/CD & Workflows
- **`.github/workflows/docker-security.yml`** — New workflow that builds both Docker images and runs Trivy vulnerability scan (CRITICAL/HIGH) on every push/PR to main/develop. Uploads SARIF results to GitHub Security tab. Uses `continue-on-error` pattern to ensure all scans and uploads complete before the gating step.
- **`.github/dependabot.yml`** — Dependabot configured for non-breaking PRs only (minor+patch, direct dependencies, ignore major versions). npm, Docker, and GitHub Actions ecosystems.
- **`Makefile`** — 15 developer shortcuts: `make test`, `make compose-up`, `make typecheck-backend`, `make docker-scan`, etc. All CI workflows now use Makefile targets for consistency (`make typecheck-backend`, `make test-backend`).
- **`.github/workflows/ci.yml`** — Now uses `make typecheck-backend`, `make typecheck-frontend`, `make test-backend`, `make test-frontend` instead of inline npx/npm commands.
- **`.github/workflows/deploy-azure.yml`** — Uses `make typecheck-backend`, `make typecheck-frontend`, `make test-backend` for Stage 1.

#### Documentation
- **`README.md`** — Added Docker Security badge, Security badge (0 critical, 0 high, 0 moderate, 1 low), Docker Compose quick start section, `make install` step in quick start, updated project layout.
- **`CHANGELOG.md`** — This file.

#### Docker & Local Development
- **`docker-compose.yml`** — Full-stack local testing with PostgreSQL 15, backend (port 3000), frontend (port 8080). Overrides nginx config to proxy `/api/*` to the backend container.
- **`docker/nginx.local.conf`** — Custom nginx config for docker-compose: proxies `/api/*` and `/ws` (WebSocket) to backend, SPA fallback, all temp paths in `/tmp` for non-root nginx user.
- **`docker/nginx.main.conf`** — Custom nginx main config with `pid /tmp/nginx.pid` to support non-root nginx user.
- **`.env.example`** — Added `POSTGRES_PASSWORD` and `COMPOSE_PROJECT_NAME` documentation for Docker Compose users.

### Fixed

#### Security — Docker & Container Images
- **`Dockerfile`** (backend): Base image `node:20-alpine` → `node:22-alpine` (Node 22 LTS, Alpine 3.21) — fixes multiple Alpine CVEs in node:20 base image.
- **`Dockerfile.frontend`** (frontend): 
  - Build stage: `node:20-alpine` → `node:22-alpine` 
  - Runtime stage: `nginx:1.27-alpine` → `nginx:1.28-alpine` (nginx 1.28.3) 
  - Added explicit `RUN apk add --upgrade libcrypto3 libssl3` merged with `apk upgrade --no-cache` — fixes CVE-2026-31789 (OpenSSL heap buffer overflow, 32-bit only) at source.
- **`.trivyignore`** — Added (then removed: CVE-2026-31789 now fixed at source via `apk add --upgrade`). Safety net before the nginx base image shipped the fix.
- **All CI workflow files**: `actions/setup-node` `node-version` from 20 → 22 (consistent with Docker images).

#### Security — Docker Security Workflow
- **`.github/workflows/docker-security.yml`** — Complete overhaul after 7 failed CI runs:
  - Added `category: trivy-backend` / `category: trivy-frontend` to SARIF upload steps (fixed "only one upload allowed per tool/category" error).
  - Severity threshold: `CRITICAL,HIGH` → `CRITICAL` only (aligns with deploy-azure.yml).
  - Pinned `aquasecurity/trivy-action` from `@master` (supply chain risk) to `@v0.36.0`.
  - Replaced `aquasecurity/trivy-action` wrapper with direct `docker run aquasec/trivy:0.70.0` — gives full control over flags, visible CI logs, and reliable gating.
  - Added explicit `--ignorefile /.trivyignore` via Docker volume mount for reliable `.trivyignore` support.
  - Gating logic: replaced `if: steps.x.outcome == 'failure'` (opaque, API returns `outcome=null`) with `if: always()` + bash env var check (`BACKEND_HAS_VULNS=yes/no` via `continue-on-error` + `&&`/`||` pattern).
  - Added `no-cache: true` + `pull: true` for debugging (later cleaned up: kept `pull: true`, restored GHA cache).
  - Removed redundant `continue-on-error: true` from Trivy steps (pattern already ensures exit 0).

**Result:** docker-security.yml goes from 0/1 green → **3/3 green** (3 consecutive passes).

#### Security — npm Dependencies
- **`nodemailer`**: `6.10.1` → `9.0.3` — Fixed **8 high-severity CVEs** (SSRF, injection, DoS, info leak). Replaced `@types/nodemailer@^6.4.24` with `@types/nodemailer@^8.0.1` for type compatibility.
- **`uuid`**: `10.0.0` → `11.1.1` — Fixed 1 moderate CVE (weak entropy in `v1()`). Project only uses `v4()` so impact was low.
- **`vite`**: `5.4.8` → `6.4.0` — Fixed 2 CVEs in `esbuild` (path traversal). Upgraded `@vitejs/plugin-react` for compatibility.
- **`package-lock.json`** — Synchronized with `npm install --package-lock-only` after dependency upgrades.

**Result:** From 26 Dependabot alerts → 1 low severity remaining (esbuild Windows-only).

#### Security — Docker Images
- **`Dockerfile`** (backend): Added `RUN apk upgrade --no-cache` to runtime stage — ensures Alpine packages are patched at build time.
- **`Dockerfile.frontend`** (frontend): Added `RUN apk upgrade --no-cache` to runtime stage — fixes 14-month stale nginx base image.
- **`Dockerfile`** (backend): Added `--include-workspace-root` to runtime `npm install` — fixes `ERR_MODULE_NOT_FOUND` for root dependency `@microsoft/microsoft-graph-client`.
- **`.dockerignore`**: Strengthened from 13 to 23 exclusions — added `**/node_modules`, `.github/`, `scripts/`, `.env.example`, `._DS_Store`, `.dockerignore`, `*.tsconfig.tsbuildinfo`, and more.

#### Bug Fixes — Discovered During Docker Compose Testing
- **`backend/src/db/migrate.ts`**: Fixed hardcoded `ssl: { rejectUnauthorized: false }` to respect `config.db.sslEnabled` env var. Migration CLI now works with local PostgreSQL without SSL.
- **`Dockerfile`**: `--include-workspace-root` addition (see Security section above).
- **`docker/nginx.local.conf`**: Multiple nginx startup fixes for non-root user — all 5 temp path directives (`client_body_temp_path`, `proxy_temp_path`, `fastcgi_temp_path`, `uwsgi_temp_path`, `scgi_temp_path`) set to `/tmp`. Added `proxy_buffering off` for WebSocket locations. Removed unused `proxy_cache_path`. Fixed duplicate WebSocket headers.
- **`docker/nginx.main.conf`**: PID file at `/tmp/nginx.pid` (writable by nginx user vs default `/var/run/nginx.pid`).

### Metrics

| Metric | Before | After |
|---|---|---|
| Unit tests | 391 (170 frontend + 221 backend) | Same — all pass |
| E2E tests | 22/22 | Same — all pass |
| TypeScript errors | 0 | 0 |
| CRITICAL/HIGH CVEs | 6 | **0** |
| Total real vulnerabilities | 11 | **1** (low, Windows-only) |
| Compliance §13 (applicable) | — | **12/16 🟢** |
| CI/CD workflows | 6 | **7** |
| Commits today | — | **40+** |
| New files created | — | **9** |
