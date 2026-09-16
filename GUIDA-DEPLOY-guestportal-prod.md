# Guida di Deploy completa — `guestportal` su Azure (ambiente **prod**)

**Punto di partenza:** hai il **sorgente** e in Azure esistono **solo le risorse condivise di piattaforma**: Resource Group, ambiente ACA (internal), Key Vault, ACR, PostgreSQL Flexible Server, Application Gateway.
**Da creare in questa guida (tutto lato team infrastruttura):** le **2 UAMI**, le **2 Container App** (backend/frontend), il **job ACA di migrazione**, i **secret in Key Vault**, il **DB + identità Entra**, le **App Entra (SAML + Graph)**, la **configurazione di rete/ingress** (listener/route AGW, DNS, egress WLC), e la **build+push delle 2 immagini**.
**Convenzioni:** app `guestportal`, env `prod`, hostname `guestportal.dompe.com`. Compilare i placeholder `<...>`.

**Numero di UAMI: 2** (una per Container App, minimo privilegio):
- `uami-guestportal-backend-prod` → `AcrPull` (ACR) + `Key Vault Secrets User` (KV) + principal Entra su PostgreSQL.
- `uami-guestportal-frontend-prod` → solo `AcrPull` (serve unicamente a pullare l'immagine nginx dall'ACR).

---

> ## ⚠️ Ingress delle Container App: usare `--ingress external`
>
> In Azure Container Apps il flag `external` significa **"esterno all'ambiente Container Apps"**, *non* "esposto su Internet". Su un ambiente **internal** (come il nostro, senza IP pubblico) il comportamento è:
>
> | Ingress dell'app | Raggiungibile da |
> |---|---|
> | `--ingress external` | **tutta la VNet** (via internal load balancer / private endpoint) → Application Gateway, VM, altri servizi. **Non** da Internet: l'ambiente non ha frontend pubblico. |
> | `--ingress internal` | **solo dalle altre Container App dello stesso ambiente**. Richieste da VNet, AGW o VM ricevono **HTTP 404 "Azure Container App - Unavailable"**. |
>
> Le app di questo progetto devono essere raggiunte dall'Application Gateway, che sta **fuori** dall'ambiente ACA → vanno create con **`--ingress external`**.
> La conformità "no public ingress" delle guidelines è garantita dall'**ambiente** (`internal: true`, `publicNetworkAccess: Disabled`), non dal flag dell'app.
>
> **Conseguenza sul FQDN:** con `external` il FQDN **non contiene** il segmento `.internal.`
> - `external` → `ca-guestportal-backend-prod.<defaultDomain>`
> - `internal` → `ca-guestportal-backend-prod.internal.<defaultDomain>`
>
> Il certificato dell'ambiente copre entrambe le forme; i **backend pool dell'AGW** devono usare l'FQDN effettivo restituito da `az containerapp show`.
> Rif.: [Ingress in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)

---

## 0. Tabella dei nomi (compilare una volta)

| Variabile | Valore |
|---|---|
| `SUBSCRIPTION_ID` | `<...>` |
| `RG_NAME` | `<...>` |
| `LOCATION` | `westeurope` |
| `KV_NAME` | `<...>` |
| `ACA_ENV_NAME` | `<...>` |
| `ACR_NAME` (login server `<ACR_NAME>.azurecr.io`) | `<...>` |
| `POSTGRES_SERVER_NAME` / FQDN | `<...>` / `<pg-fqdn>` |
| `AGW_NAME` / `AGW_RG` | `<...>` / `<...>` |
| `AGW_PRIVATE_IP` (frontend privato) | `<...>` |
| DB name | `guestportal_prod` |
| Container App backend | `ca-guestportal-backend-prod` |
| Container App frontend | `ca-guestportal-frontend-prod` |
| Migration job | `job-guestportal-migrate-prod` |
| UAMI backend / frontend | `uami-guestportal-backend-prod` / `uami-guestportal-frontend-prod` |
| Hostname | `guestportal.dompe.com` |
| WLC host per sede | MIL `172.18.106.100`, AQ `.101`, NA `.102`, TIR `.103`, SM `.104` |

Preparazione shell:
```bash
az login
az account set --subscription <SUBSCRIPTION_ID>
az extension add --name containerapp --upgrade -y
```

---

## 1. Applicazioni Entra ID (SSO SAML + Graph mail)

### 1.1 Enterprise Application SAML (Service Provider)
- **Entity ID:** `https://guestportal.dompe.com/saml` → `SAML_ISSUER`
- **Reply URL (ACS):** `https://guestportal.dompe.com/api/auth/callback` → `SAML_CALLBACK_URL`
- **Front-channel logout:** `https://guestportal.dompe.com/api/auth/slo/callback`
- **Claims:** emailaddress, name, givenname, surname, objectidentifier; NameID = persistent (source `user.userPrincipalName`).
- Recupera `SAML_ENTRY_POINT` (SingleSignOnService dalla Federation Metadata) e il **certificato IdP (PEM)** → secret `SAML-CERT`.

> **Nessuna configurazione Entra è richiesta per il metodo di autenticazione.**
> Quale metodo sia accettabile lo decidono le policy di Conditional Access /
> Authentication Strength del tenant. L'applicazione **non deve** dichiararlo
> nell'AuthnRequest: lo fa la libreria `@node-saml/node-saml` per default e
> produce `AADSTS75011` su tutti gli accessi passwordless (CBA, Windows Hello,
> FIDO2). Per questo `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` vale `true` — vedi
> §12 Troubleshooting. Un'Enterprise Application SAML non ha un'impostazione
> supportata per ignorare un `RequestedAuthnContext` ricevuto: il rimedio è
> esclusivamente lato applicazione.

### 1.2 App Registration per Microsoft Graph (mail)
- Permesso **applicativo** `Mail.Send` + **admin consent**; genera un client secret → `MAIL-GRAPH-CLIENT-SECRET`.
- Annota `MAIL_GRAPH_CLIENT_ID`, `MAIL_GRAPH_TENANT_ID`, `MAIL_GRAPH_USER_ID` (mailbox mittente licenziata).

### 1.3 Accesso break-glass (login locale di emergenza)

Login username/password che funziona quando Entra ID / SSO non è raggiungibile.
**Non richiede nulla lato Entra**: è interamente applicativo.

> ⚠️ **Aggira Conditional Access e MFA e, per decisione esplicita, non ha un
> secondo fattore.** È una deviazione documentata e accettata (`COMPLIANCE.md`).
> Nasce disabilitata: abilitala solo dopo aver impostato `BREAKGLASS_IP_ALLOWLIST`
> e creato l'alert del §1.3.4.
>
> Dipende da PostgreSQL: copre un outage di **Entra/SSO**, non un outage del
> **database** (che avrebbe già fermato anche le sessioni).

#### 1.3.1 Variabili ACA (nessuna è un secret)

```bash
az containerapp update -n <ACA_BACKEND_NAME> -g <RG_NAME> --set-env-vars \
  BREAKGLASS_ENABLED=true \
  BREAKGLASS_IP_ALLOWLIST="<CIDR-egress-corporate>,<CIDR-VPN>" \
  BREAKGLASS_SESSION_TTL_MINUTES=120 \
  BREAKGLASS_MAX_FAILED_ATTEMPTS=5 \
  BREAKGLASS_LOCKOUT_MINUTES=15
```

`BREAKGLASS_IP_ALLOWLIST` è, in assenza di secondo fattore, il controllo
compensativo più efficace: chi è fuori dalla lista riceve `404` e non vede
nemmeno il link nella UI. Lasciarla vuota significa esporre l'endpoint a
internet. Se **tutte** le voci sono malformate il comportamento è fail-closed
(nega tutto) e l'errore è a log.

#### 1.3.2 Creazione dell'account

La tabella `breakglass_users` è creata dal job di migrazione (§6). Gli account si
creano **solo** da CLI dentro il container backend — non esiste un endpoint HTTP
di gestione, che sarebbe una superficie di privilege escalation:

```bash
az containerapp exec -n <ACA_BACKEND_NAME> -g <RG_NAME> \
  --command "node backend/dist/scripts/breakglass.js set bg.operator --display 'Break Glass Operator' --expires 2027-12-31"
```

> Il percorso è `backend/dist/...`: la `WORKDIR` dell'immagine è `/app` e la
> build viene copiata in `/app/backend/dist` — lo stesso path usato dal `CMD`
> del container.

Il comando stampa **una sola volta** una password generata (32 caratteri,
~192 bit di entropia): archiviala subito nel password manager del team, non è
recuperabile. Solo l'hash scrypt finisce a database.

Altri comandi: `list`, `unlock <user>`, `disable <user>`, `enable <user>`,
`delete <user>`. Rieseguire `set` sullo stesso username **ruota** la password e
azzera il lockout — è la procedura di rotazione.

Per fornire una password scelta invece di generarla, usare `--stdin-password`
(la password **non** va mai passata come argomento: finirebbe nella history
della shell e nella process list del container).

#### 1.3.3 Verifica

1. Apri l'app: sotto il bottone SSO deve comparire **"Accesso di emergenza"**
   (se non compare, controlla `BREAKGLASS_ENABLED` e l'allowlist verso il tuo IP).
2. Accedi con l'account creato → la dashboard mostra un **banner ambra
   persistente** e il badge "Emergenza" accanto all'utente.
3. Esci: il logout è locale e **non** tenta il Single Logout SAML.
4. Sbaglia la password 5 volte → l'account si blocca per 15 minuti;
   sbloccalo con `breakglass.js unlock`.

#### 1.3.4 Alert su Log Analytics (obbligatorio)

Ogni tentativo è loggato a livello `warn` con un campo `event`. Crea una regola
di alert sul workspace del Container App Environment:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(15m)
| extend d = parse_json(Log_s)
| where tostring(d.event) startswith "breakglass-"
| project TimeGenerated, event = tostring(d.event), reason = tostring(d.reason),
          username = tostring(d.username), ip = tostring(d.ip),
          userAgent = tostring(d.userAgent), correlationId = tostring(d.correlationId)
| order by TimeGenerated desc
```

Eventi emessi: `breakglass-login-success` (un bypass SSO è avvenuto — da
verificare **sempre**), `breakglass-login-denied` (con `reason`:
`unknown-account`, `bad-password`, `account-locked`, `account-disabled`,
`account-expired`, `ip-not-allowed`, `ip-throttled`, `missing-credentials`),
`breakglass-account-locked`, `breakglass-logout`.

Severità suggerite: **Sev 1** su `breakglass-login-success`, **Sev 2** su più di
5 `breakglass-login-denied` in 15 minuti.

---

## 2. UAMI — creazione e ruoli

```bash
# 2.1 Creazione delle due identità
az identity create -n uami-guestportal-backend-prod  -g <RG_NAME> -l <LOCATION>
az identity create -n uami-guestportal-frontend-prod -g <RG_NAME> -l <LOCATION>

BACKEND_UAMI_ID=$(az identity show -n uami-guestportal-backend-prod  -g <RG_NAME> --query id -o tsv)
BACKEND_UAMI_PID=$(az identity show -n uami-guestportal-backend-prod -g <RG_NAME> --query principalId -o tsv)
FRONTEND_UAMI_ID=$(az identity show -n uami-guestportal-frontend-prod -g <RG_NAME> --query id -o tsv)
FRONTEND_UAMI_PID=$(az identity show -n uami-guestportal-frontend-prod -g <RG_NAME> --query principalId -o tsv)

ACR_ID=$(az acr show -n <ACR_NAME> --query id -o tsv)
KV_ID=$(az keyvault show -n <KV_NAME> --query id -o tsv)

# 2.2 AcrPull a entrambe le UAMI (pull immagini da ACR)
az role assignment create --assignee "$BACKEND_UAMI_PID"  --role AcrPull --scope "$ACR_ID"
az role assignment create --assignee "$FRONTEND_UAMI_PID" --role AcrPull --scope "$ACR_ID"

# 2.3 Key Vault Secrets User SOLO al backend (il frontend non legge segreti)
az role assignment create --assignee "$BACKEND_UAMI_PID" --role "Key Vault Secrets User" --scope "$KV_ID"
```
Il principal Entra della UAMI backend sul PostgreSQL è creato nel §4.

---

## 3. Key Vault — popolamento secret

```bash
az keyvault secret set --vault-name <KV_NAME> --name SESSION-SECRET --value "$(openssl rand -base64 48)"
az keyvault secret set --vault-name <KV_NAME> --name SAML-CERT --file ./saml-idp-cert.pem
# opzionali: SAML-DECRYPTION-KEY, SAML-LOGOUT-URL, SAML-LOGOUT-CALLBACK-URL
az keyvault secret set --vault-name <KV_NAME> --name WLC-PASSWORD-MIL --value "<pwd>"
az keyvault secret set --vault-name <KV_NAME> --name WLC-PASSWORD-AQ  --value "<pwd>"
az keyvault secret set --vault-name <KV_NAME> --name WLC-PASSWORD-NA  --value "<pwd>"
az keyvault secret set --vault-name <KV_NAME> --name WLC-PASSWORD-TIR --value "<pwd>"
az keyvault secret set --vault-name <KV_NAME> --name WLC-PASSWORD-SM  --value "<pwd>"
az keyvault secret set --vault-name <KV_NAME> --name MAIL-GRAPH-CLIENT-SECRET --value "<graph-secret>"
# opzionale: APPINSIGHTS-CONNECTION-STRING
```

### 3.1 ⚠️ Binding dei secret: ACA **non** capisce `@Microsoft.KeyVault(...)`

Quella sintassi è di **App Service / Functions**. In Container Apps impostare
una env var a quella stringa passa il **testo letterale** al container. Ci è
costato un incidente in produzione: `SAML_CERT` conteneva il testo della
reference, quindi ogni login SSO finiva con `idpCert is not in PEM format or in
base64 format`; e `SESSION_SECRET` conteneva anch esso la stringa, rendendo la
chiave di firma dei cookie **derivabile da informazioni pubbliche**.

In ACA il binding è in due passi. Primo, dichiara i secret dell app puntando al
vault, con la UAMI che ha il ruolo `Key Vault Secrets User`:

```bash
BACKEND_UAMI_ID=$(az identity list --query "[?name=='uami-guestportal-backend-prod'].id | [0]" -o tsv)
KVURL="https://<KV_NAME>.vault.azure.net/secrets"
SECRETS=""
for S in SESSION-SECRET SAML-CERT WLC-PASSWORD-MIL WLC-PASSWORD-AQ WLC-PASSWORD-NA WLC-PASSWORD-TIR WLC-PASSWORD-SM MAIL-GRAPH-CLIENT-SECRET; do
  L=$(echo "$S" | tr 'A-Z' 'a-z')
  SECRETS="$SECRETS $L=keyvaultref:$KVURL/$S,identityref:$BACKEND_UAMI_ID"
done
az containerapp secret set -n <ACA_BACKEND_NAME> -g <RG_NAME> --secrets $SECRETS
```

Secondo, punta le env var a quei secret con `secretref:` (§7.1).

Note operative:

- i nomi dei secret ACA sono **minuscoli** (lettere, cifre, `-`); il secret nel
  Key Vault mantiene il suo nome `MAIUSCOLO-CON-TRATTINI`;
- l URI **senza versione** fa sì che ACA riprenda automaticamente le rotazioni;
- referenziare un secret **inesistente** in Key Vault fa fallire la nuova
  revisione: verifica prima con
  `az keyvault secret list --vault-name <KV_NAME> --query "[].name" -o tsv`;
- vincola solo i secret che esistono davvero. Le feature opzionali
  (`SAML_DECRYPTION_KEY`, `SAML_LOGOUT_URL`, `APPLICATIONINSIGHTS_CONNECTION_STRING`)
  vanno lasciate fuori se i relativi secret non sono stati creati.

Verifica finale — `az containerapp secret list` **non deve essere vuoto**, e
questo comando deve stampare **niente** (ogni nome elencato è una variabile che
arriva al container come testo letterale):

```bash
az containerapp secret list -n <ACA_BACKEND_NAME> -g <RG_NAME> -o table
az containerapp show -n <ACA_BACKEND_NAME> -g <RG_NAME> --query "properties.template.containers[0].env[?starts_with(value, '@Microsoft.KeyVault')].name" -o tsv
```

---

## 4. PostgreSQL — database e identità Entra
Connesso come **admin Entra** del server, sul DB:
```sql
CREATE DATABASE guestportal_prod;
SELECT * FROM pgaadauth_create_principal('uami-guestportal-backend-prod', false, false);
GRANT CONNECT ON DATABASE guestportal_prod TO "uami-guestportal-backend-prod";
\c guestportal_prod
GRANT ALL ON SCHEMA public TO "uami-guestportal-backend-prod";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "uami-guestportal-backend-prod";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "uami-guestportal-backend-prod";
```
> Login app = **nome UAMI**, token Entra, nessuna password. `DATABASE_URL = postgres://uami-guestportal-backend-prod@<pg-fqdn>:5432/guestportal_prod`.

---

## 5. Build & push delle 2 immagini (dal sorgente)

```bash
git clone <repo-url> guestportal && cd guestportal
GIT_SHA=$(git rev-parse --short HEAD)
az acr login --name <ACR_NAME>

# Backend (Dockerfile) — contesto = radice repo
docker build -f Dockerfile \
  -t <ACR_NAME>.azurecr.io/guestportal-backend:${GIT_SHA} \
  -t <ACR_NAME>.azurecr.io/guestportal-backend:prod .

# Frontend (Dockerfile.frontend)
docker build -f Dockerfile.frontend \
  -t <ACR_NAME>.azurecr.io/guestportal-frontend:${GIT_SHA} \
  -t <ACR_NAME>.azurecr.io/guestportal-frontend:prod .

# (Consigliato) scan CRITICAL locale con Trivy, poi push
docker push <ACR_NAME>.azurecr.io/guestportal-backend:${GIT_SHA}
docker push <ACR_NAME>.azurecr.io/guestportal-backend:prod
docker push <ACR_NAME>.azurecr.io/guestportal-frontend:${GIT_SHA}
docker push <ACR_NAME>.azurecr.io/guestportal-frontend:prod
```

---

## 6. Job di migrazione — creazione ed esecuzione
```bash
az containerapp job create \
  --name job-guestportal-migrate-prod -g <RG_NAME> --environment <ACA_ENV_NAME> \
  --trigger-type Manual --replica-timeout 600 \
  --image <ACR_NAME>.azurecr.io/guestportal-backend:${GIT_SHA} \
  --command "node" "backend/dist/db/migrate.js" \
  --registry-server <ACR_NAME>.azurecr.io --registry-identity "$BACKEND_UAMI_ID" \
  --mi-user-assigned "$BACKEND_UAMI_ID" \
  --env-vars "DATABASE_URL=postgres://uami-guestportal-backend-prod@<pg-fqdn>:5432/guestportal_prod"

# Esegui la migrazione (crea lo schema) PRIMA di avviare il backend
az containerapp job start --name job-guestportal-migrate-prod -g <RG_NAME>
az containerapp job execution list --name job-guestportal-migrate-prod -g <RG_NAME> -o table
```

---

## 7. Container App — creazione

### 7.1 Backend (ingress **external** — vedi nota in testa alla guida —, UAMI, env + Key Vault references)
```bash
az containerapp create \
  --name ca-guestportal-backend-prod -g <RG_NAME> --environment <ACA_ENV_NAME> \
  --image <ACR_NAME>.azurecr.io/guestportal-backend:${GIT_SHA} \
  --registry-server <ACR_NAME>.azurecr.io --registry-identity "$BACKEND_UAMI_ID" \
  --user-assigned "$BACKEND_UAMI_ID" \
  --ingress external --target-port 3000 --transport http \
  --revisions-mode single --min-replicas 1 --max-replicas 1 \
  --cpu 1.0 --memory 2.0Gi \
  --env-vars \
    NODE_ENV=production PORT=3000 LOG_LEVEL=info \
    SKIP_MIGRATIONS=true SEED_ENABLED=false \
    DATABASE_URL="postgres://uami-guestportal-backend-prod@<pg-fqdn>:5432/guestportal_prod" \
    SAML_ENTRY_POINT="<...>" \
    SAML_ISSUER="https://guestportal.dompe.com/saml" \
    SAML_CALLBACK_URL="https://guestportal.dompe.com/api/auth/callback" \
    SAML_DISABLE_REQUESTED_AUTHN_CONTEXT=true \
    SAML_CERT="secretref:saml-cert" \
    SESSION_SECRET="secretref:session-secret" \
    WLC_PASSWORD_MIL="secretref:wlc-password-mil" \
    WLC_PASSWORD_AQ="secretref:wlc-password-aq" \
    WLC_PASSWORD_NA="secretref:wlc-password-na" \
    WLC_PASSWORD_TIR="secretref:wlc-password-tir" \
    WLC_PASSWORD_SM="secretref:wlc-password-sm" \
    WLC_SSH_HOST_KEY="<fingerprint>" WLC_TLS_REJECT_UNAUTHORIZED=true \
    MAIL_GRAPH_ENABLED=true MAIL_GRAPH_TENANT_ID="<...>" \
    MAIL_GRAPH_CLIENT_ID="<...>" MAIL_GRAPH_USER_ID="<...>" \
    MAIL_GRAPH_FROM_ADDRESS="noreply@dompe.com" \
    MAIL_GRAPH_CLIENT_SECRET="secretref:mail-graph-client-secret"

# BACKEND_BASE_URL (serve il default domain dell'ambiente)
ACA_DOMAIN=$(az containerapp env show -n <ACA_ENV_NAME> -g <RG_NAME> --query properties.defaultDomain -o tsv)
az containerapp update -n ca-guestportal-backend-prod -g <RG_NAME> \
  --set-env-vars BACKEND_BASE_URL="http://ca-guestportal-backend-prod.${ACA_DOMAIN}"
```
> ⚠️ `WLC_SSH_HOST_KEY` è unico nel codice ma i WLC sono 5: vedi §12 (follow‑up host‑key per sede). In prod, senza host key l'SSH è *fail‑closed*.
>
> `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT=true` è il default del codice: è esplicitato qui perché rimuoverlo o portarlo a `false` rompe tutti i login passwordless con `AADSTS75011` (§1.1, §12).
>
> Le variabili `BREAKGLASS_*` **non** sono impostate qui: l'accesso di emergenza nasce disabilitato e va abilitato deliberatamente seguendo il §1.3.

### 7.2 Frontend (ingress **external**, UAMI solo pull)
```bash
az containerapp create \
  --name ca-guestportal-frontend-prod -g <RG_NAME> --environment <ACA_ENV_NAME> \
  --image <ACR_NAME>.azurecr.io/guestportal-frontend:${GIT_SHA} \
  --registry-server <ACR_NAME>.azurecr.io --registry-identity "$FRONTEND_UAMI_ID" \
  --user-assigned "$FRONTEND_UAMI_ID" \
  --ingress external --target-port 3000 --transport http \
  --revisions-mode single --min-replicas 1 --max-replicas 1 \
  --cpu 0.5 --memory 1.0Gi
```

### 7.3 FQDN effettivi (servono per l'AGW) e verifica immediata
```bash
BE_FQDN=$(az containerapp show -n ca-guestportal-backend-prod  -g <RG_NAME> --query properties.configuration.ingress.fqdn -o tsv)
FE_FQDN=$(az containerapp show -n ca-guestportal-frontend-prod -g <RG_NAME> --query properties.configuration.ingress.fqdn -o tsv)
echo "BE: $BE_FQDN"   # atteso SENZA ".internal." → ca-guestportal-backend-prod.<defaultDomain>
echo "FE: $FE_FQDN"

# Verifica da una VM nella VNet PRIMA di configurare l'AGW: devono rispondere 200.
curl -k -sS -o /dev/null -w "BE /api/healthz -> %{http_code}\n" "https://$BE_FQDN/api/healthz"
curl -k -sS -o /dev/null -w "FE /healthz     -> %{http_code}\n" "https://$FE_FQDN/healthz"
```
> Se qui ricevi **404 "Azure Container App - Unavailable"**, l'app è quasi certamente configurata con `--ingress internal`: correggi con
> `az containerapp ingress enable -n <app> -g <RG_NAME> --type external --target-port 3000 --transport http`
> (il FQDN cambia: ricordati di aggiornare i backend pool dell'AGW).

### 7.4 Se le app esistono già con ingress internal — conversione
```bash
az containerapp ingress enable -n ca-guestportal-backend-prod  -g <RG_NAME> --type external --target-port 3000 --transport http
az containerapp ingress enable -n ca-guestportal-frontend-prod -g <RG_NAME> --type external --target-port 3000 --transport http
# poi ricalcola BE_FQDN/FE_FQDN (§7.3), aggiorna BACKEND_BASE_URL e i pool dell'AGW (§8.1)
```

---

## 8. Rete e ingress — configurazione sull'AGW esistente

> L'AGW esiste già; qui si **aggiungono** listener/pool/route per `guestportal.dompe.com`. Il certificato TLS (wildcard `*.dompe.com` o specifico) va caricato sull'AGW (o referenziato da Key Vault).

```bash
# 8.1 Pool → FQDN effettivi delle app (da §7.3, SENZA ".internal." perché l'ingress è external).
#     Se i pool esistono già con il vecchio FQDN, usare "address-pool update" al posto di "create".
az network application-gateway address-pool create -g <AGW_RG> --gateway-name <AGW_NAME> -n pool-guestportal-backend  --servers "$BE_FQDN"
az network application-gateway address-pool create -g <AGW_RG> --gateway-name <AGW_NAME> -n pool-guestportal-frontend --servers "$FE_FQDN"

# 8.2 Probe (host preso dagli http-settings → FQDN del pool)
az network application-gateway probe create -g <AGW_RG> --gateway-name <AGW_NAME> -n probe-guestportal-backend  --protocol Https --path /api/healthz --host-name-from-http-settings true --interval 30 --timeout 10 --threshold 3
az network application-gateway probe create -g <AGW_RG> --gateway-name <AGW_NAME> -n probe-guestportal-frontend --protocol Https --path /healthz     --host-name-from-http-settings true --interval 30 --timeout 10 --threshold 3

# 8.3 HTTP settings (HTTPS 443 verso ACA, host dal backend address)
az network application-gateway http-settings create -g <AGW_RG> --gateway-name <AGW_NAME> -n set-guestportal-backend  --port 443 --protocol Https --host-name-from-backend-pool true --probe probe-guestportal-backend
az network application-gateway http-settings create -g <AGW_RG> --gateway-name <AGW_NAME> -n set-guestportal-frontend --port 443 --protocol Https --host-name-from-backend-pool true --probe probe-guestportal-frontend

# 8.4 Listener HTTPS per l'hostname (usa frontend IP privato + cert)
az network application-gateway http-listener create -g <AGW_RG> --gateway-name <AGW_NAME> -n lsnr-guestportal \
  --frontend-ip <appGwPrivateFrontend> --frontend-port <port-443> --ssl-cert <cert-dompe> --host-name guestportal.dompe.com

# 8.5 URL path map: /api/* → backend, default → frontend
az network application-gateway url-path-map create -g <AGW_RG> --gateway-name <AGW_NAME> -n pm-guestportal \
  --default-address-pool pool-guestportal-frontend --default-http-settings set-guestportal-frontend \
  --paths "/api/*" --address-pool pool-guestportal-backend --http-settings set-guestportal-backend --rule-name api-route

# 8.6 Regola path-based che lega listener → path map
az network application-gateway rule create -g <AGW_RG> --gateway-name <AGW_NAME> -n rule-guestportal \
  --http-listener lsnr-guestportal --rule-type PathBasedRouting --url-path-map pm-guestportal --priority 100

# 8.7 WAF in Prevention sul listener (policy dedicata o esistente)
```

**DNS:** record `guestportal.dompe.com` nella zona `dompe.com` → **IP privato** del frontend AGW (`AGW_PRIVATE_IP`).
```bash
az network private-dns record-set a add-record -g <dns-rg> -z dompe.com -n guestportal --ipv4-address <AGW_PRIVATE_IP>
```

**Egress verso il WLC** (dalla subnet ACA verso `172.18.0.0/16`, TCP 22 e 443):
```bash
# NSG della subnet ACA — consentire outbound verso la subnet di management
az network nsg rule create -g <RG_NAME> --nsg-name <nsg-aca> -n Allow-WLC-Out \
  --priority 200 --direction Outbound --access Allow --protocol Tcp \
  --destination-address-prefixes 172.18.0.0/16 --destination-port-ranges 22 443 \
  --source-address-prefixes VirtualNetwork
# + eventuale route (UDR) verso l'hub/ExpressRoute se il routing non è già presente.
```

---

## 9. Verifica post‑deploy (da rete interna / GlobalProtect)
```bash
curl -fsS https://guestportal.dompe.com/api/healthz   # 200
curl -fsS https://guestportal.dompe.com/api/readyz    # 200 (DB connesso)
curl -fsS https://guestportal.dompe.com/healthz       # 200 (frontend)
```
Browser: apertura → **SSO Entra** → app; selezione sede → creazione ospite → il **WLC** risponde (SSH); invio credenziali → **mail via Graph** ricevuta.

Verifica che l'AuthnRequest non vincoli il metodo di autenticazione (previene
`AADSTS75011` sugli accessi passwordless):

```bash
# Prendi il valore di SAMLRequest dall'URL di redirect di /api/auth/login, poi:
python3 -c "import sys,base64,zlib,urllib.parse; print(zlib.decompress(base64.b64decode(urllib.parse.unquote(sys.argv[1])),-15).decode())" '<SAMLRequest>' \
  | grep -c RequestedAuthnContext   # deve stampare 0
```

> Le variabili `BREAKGLASS_*` non sono gestite dalla pipeline: `az containerapp
> update --set-env-vars` **aggiunge/aggiorna** solo le variabili indicate e
> conserva le altre, quindi quanto impostato a mano al §1.3 sopravvive ai deploy
> successivi.

---

## 10. (Opzionale) Deploy a regime via pipeline
Per automatizzare i deploy successivi:
1. Creare l'**identità OIDC** della pipeline (App Registration + federated credentials per `main` e `environment:prod`) con RBAC sul solo `RG_NAME`.
2. GitHub → Environment `prod` (+ reviewers) e i **repository secrets** (`AZURE_*`, `ACR_NAME`, `ACA_ENVIRONMENT_DEFAULT_DOMAIN`, `RG_NAME`, `KV_NAME`, `ACA_ENV_NAME`, `ACA_BACKEND_NAME`, `ACA_FRONTEND_NAME`, `MIGRATION_JOB_NAME`, `UAMI_BACKEND_NAME`, `UAMI_FRONTEND_NAME`, `POSTGRES_SERVER_NAME`, `DATABASE_URL`, `SAML_*`, `MAIL_GRAPH_CLIENT_ID`, `MAIL_GRAPH_USER_ID`).
3. Merge su `main` → il workflow "Deploy to Azure Container Apps" esegue build → scan → `job start` migrazione → `az containerapp update` (che riapplica anche le env/KV refs).

---

## 11. Rollback
```bash
az containerapp update -n ca-guestportal-backend-prod  -g <RG_NAME> --image <ACR_NAME>.azurecr.io/guestportal-backend:<sha-precedente>
az containerapp update -n ca-guestportal-frontend-prod -g <RG_NAME> --image <ACR_NAME>.azurecr.io/guestportal-frontend:<sha-precedente>
```
Migrazioni idempotenti/additive → il rollback immagine non richiede rollback schema.

---

## 12. Troubleshooting

| Sintomo | Causa / azione |
|---|---|
| `docker push` 401/denied | `az acr login` scaduto o ruolo AcrPush mancante |
| Container App non pulla | UAMI senza `AcrPull` sull'ACR (§2.2) o `--registry-identity` errato |
| `@Microsoft.KeyVault(...)` non risolve | `Key Vault Secrets User` mancante alla UAMI backend (§2.3) o secret assente |
| `readyz` = 503 | DB irraggiungibile o principal Entra/grant mancanti (§4) |
| Auth DB fallita | login ≠ nome UAMI oppure `pgaadauth_create_principal` non eseguito (§4) |
| SSO KO / errore firma | `SAML_ENTRY_POINT/ISSUER/CALLBACK_URL` o `SAML-CERT` errati (§1.1) |
| **`AADSTS75011: Authentication method 'X509, MultiFactor, X509Device' ... doesn't match requested authentication method 'Password, ProtectedTransport'`** | L'AuthnRequest chiede esplicitamente `PasswordProtectedTransport` con `Comparison="exact"` e l'utente si è autenticato passwordless (CBA, Windows Hello, FIDO2). **Non è un problema di configurazione Entra** e non esiste un'impostazione lato Enterprise Application per ignorare il vincolo: verificare che `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT` **non** sia `false` sul backend (default `true`, §1.1) e che l'immagine sia ≥ la versione con il fix. Verifica sul campo: aprire `/api/auth/login`, prendere `SAMLRequest` dall'URL di redirect verso `login.microsoftonline.com`, poi URL-decode → base64-decode → inflate; l'XML **non** deve contenere `RequestedAuthnContext`. |
| Il link "Accesso di emergenza" non compare | `BREAKGLASS_ENABLED≠true`, oppure l'IP del client è fuori da `BREAKGLASS_IP_ALLOWLIST` (§1.3.1). L'endpoint risponde `404` in entrambi i casi, di proposito. |
| Login break-glass sempre rifiutato | Account inesistente, disabilitato, scaduto o bloccato: il messaggio all'utente è volutamente identico in tutti i casi. La causa reale è nel log, campo `reason` (§1.3.4). Sbloccare con `breakglass.js unlock <user>`. |
| Break-glass KO con DB giù | Atteso: gli account stanno su PostgreSQL. Il break-glass copre un outage di Entra/SSO, non del database (§1.3). |
| **404 "Azure Container App - Unavailable"** su ogni path (anche `/`), da VM o AGW | **App creata con `--ingress internal`**: in un ambiente internal è raggiungibile solo dalle altre Container App dello stesso ambiente. Correggere con `az containerapp ingress enable --type external` (§7.4) e riallineare i pool AGW al nuovo FQDN (senza `.internal.`). Sintomo diagnostico: l'app risponde 200 dall'interno del container (`az containerapp exec` → `wget http://127.0.0.1:3000/api/healthz`) ma 404 dall'esterno. |
| 502 dall'AGW | pool/probe puntano a un FQDN errato o probe `/api/healthz`/`/healthz` KO (§8) |
| WLC non risponde | egress `172.18.0.0/16` non abilitato (§8) o `WLC_SSH_HOST_KEY` non impostato (fail‑closed) |
| Mail non inviate | `MAIL_GRAPH_ENABLED≠true` o `Mail.Send`/consent/secret mancanti (§1.2) |

---

## 13. Checklist go‑live (tutta a cura del team infra)
- [ ] App Entra: Enterprise App SAML + App Registration Graph (§1)
- [ ] 2 UAMI create + ruoli (AcrPull ×2, KV Secrets User backend) (§2)
- [ ] Secret Key Vault popolati (§3)
- [ ] DB `guestportal_prod` + principal Entra UAMI + grant (§4)
- [ ] Immagini backend+frontend buildate e pushate (SHA + `:prod`) (§5)
- [ ] Job migrazione creato ed eseguito (§6)
- [ ] Container App backend+frontend create con **`--ingress external`** (UAMI, env/KV refs) (§7)
- [ ] FQDN verificati **senza** `.internal.` e health 200 da VM nella VNet **prima** di toccare l'AGW (§7.3)
- [ ] AGW: pool allineati ai FQDN effettivi + probe/settings/listener/route + DNS `guestportal.dompe.com` → IP privato (§8)
- [ ] Egress verso `172.18.0.0/16` + host key SSH (§8/§7)
- [ ] Verifica health + SSO + WLC + mail (§9)
- [ ] **Se si vuole l'accesso di emergenza** (opzionale, off per default): `BREAKGLASS_IP_ALLOWLIST` popolata con i CIDR corporate/VPN → `BREAKGLASS_ENABLED=true` → account creato da CLI e password archiviata nel password manager → alert Log Analytics attivo → verifica banner e lockout (§1.3)

---

## 14. Follow‑up di codice consigliato (prima del pieno esercizio)
- **Host‑key SSH per sede:** oggi `WLC_SSH_HOST_KEY` è unico; con 5 WLC distinti serve `WLC_SSH_HOST_KEY_<CODE>` (analogo alle password per sede) per verificare l'host key di ciascun controller in modalità fail‑closed.

---

*Runbook Infrastructure & Cloud Architecture. Basato su `Dockerfile`, `Dockerfile.frontend`, `deploy-azure.yml`, `scripts/provision.sh` e le AI Development Guidelines. Compilare i `<...>` con i valori reali. Numero UAMI = 2 (una per Container App, minimo privilegio).*
