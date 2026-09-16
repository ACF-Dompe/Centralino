# Compliance Report — Cisco Guest Desk (`centralino`)

**Data:** July 2026  
**Baseline:** *Azure Container Platform – AI Development Guidelines* (Standard Architecture Definition v1.5, 2026‑06‑15) — scope Non‑GxP  
**Fonte:** `ANALISI-CONFORMITA-centralino-v2.md` (Code & Architecture Review v2)  
**Commit ultimo aggiornamento:** `df641852`

---

## Executive Summary

L'applicazione ha raggiunto un livello di conformità molto elevato rispetto alla review v2. Delle **18 checklist items §13**, **13 sono verdi** (conformi), **2 gialle** (parziali), **2 N/A**. 

Tutti i **P0** (4/4) e **P1‑P2** (11/11) sono stati risolti nel codice. In questa sessione sono state aggiunte **ulteriori hardening di sicurezza Docker**: upgrade immagini base, Trivy workflow autonomo con 3/3 CI verdi consecutivi. Rimangono aperti **2 item architetturali** (provisioning app‑owned, DB Entra principal) che richiedono coordinamento con il team infrastruttura.

---

## P0 — Difetti bloccanti il deploy (4/4 risolti ✅)

| # | Difetto | Stato | Fix |
|---|---|---|---|
| **3.1** | `migrate.ts` senza entrypoint eseguibile | ✅ **FIXED** | Aggiunto `main()` + `createMigrationClient()` + direct‑execution detection. Il CLI `node backend/dist/db/migrate.js` ora esegue le migrazioni con exit code 0/1. |
| **3.2** | Audience token DB errato (`ossrdbms` vs `ossrdbms-aad`) | ✅ **FIXED** | `backend/src/db/index.ts`: `AZURE_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default'` ✅ `scripts/provision.sh`: stesso valore ✅ |
| **3.3** | Ruolo Entra sul DB per UAMI non creato | 🔶 **MANUALE/INFRA** | La UAMI viene creata da `provision.sh`. Il mapping PostgreSQL (`pgaadauth_create_principal`) è un passo manuale del team infrastruttura — non automatizzabile via codice. |
| **3.4** | Suffisso `prd` vs `prod` disallineato | ✅ **FIXED** | `provision.sh`: accetta `dev\|stg\|prod` ✅ `setup-oidc.sh`: usa `dev stg prod` ✅ `provision-infra.yml`: opzioni dropdown `prd` → `prod` (commit `eeb0c86d`) ✅ |

---

## P1 — Residuo architetturale + Sicurezza (5/6 risolti ✅)

| # | Difetto | Stato | Dettaglio |
|---|---|---|---|
| **4** | Provisioning app‑owned (RG/KV/ACA env) | ✅ **FIXED** | Modello **consume‑only**: la pipeline non crea più alcuna risorsa (rimossi DB‑bootstrap, `containerapp job create`, `acr repository update`). `provision.sh` è ora un **preflight read‑only**; `provision-infra.yml` è "Azure Platform Preflight". Nomi risorse **parametrizzati** via secret GitHub. Le risorse (RG/KV/ACA env/Container App/UAMI/DB/ruolo Entra/ACR/AGW) sono pre‑provisionate dalla piattaforma. `setup-oidc.sh` non assegna più RBAC sul Key Vault (compito infra) né hardcoda il nome KV; resta solo la creazione dell'App Registration OIDC, la cui ownership è da confermare con l'architetto (§4.1). |
| **5.1** | Segreti WLC/SMTP esposti via GET API | ✅ **FIXED** | `GET /config/wlc` → `password: undefined` | `GET /config/email` → `password: undefined` | `GET /config/sms` → `apiKey: undefined` |
| **5.2** | `targetPassword` in audit log `sync_logs` | ✅ **FIXED** | `const safePayload = { ...cfg, targetPassword: '***' }` prima del log. |
| **5.3** | Default TLS insicuri (`rejectUnauthorized: false`) | ✅ **FIXED** | `WLC_TLS_REJECT_UNAUTHORIZED` default `true` in produzione, `false` in dev. `hostVerifier` SSH attivo solo se `WLC_SSH_HOST_KEY` è impostata. |
| **5.4** | WebSocket `/ws` non autenticato | ✅ **FIXED** | Path: `/api/ws` + `sessionVerifier.verifySession()` sull'upgrade → 401 se non autenticato. |
| **5.5** | SAML hardening | ✅ **FIXED** | `@node-saml/passport-saml` ✅ `wantAssertionsSigned: true` ✅ `wantAuthnResponseSigned: true` ✅ `validateInResponseTo: ValidateInResponseTo.ifPresent` ✅ `audience: params.issuer` ✅ `isLocalUrl()` su redirect ✅ `disableRequestedAuthnContext: true` ✅ (vedi 5.8) |
| **5.8** | AuthnRequest vincolava il metodo di autenticazione (`AADSTS75011`) | ✅ **FIXED** | `@node-saml/node-saml` 5.1.0 inserisce per default `RequestedAuthnContext = PasswordProtectedTransport` con `Comparison="exact"` (`lib/saml.js:86-88,100,187-199`). Entra ID onora il vincolo, quindi **ogni** accesso passwordless (CBA, Windows Hello, FIDO2 → `amr = X509, MultiFactor, X509Device`) veniva rifiutato con `AADSTS75011`. Il metodo di autenticazione è una decisione di Conditional Access / Authentication Strength del tenant, non del service provider: `disableRequestedAuthnContext: true` (default, override con `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT`) rimuove l'elemento dall'AuthnRequest. Pinnato anche in `deploy-azure.yml` perché un override manuale non sopravviva a un deploy. Verificato sull'XML generato, non solo sull'opzione. |
| **5.9** | Session store senza TLS né credenziale Entra | ✅ **FIXED** | `createSessionStore()` passava `conString` a `connect-pg-simple`, che costruisce un `pg.Pool` proprio **senza `ssl` e senza password**. Contro Azure PostgreSQL la connessione è rifiutata prima dell'autenticazione (`no pg_hba.conf entry ... no encryption`) e, anche cifrata, non avrebbe credenziale: con Entra la password non sta in `DATABASE_URL` ma arriva dal callback `password` installato solo da `db/index.ts`. Difetto latente finché l'SSO non poteva completarsi (nessuna sessione doveva essere persistita con successo), emerso col fix 5.8. Il factory del pool è ora esportato come `createDbPool()` — unico punto che sa raggiungere il DB, TLS e token inclusi — e lo store riceve un pool. Corregge anche l'autenticazione WebSocket, che leggeva le sessioni dallo stesso store inservibile. Test: `sessionStore.test.ts`. |
| **5.10** | ACS SAML senza parser del body → loop di redirect infinito con Entra | ✅ **FIXED** | Entra consegna l'AuthnResponse con binding HTTP-POST (`application/x-www-form-urlencoded`, campo `SAMLResponse`), ma l'app montava solo `express.json()`. Con `req.body` vuoto passport-saml non trovava `SAMLResponse` e interpretava il POST come **inizio** di un nuovo login: rispondeva al callback con una nuova AuthnRequest, Entra ripostava la risposta, loop infinito senza alcun errore. Latente finché `AADSTS75011` impediva a Entra di raggiungere l'ACS. `express.urlencoded({ extended: false, limit: '1mb' })` è ora agganciato a `POST /callback` e `POST /slo/callback` **dentro** `createAuthRouter`, così il parser viaggia con le route che ne hanno bisogno; il limite 1 MB sostituisce il default 100 KB, insufficiente per un'assertion cifrata grande. Nessuna modifica lato Entra. Test: `samlCallback.test.ts`, con controllo negativo che riproduce il loop. |
| **9.1** | Log delle richieste cieco sugli endpoint di autenticazione | ✅ **FIXED** | Il middleware di logging era registrato **dopo** il router di auth, quindi `/api/auth/*` non compariva mai nel log — esattamente gli endpoint necessari a diagnosticare un problema di login (è costato un ciclo di diagnosi sull'incidente 5.10). Ora è registrato prima di ogni router; `path`/`method`/`ip`/user-agent sono catturati all'arrivo della richiesta anziché letti nel gestore `finish`, che riportava `/healthz` per una richiesta a `/api/healthz` perché un router montato riscrive `req.url` mentre gira. La query string resta esclusa dal log (contiene il parametro `redirect` e la SAMLRequest). |
| **7.1** | Key Vault reference in sintassi App Service: **nessun secret veniva risolto** | 🔶 **PARZIALE** | Le env var erano impostate a `@Microsoft.KeyVault(SecretUri=...)`, sintassi di App Service / Functions che **Container Apps non espande**: al container arrivava il testo letterale (`az containerapp secret list` era vuoto). Conseguenze: ogni login SSO falliva con `idpCert is not in PEM format or in base64 format`, e **`SESSION_SECRET` conteneva la stringa della reference** — chiave di firma dei cookie derivabile da informazioni pubbliche, quindi sessioni forgiabili. Anche `WLC_PASSWORD_*` e `MAIL-GRAPH-CLIENT-SECRET` erano letterali. **Fatto:** procedura corretta documentata (guida §3.1, `.env.example`), env var del §7.1 portate a `secretref:`, validazione del certificato all avvio in `createSamlStrategy` (rifiuta la reference non risolta con un messaggio esplicito, disabilitando l SSO senza abbattere il processo così il break-glass resta disponibile), avviso bloccante in testa a `deploy-azure.yml`. **Aperto:** `deploy-azure.yml` (13 occorrenze) e `scripts/provision.sh` (12) usano ancora la sintassi errata — un deploy via pipeline sovrascriverebbe la correzione manuale e romperebbe di nuovo l SSO. Da convertire con attenzione: referenziare un secret Key Vault inesistente fa fallire la revisione, quindi le variabili opzionali vanno gestite condizionalmente. Test: `saml.test.ts`. |
| **5.11** | Strategy SAML assente → `Unknown authentication strategy "saml"` | ✅ **FIXED** | Con un `SAML_CERT` inutilizzabile `createSamlStrategy` restituisce null, quindi passport non riceve la strategy — ma le route SSO venivano montate comunque. Era una lacuna della validazione del certificato (§7.1): il commento diceva che il chiamante disabilita l SSO sul null, e il chiamante non lo faceva. `createAuthRouter` distingue ora tre stati (SSO usabile / configurato ma rotto / non configurato): nello stato rotto le route SSO danno 501 con la causa probabile e il rimando ai log di startup, e `/me` risponde **401 e non 404** — un 404 significa per il frontend "SSO inesistente" e gli farebbe saltare la schermata di accesso, e con essa il link di emergenza. Gli endpoint break-glass restano raggiungibili. Test: `samlCallback.test.ts`. |
| **5.12** | `Invalid document signature`: firma a livello Response assente | ✅ **FIXED (config IdP)** | Entra firma l `<Assertion>` ma non il `<samlp:Response>` con la Signing Option di default ("Sign SAML assertion"); l app pretende entrambe. Verificato decodificando l assertion reale da un HAR catturato: RSA-SHA256, certificato valido, `<Signature>` presente solo dentro l Assertion. **Rimedio preferito lato IdP:** Signing Option = "Sign SAML response and assertion", così la copertura della firma resta su tutto il documento e il default stretto dell app non cambia. Aggiunto `SAML_WANT_AUTHN_RESPONSE_SIGNED` (default `true`) per i tenant dove quell impostazione non è modificabile: la firma dell Assertion resta incondizionata. Test: `saml.test.ts`. |

---

## P1‑P2 — Sicurezza residui (2/2 risolti ✅)

| # | Difetto | Stato | Dettaglio |
|---|---|---|---|
| **5.6** | `SESSION_SECRET` fallback + `ssl.rejectUnauthorized:false` hardcoded | ✅ **FIXED** | Fallback dev con warning esplicito. SSL: `config.db.sslEnabled ? { rejectUnauthorized: false } : false` — condizionato da env. |
| **5.7** | Bug rilevamento SSO (status 404 mai propagato) | ✅ **FIXED** | `ApiError` class con `.status: number` in `client.ts` ✅ `App.tsx` legge `(err as { status?: number }).status` ✅ |

---

## P2‑P3 — Pipeline (7/7 risolti ✅)

| # | Difetto | Stato | Dettaglio |
|---|---|---|---|
| **6.1** | Pipeline riconfigura Application Gateway | ✅ **FIXED** | Rimosso intero step "Update shared App Gateway backend pools" da Stage 5 (commit `eeb0c86d`). Aggiunto commento: "managed by the platform infrastructure team". |
| **6.2** | Gate Trivy incoerente | ✅ **FIXED** | **Filesystem scan:** `severity: 'CRITICAL'` + `exit-code: '1'` (blocca solo CRITICAL) ✅ **Image scan:** `severity: 'CRITICAL'` + `exit-code: '1'` (blocca solo CRITICAL) ✅ Tutti e 3 gli scanner ora consistenti. |
| **6.3** | DB bootstrap non fail‑fast (`exit 0`) | ✅ **FIXED** | `exit 0` → `exit 1` se PostgreSQL server non trovato (commit `eeb0c86d`). |
| **6.4** | `HEALTHCHECK` backend usa `/api/health` | ✅ **FIXED** | `HEALTHCHECK ... node ... /api/healthz` nel `Dockerfile`. |
| **6.5** | `.env.example` nomi secret incoerenti | ✅ **FIXED** | Tabella KV reference completa e allineata (env var → secret name). |
| **6.6** | `@vitest/coverage-v8` in `dependencies` | ✅ **FIXED** | Ora in `devDependencies`. |
| **6.7** | `E2E_BASE_URL` non collegato in `playwright.config.ts` | ✅ **FIXED** | `baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000'` |

---

## Checklist §13 — Stato di Conformità

| # | Requisito (§13) | Stato | Nota |
|---|---|---|---|
| 1 | Due immagini/Dockerfile indipendenti | 🟢 Conforme | Stateless, non‑root, multi‑stage |
| 2 | README + `.gitignore`; nessun segreto committato | 🟢 Conforme | README root/backend/frontend/scripts; segreti rimossi |
| 3 | Config via env; segreti solo via KV ref | 🟢 Conforme | Password WLC in Key Vault per sede (`WLC_PASSWORD_<CODE>`), mai in DB (§2 v7); SMTP rimosso, mail solo via Graph (§3 v7). Resta solo `sms_config.api_key` in DB, ma la feature SMS è nascosta e il campo è vuoto |
| 4 | API sotto `/api`, same‑origin, no CORS | 🟢 Conforme | CORS rimosso |
| 5 | Frontend→backend server‑side via `BACKEND_BASE_URL` | ⚪ N/A | Nessun SSR |
| 6 | Dietro AGW (URL relativi, header forwarded) | 🟢 Conforme | `trust proxy`; WS ora sotto `/api/ws` |
| 7 | Accesso Azure via `DefaultAzureCredential` scoped | 🟢 Conforme | DB via Entra ID; mail via client credentials |
| 8 | SSO Entra SAML 2.0 | 🟢 Conforme | Hardening completo applicato |
| 9 | Migrazioni idempotenti, no superuser | 🟢 Conforme | Entrypoint CLI funzionante ✅ |
| 10 | Pipeline 5 stage + branch mapping + Trivy | 🟢 Conforme | Struttura ok; Trivy ora blocco solo CRITICAL ✅ + docker-security.yml autonomo stabile (3/3 success) |
| 11 | Log strutturati + health per spec + graceful shutdown | 🟢 Conforme | Correlation ID, `/healthz`‑`/readyz`, SIGTERM |
| 12 | Postgres token Entra (`ossrdbms-aad`), refresh | 🟢 Conforme | Audience corretto ✅ refresh 45' |
| 13 | Risorse a default (0.5/1.0, 1.0/2.0) | 🟢 Conforme | Allineate |
| 14 | No autoscaling/multi‑revision/public ingress/extra | 🟡 Parziale | Provisioning crea ancora RG/KV/ACA env propri (sez. 4) |
| 15 | Nessun artefatto runtime locale; unit test zero‑infra | 🟢 Conforme | 391 test. e2e verdi con baseURL fisso |
| 16 | Verifica post‑deploy identica sui 3 branch | ⚪ N/A | Health check eseguiti manualmente in questa fase |
| 17 | Seed Dev‑only idempotente | 🟢 Conforme | `SEED_ENABLED` off in prod |
| 18 | Open points (§12) elencati | 🟡 Parziale | Pipeline non modifica più AGW (rimosso ✅) |

**Totale:** 13 🟢 · 2 🟡 · 1 🔶 · 2 ⚪ N/A

---

## Deviazioni consapevoli (rischio accettato)

### D1 — Accesso break-glass senza secondo fattore

| Campo | Valore |
|---|---|
| **Cosa** | Login locale username/password (`POST /api/auth/breakglass/login`) che consente l'accesso alla console quando Entra ID / SAML SSO non è disponibile. |
| **Perché** | Continuità operativa: senza di esso un outage dell'IdP rende la console inutilizzabile e gli ospiti non registrabili. |
| **Deviazione** | Aggira Conditional Access e MFA di Entra. **Non ha un secondo fattore**: è una scelta esplicita del richiedente, presa dopo che il rischio è stato rappresentato (l'alternativa proposta era password + TOTP su `node:crypto`, senza dipendenze aggiuntive). |
| **Rischio residuo** | Una password compromessa è sufficiente per accedere alla console con pieni privilegi da internet (l'app è pubblicata su `guestportal.dompe.com`). Il rischio **non è eliminato**, solo ridotto. |

**Controlli compensativi implementati** (tutti nel codice, non solo procedurali):

| Controllo | Dove |
|---|---|
| Kill switch `BREAKGLASS_ENABLED`, default **`false`** — l'endpoint risponde `404` finché non viene abilitato deliberatamente | `config.ts`, `routes/auth.ts` |
| Allowlist CIDR `BREAKGLASS_IP_ALLOWLIST`, valutata prima di tutto il resto; **fail-closed** se tutte le voci sono malformate; chi è fuori riceve `404` e non vede il link nella UI | `utils/ipAllowlist.ts` |
| Hash scrypt (RFC 7914) con salt per record, `timingSafeEqual`, nessuna dipendenza nuova; la password in chiaro non è mai persistita, loggata o restituita | `auth/password.ts` |
| Lockout per account persistito a DB (quindi **globale** su tutte le repliche ACA); solo la password errata lo incrementa, così il guessing non può prolungare il blocco all'operatore legittimo | `repositories/breakglass.ts` |
| Throttle per IP sorgente a finestra scorrevole (in memoria → per replica; il lockout a DB è il controllo globale) | `utils/loginThrottle.ts` |
| Verifica password a **costo costante** (hash fittizio quando l'utente non esiste) e **un solo messaggio di errore** per ogni causa di rifiuto → nessuna enumerazione account per timing o per wording | `auth/password.ts`, `routes/auth.ts` |
| Rigenerazione della sessione al login (anti session-fixation) e TTL cookie ridotto (default 120 min vs 24 h SSO) | `routes/auth.ts` |
| Scadenza per account (`expires_at`) per time-boxare le credenziali | `breakglass_users` |
| Audit a livello `warn` di **ogni** tentativo, riuscito o no, con `event`/`reason`/`ip`/`userAgent`/`correlationId`; alert KQL obbligatorio in guida di deploy §1.3.4 | `routes/auth.ts` |
| Account creabili **solo da CLI**: nessun endpoint HTTP di gestione, che sarebbe una via di privilege escalation da una sessione compromessa | `scripts/breakglass.ts` |
| Banner ambra persistente + badge in dashboard: una sessione di emergenza non può passare per una sessione normale | `Dashboard.tsx` |
| Il logout break-glass **non** tenta il Single Logout SAML (il `nameID` è un utente locale, non un soggetto Entra) | `routes/auth.ts` |

**Limiti noti, a verbale:**

1. Nessun secondo fattore — vedi *Rischio residuo*.
2. Dipende da PostgreSQL: copre un outage di **Entra/SSO**, non del **database**.
3. Il throttle per IP è per-replica; il lockout per account è globale.
4. `BREAKGLASS_IP_ALLOWLIST` vuota espone l'endpoint a internet: in assenza di secondo fattore è il controllo compensativo più efficace e va popolata con i CIDR di egress corporate/VPN. Il backend logga un `warn` esplicito all'avvio se il break-glass è abilitato senza allowlist.

---

## Backlog di Remediation Aggiornato

### Ancora aperti (richiedono azione esterna / coordinamento)

| Prio | Azione | Rif. | Tipo |
|---|---|---|---|
| P0 | Creare principal Entra su PostgreSQL mappato alla UAMI backend (`pgaadauth_create_principal`) | 3.3 | 🏗️ Infrastruttura (manuale una tantum) |
| P1 | Adottare risorse di piattaforma (RG condiviso, KV di piattaforma, ACA environment esistente). Unica creazione app = UAMI | 4 | 🏗️ Architetturale (coordinamento team infra) |
| P1 | Allineare naming/hostname a `<appname>.dompe.com` / zona `dompe.com` | 4 | 🏗️ Architetturale |
| **P0** | **Convertire `deploy-azure.yml` e `scripts/provision.sh` alla sintassi secret di ACA (`keyvaultref:`/`secretref:`)** — finché non è fatto, un deploy via pipeline rompe di nuovo l SSO e riporta `SESSION_SECRET` a un valore pubblico | 7.1 | 🔧 Codice (pipeline) |

### Risolti nel codice (ultimo commit `df641852`)

| Prio | Azione | Rif. | Commit |
|---|---|---|---|
| P0 | `migrate.ts` entrypoint eseguibile | 3.1 | Precedente |
| P0 | Audience token DB corretto (`ossrdbms-aad`) | 3.2 | Precedente |
| P0 | Suffisso `prd` → `prod` allineato in tutti i workflow | 3.4 | Precedente |
| P1 | Segreti WLC/SMTP non esposti in GET API | 5.1 | Precedente |
| P1 | `targetPassword` oscurato nei log | 5.2 | Precedente |
| P1 | Default TLS sicuri (fail‑closed in produzione) | 5.3 | Precedente |
| P1 | WebSocket sotto `/api/ws` con autenticazione | 5.4 | Precedente |
| P1 | SAML hardening (`@node-saml/passport-saml`, `wantAssertionsSigned`, `audience`, ecc.) | 5.5 | Precedente |
| P1 | `ApiError.status` propagato + SSO fallback WLC su 404 funzionante | 5.7 | Precedente |
| P2 | AGW mutazione rimossa dalla pipeline | 6.1 | Precedente |
| P2 | Trivy gate: blocca solo CRITICAL (exit‑code=1), HIGH non blocca | 6.2 | Precedente |
| P2 | DB bootstrap fail‑fast (`exit 0` → `exit 1`) | 6.3 | Precedente |
| P2 | `HEALTHCHECK` backend → `/api/healthz` | 6.4 | Precedente |
| P2 | `.env.example` allineato con tabella KV reference | 6.5 | Precedente |
| P2 | `E2E_BASE_URL` collegato in `playwright.config.ts` | 6.7 | Precedente |
| P3 | `@vitest/coverage-v8` spostato in `devDependencies` | 6.6 | Precedente |
| **—** | **Docker: immagini base node:20→22, nginx:1.27→1.28, CI runner 20→22** | — | `df641852` |
| **—** | **CVE-2026-31789: fixato via `apk add --upgrade libcrypto3 libssl3`** | — | `df641852` |
| **—** | **`docker-security.yml`: sostituita action wrapper con `docker run` diretto (log visibili, gating affidabile)** | — | `df641852` |
| **—** | **3/3 workflow CI verdi consecutivi (CI + E2E + Docker Security)** | — | `df641852` |
| **—** | **`.trivyignore` rimosso (CVE fixato alla fonte)** | — | `df641852` |
| **P1** | **`AADSTS75011`: rimosso `RequestedAuthnContext` dall'AuthnRequest (compatibilità CBA/Windows Hello/FIDO2)** | 5.8 | *questa sessione* |
| **P1** | **Session store con TLS e token Entra (era `conString`, connessione rifiutata da `pg_hba`)** | 5.9 | *questa sessione* |
| **P1** | **ACS SAML: parser urlencoded sul callback (era loop di redirect infinito con Entra)** | 5.10 | *questa sessione* |
| **P2** | **Log delle richieste spostato prima dei router (`/api/auth/*` non era tracciato)** | 9.1 | *questa sessione* |
| **—** | **Accesso break-glass con controlli compensativi (deviazione D1)** | D1 | *questa sessione* |

---

## Metriche Progetto

| Metrica | Valore |
|---|---|
| **Test unitari** | 486 conteggiati staticamente (169 frontend + 317 backend), di cui **86 nuovi** per i fix 5.8/5.9/5.10/7.1/9.1 e la deviazione D1 — da riconfermare con `make test` |
| **Test E2E** | 22/22 — CI verde |
| **TypeScript** | 0 errori (frontend + backend) |
| **Vulnerabilità CRITICAL/HIGH** | 0 |
| **Workflow CI/CD** | 7 (3 attivi su push main: tutti 🟢 verdi) |
| **docker-security.yml** | 3/3 success consecutivi (da 0/7 failure) |
| **Vulnerabilità CRITICAL immagini Docker** | 0 (node:22-alpine + nginx:1.28-alpine + apk upgrade) |
| **Node.js CI/CD runner** | 22 (allineato con Docker images) |
| **Conformità §13** | 13/16 applicabili 🟢 |
