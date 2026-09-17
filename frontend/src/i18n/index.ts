/**
 * Lightweight in-house i18n.
 * Two locales (it, en) and a tiny flat translation file.
 * No external library to keep the bundle small.
 */
import { useEffect, useState, useCallback } from 'react';

export type Locale = 'it' | 'en';

export const SUPPORTED_LOCALES: Locale[] = ['it', 'en'];
const STORAGE_KEY = 'guestportal:locale';

type Dict = Record<string, string>;
const dictionaries: Record<Locale, Dict> = {
  it: {
    // App
    'app.title': 'Dompè Guest Desk',
    'app.subtitle': 'Gestione Account Ospiti Wi-Fi',
    'app.operator': 'Operatore',

    // Login
    'login.heading': 'Accesso al Wireless LAN Controller',
    'login.subtitle': 'Autenticati al WLC per gestire gli account ospiti',
    'login.host': 'Host / IP Controller',
    'login.port': 'Porta HTTPS',
    'login.sshPort': 'Porta SSH',
    'login.username': 'Username amministratore',
    'login.ssid': 'WLAN SSID',
    'login.submit': 'Connetti al WLC',
    'login.error.creds': 'Credenziali WLC errate. Verifica username e password.',
    'login.error.unreachable': 'WLC non raggiungibile. Controlla la rete e riprova.',
    'login.sede.heading': 'Seleziona la sede',
    'login.sede.subtitle': 'Scegli la sede operativa. Il sistema caricherà automaticamente la configurazione del WLC corrispondente.',
    'login.sede.empty': 'Nessuna sede configurata. Contatta l\'amministratore di sistema.',
    'login.sede.changeSede': 'Cambia sede',
    'login.demo.title': 'WLC NON RAGGIUNGIBILE (TIMEOUT)',
    'login.demo.detail': 'Il controller non ha risposto entro il timeout previsto. Puoi modificare i parametri di connessione oppure abilitare la modalità Demo/Sandbox per utilizzare l\'applicazione in locale.',
    'login.demo.edit': 'Modifica Parametri',
    'login.demo.enable': 'Abilita Demo Sandbox',
    'login.bullet.locations': '5 sedi: Milano, L\'Aquila, Napoli, Tirana, San Mateo',
    'login.bullet.credentials': 'Credenziali temporanee: mai salvate, solo via email',
    'login.bullet.sync': 'Sincronizzazione WLC 30s per sede',

    // Header
    'header.connected': 'CONNESSO',
    'header.offline': 'OFFLINE / SANDBOX',
    'header.sede': 'Sede',
    'header.adminMode': 'Modalità Admin',
    'header.lastSync': 'Ultimo sync',
    'header.never': 'mai',
    'header.syncNow': 'Sincronizza WLC',
    'header.lockConsole': 'Blocca Console',
    'header.changeSede': 'Cambia sede',
    'header.language': 'Lingua',

    // Stats
    'stats.registered': 'Registrati',
    'stats.online': 'Connessi Ora',
    'stats.pending': 'In attesa',
    'stats.expired': 'Scaduto',
    'stats.deactivated': 'Revocato',

    // Toolbar
    'toolbar.search': 'Cerca per nome, email, azienda, host, username...',
    'toolbar.statusAll': 'Tutti',
    'toolbar.admin': 'Amministrazione',
    'toolbar.register': 'Registra Ospite',

    // Table
    'table.guest': 'Ospite',
    'table.contact': 'Contatti',
    'table.company': 'Azienda / Sponsor',
    'table.creds': 'Credenziali Wi-Fi',
    'table.time': 'Tempo rimanente',
    'table.status': 'Stato',
    'table.actions': 'Azioni',
    'table.empty': 'Nessun ospite trovato',
    'table.copy': 'Copia',
    'table.copied': 'Copiato!',
    'table.resend': 'Re-invia Credenziali',
    'table.resendSuccess': 'Credenziali reinviate a {email}',
    'table.resendFailed': 'Invio credenziali fallito',
    'table.activate': 'Attiva',
    'table.revoke': 'Revoca',
    'table.delete': 'Elimina',
    'table.confirmDelete': 'Confermi l\'eliminazione di {name}?',
    'table.remarks': 'Note',

    // Status
    'status.pending': 'In attesa',
    'status.active': 'Connesso',
    'status.expired': 'Scaduto',
    'status.deactivated': 'Revocato',

    // Time
    'time.expired': 'Scaduto',
    'time.days': 'g',
    'time.formatMinutes': '{n} min',
    'time.formatHour': '1 ora',
    'time.formatHours': '{n} ore',
    'time.formatDay': '1 giorno',
    'time.formatDays': '{n} giorni',
    'time.formatMonths': '{n} mesi',
    'time.formatYears': '{n} anni',

    // Modal
    'modal.tab.badge': 'Stampa Badge',
    'modal.tab.sms': 'SMS Cellulare',
    'modal.tab.email': 'Email Corporate',
    'modal.sms.recipient': 'Destinatario',
    'modal.sms.notSet': 'Numero di telefono non impostato per questo ospite.',
    'modal.sms.send': 'Invia SMS',
    'modal.sms.sending': 'Invio in corso...',
    'modal.sms.sent': 'SMS inviato correttamente',
    'modal.notAvailable': '(non disponibile)',
    'modal.close': 'Chiudi',
    'modal.sms.defaultBody': 'Wi-Fi {ssid} — User: {username} — Pass: {password}',

    // Create form
    'create.title': 'Registra Nuovo Ospite',
    'create.name': 'Nome completo',
    'create.email': 'Email',
    'create.phone': 'Telefono',
    'create.company': 'Azienda',
    'create.company.default': 'Ospite Individuale',
    'create.host': 'Referente / Sponsor',
    'create.host.placeholder': 'Dr.ssa Maria Rossi',
    'create.duration': 'Durata accesso',
    'create.remarks': 'Note',
    'create.remarks.placeholder': 'Note interne...',
    'create.submit': 'Crea Ospite',
    'create.cancel': 'Annulla',
    'create.success': 'Ospite {name} creato con successo.',
    'create.oneTimePassword': 'Password temporanea (mostrata una sola volta)',
    'create.oneTimePasswordHelp': 'Copia questa password e comunicala all\'ospite: non viene salvata. Per generarne una nuova usa "Re-invia Credenziali" nella tabella.',
    'create.sedeAuto': 'Sede',
    'create.sedeAutoHelp': 'L\'ospite verrà registrato sulla sede selezionata al login.',
    'create.customDuration': 'Data personalizzata',
    'create.preset.30min': '30 min',
    'create.preset.2h': '2 ore',
    'create.preset.4h': '4 ore',
    'create.preset.8h': '8 ore',
    'create.preset.1d': '1 giorno',
    'create.preset.1w': '1 settimana',
    'create.endAt': 'Scade il',
    'create.pastDate': 'La data di scadenza deve essere nel futuro.',
    'create.tooLong': 'La durata massima è di 1 settimana.',
    'create.durationComputed': 'Durata calcolata',

    // Config
    'config.title': 'Configurazione Canali',
    'config.sensitiveHidden': 'I campi sensibili (password) sono nascosti in modalità standard. Clicca su "Modalità Admin" per modificarli.',
    'config.adminEnable': 'Abilita Modalità Admin',
    'config.adminDisable': 'Disabilita Modalità Admin',
    'config.adminPrompt': 'Inserisci PIN amministratore',
    'config.adminWrongPin': 'PIN errato',
    'config.adminPinEnvHint': 'Definito da VITE_ADMIN_PIN (default: vuoto = nessun PIN richiesto in dev)',
    'config.sms.title': 'Gateway SMS',
    'config.sms.gateway': 'Provider gateway',
    'config.sms.apiKey': 'API Key',
    'config.sms.sender': 'Sender ID',
    'config.sms.webhook': 'Webhook URL',
    'config.wlc.title': 'Controller WLC',
    'config.wlc.status': 'Stato connessione',
    'config.wlc.account': 'Account collegato',
    'config.wlc.ssid': 'WLAN SSID',
    'config.wlc.host': 'IP Controller',
    'config.wlc.port': 'Porta HTTPS',
    'config.wlc.test': 'Test Connessione',
    'config.save': 'Salva',
    'config.saved': 'Configurazione salvata.',
    'config.sms.textbelt': 'Textbelt',
    'config.sms.sms77': 'SMS77',
    'config.sms.gatewayOption.webhook': 'Webhook personalizzato',
    'config.wlc.online': 'Online',
    'config.wlc.offline': 'Offline',

    // Toast / generic
    'create.emailSent': '✉️ Una email con queste credenziali è stata inviata a {email}.',

    // Config
    'config.wlc.connectionError': 'Errore di connessione',

    // Login
    'login.or': 'oppure',
    'login.corporateConsole': 'Corporate Console',
    'login.demo.enter': 'Entra in Demo Sandbox (senza WLC)',
    'login.demo.description': 'Salta il login WLC e usa i dati locali. Le operazioni che richiedono il WLC saranno registrate come offline.',

    // Badge

    // SSO
    'sso.corporateConsole': 'Single Sign-On',
    'sso.heading': 'Accesso con Single Sign-On',
    'sso.subtitle': 'Autenticati con il tuo account aziendale Dompé per accedere alla console di gestione.',
    'sso.loginButton': 'Accedi con SSO',
    'sso.description': 'Verrai reindirizzato al portale Microsoft Entra ID per l\'autenticazione. Utilizza le tue credenziali aziendali.',
    'sso.logout': 'Logout',
    'sso.operator': 'Operatore SSO',

    // Accesso di emergenza (break-glass)
    'breakglass.link': 'Accesso di emergenza',
    'breakglass.heading': 'Accesso di emergenza',
    'breakglass.subtitle': 'Da usare solo quando il Single Sign-On aziendale non è disponibile.',
    'breakglass.warning': 'Questo accesso aggira il Single Sign-On e l\'autenticazione a più fattori. Ogni tentativo viene registrato e notificato al team di sicurezza.',
    'breakglass.username': 'Utente di emergenza',
    'breakglass.password': 'Password',
    'breakglass.submit': 'Accedi',
    'breakglass.backToSso': 'Torna all\'accesso SSO',
    'breakglass.error': 'Credenziali non valide, account non abilitato o troppi tentativi. Contatta il team di sicurezza.',
    'breakglass.badge': 'Emergenza',
    'breakglass.banner': 'Sessione di emergenza attiva: il Single Sign-On è stato aggirato. La sessione è tracciata e ha durata ridotta — esci appena l\'SSO torna disponibile.',
    'breakglass.logout': 'Esci (emergenza)',

    // Notifiche WS
    'app.event': 'Evento recente',
    'app.events': '{n} eventi recenti',
    'app.clear': 'Cancella',

    'ws.guestExpired': 'Ospite {name} scaduto',
    'ws.label.guest.expired': 'Scaduto',
    'ws.label.guest.deactivated': 'Disconnesso',
    'ws.label.guest.created': 'Registrato',
    'ws.label.guest.deleted': 'Eliminato',
    'ws.label.guest.imported': 'Importato',
    'ws.label.guest.updated': 'Aggiornato',
    'ws.guestDeactivated': 'Ospite {name} disconnesso dal WLC',
    'ws.guestCreated': 'Nuovo ospite {name} registrato',
    'ws.guestDeleted': 'Ospite {name} eliminato',
    'ws.guestImported': 'Ospite {name} importato dal WLC',

    // Toast / generic
    'toast.error': 'Errore',
    'toast.success': 'Operazione completata',
    'toast.loading': 'Caricamento...',
    // ── Accesso in attesa di abilitazione ──────────────────────────────────
    'pending.title': 'Accesso in attesa di abilitazione',
    'pending.description': 'Il tuo account è stato riconosciuto, ma non è ancora stato abilitato. Un amministratore deve assegnarti un ruolo e le sedi su cui puoi lavorare.',
    'pending.yourAccount': 'Il tuo account',
    'pending.contactAdmin': 'Comunica l\'indirizzo qui sopra all\'amministratore del portale ospiti per farti abilitare.',
    'pending.logout': 'Esci',
    'suspended.title': 'Accesso sospeso',
    'suspended.description': 'Il tuo accesso è stato sospeso da un amministratore. Se ritieni si tratti di un errore, contattalo indicando l\'indirizzo qui sotto.',
    'sso.error.provisioning': 'Accesso riuscito ma registrazione dell\'utente non completata. Riprova; se il problema persiste contatta l\'amministratore.',

    // ── Selezione sede ────────────────────────────────────────────────────
    'login.sede.noneAssigned': 'Nessuna sede abilitata per il tuo utente. Contatta un amministratore.',
    'login.retry': 'Riprova',
    'login.error.unreachableSede': 'WLC di {sede} non raggiungibile.',
    'login.error.credentialMissing': 'Sede {sede} non ancora abilitata: manca la password del controller in Key Vault.',
    'login.error.sedeInactive': 'La sede {sede} è disattivata.',
    'login.error.notConfigured': 'Controller non ancora configurato per la sede {sede}.',
    'login.error.forbidden': 'Non sei abilitato alla sede {sede}.',

    // ── Ruoli e stati utente ──────────────────────────────────────────────
    'role.admin': 'Amministratore',
    'role.operator': 'Operatore',
    'role.viewer': 'Sola lettura',
    'userStatus.pending': 'Da profilare',
    'userStatus.active': 'Attivo',
    'userStatus.suspended': 'Sospeso',

    // ── Pannello di amministrazione ───────────────────────────────────────
    'admin.title': 'Amministrazione',
    'admin.subtitle': 'Utenti, sedi e accessi di emergenza',
    'admin.tab.users': 'Utenti',
    'admin.tab.sedi': 'Sedi e WLC',
    'admin.tab.breakglass': 'Emergenza',
    'admin.refresh': 'Aggiorna',
    'admin.users.all': 'Tutti',
    'admin.users.hint': 'Gli utenti compaiono qui dopo il primo accesso SSO, in stato "Da profilare". Finché non li abiliti non possono operare.',
    'admin.users.empty': 'Nessun utente da mostrare.',
    'admin.users.pendingBadge': 'Da profilare',
    'admin.users.autoAdmin': 'Admin automatico',
    'admin.users.autoAdminHelp': 'Amministratore per convenzione sull\'indirizzo (admin365-...@dompe.onmicrosoft.com): ruolo e stato non sono modificabili.',
    'admin.users.you': 'Tu',
    'admin.users.lastLogin': 'Ultimo accesso',
    'admin.users.profiledBy': 'profilato da',
    'admin.users.role': 'Ruolo',
    'admin.users.status': 'Stato',
    'admin.users.sedi': 'Sedi abilitate',
    'admin.users.adminAllSedi': 'Gli amministratori accedono a tutte le sedi.',
    'admin.users.save': 'Salva',

    // ── Sedi ──────────────────────────────────────────────────────────────
    'admin.sede.new': 'Nuova sede',
    'admin.sede.selectOne': 'Seleziona una sede dall\'elenco.',
    'admin.sede.active': 'Attiva',
    'admin.sede.inactive': 'Disattivata',
    'admin.sede.credential': 'Credenziale',
    'admin.sede.lastCheck': 'Ultimo test',
    'admin.sede.code': 'Codice',
    'admin.sede.codeImmutable': 'Non modificabile: collega la sede al segreto in Key Vault.',
    'admin.sede.name': 'Nome',
    'admin.sede.city': 'Città',
    'admin.sede.address': 'Indirizzo',
    'admin.sede.wlcSection': 'Controller WLC',
    'admin.sede.host': 'Indirizzo / IP',
    'admin.sede.username': 'Account amministrativo',
    'admin.sede.port': 'Porta HTTPS',
    'admin.sede.sshPort': 'Porta SSH',
    'admin.sede.ssid': 'SSID rete ospiti',
    'admin.sede.passwordNote': 'La password del controller non è gestita qui: vive in Key Vault e viene risolta a runtime.',
    'admin.sede.credentialMissing': 'Password del controller non configurata. Richiedi al team piattaforma:',
    'admin.sede.save': 'Salva',
    'admin.sede.test': 'Test connessione',
    'admin.sede.testOk': 'Connessione riuscita',
    'admin.sede.testFailed': 'Connessione fallita',
    'admin.sede.activate': 'Attiva sede',
    'admin.sede.deactivate': 'Disattiva sede',
    'admin.sede.forceActivate': 'Il test di connessione non è mai riuscito per questa sede. Attivarla comunque?',
    'admin.sede.delete': 'Elimina',
    'admin.sede.confirmDelete': 'Eliminare definitivamente la sede {code}?',

    // ── Break glass ───────────────────────────────────────────────────────
    'admin.bg.cliOnly': 'Creazione e cambio password degli account di emergenza si fanno solo da CLI (make breakglass). Qui puoi abilitarli, disabilitarli e sbloccarli.',
    'admin.bg.empty': 'Nessun account di emergenza configurato.',
    'admin.bg.enable': 'Abilita',
    'admin.bg.disable': 'Disabilita',
    'admin.bg.unlock': 'Sblocca',
    'admin.bg.lastLogin': 'Ultimo accesso',
    'admin.bg.failedAttempts': 'tentativi falliti',
    'admin.bg.expires': 'scade',
    'admin.bg.state.enabled': 'Attivo',
    'admin.bg.state.disabled': 'Disabilitato',
    'admin.bg.state.expired': 'Scaduto',
    'admin.bg.state.locked': 'Bloccato',
  },
  en: {
    'app.title': 'Dompè Guest Desk',
    'app.subtitle': 'Wi-Fi Guest Account Management',
    'app.operator': 'Operator',

    'login.heading': 'Wireless LAN Controller Login',
    'login.subtitle': 'Authenticate to the WLC to manage guest accounts',
    'login.host': 'Controller Host / IP',
    'login.port': 'HTTPS Port',
    'login.sshPort': 'SSH Port',
    'login.username': 'Admin username',
    'login.ssid': 'WLAN SSID',
    'login.submit': 'Connect to WLC',
    'login.error.creds': 'Wrong WLC credentials. Verify username and password.',
    'login.error.unreachable': 'WLC unreachable. Check the network and try again.',
    'login.sede.heading': 'Select location',
    'login.sede.subtitle': 'Choose the operating site. The system will auto-load the corresponding WLC configuration.',
    'login.sede.empty': 'No site configured. Contact your system administrator.',
    'login.sede.changeSede': 'Change site',
    'login.demo.title': 'WLC UNREACHABLE (TIMEOUT)',
    'login.demo.detail': 'The controller did not respond within the timeout. You can edit the connection parameters or enable Demo/Sandbox mode to use the application locally.',
    'login.demo.edit': 'Edit Parameters',
    'login.demo.enable': 'Enable Demo Sandbox',
    'login.bullet.locations': '5 sites: Milan, L\'Aquila, Naples, Tirana, San Mateo',
    'login.bullet.credentials': 'Temporary credentials: never stored, sent via email only',
    'login.bullet.sync': 'WLC sync every 30s per site',

    'header.connected': 'CONNECTED',
    'header.offline': 'OFFLINE / SANDBOX',
    'header.sede': 'Location',
    'header.adminMode': 'Admin Mode',
    'header.lastSync': 'Last sync',
    'header.never': 'never',
    'header.syncNow': 'Sync WLC',
    'header.lockConsole': 'Lock Console',
    'header.changeSede': 'Change site',
    'header.language': 'Language',

    'stats.registered': 'Registered',
    'stats.online': 'Online Now',
    'stats.pending': 'Pending',
    'stats.expired': 'Expired',
    'stats.deactivated': 'Revoked',

    'toolbar.search': 'Search by name, email, company, host, username...',
    'toolbar.statusAll': 'All',
    'toolbar.admin': 'Administration',
    'toolbar.register': 'Register Guest',

    'table.guest': 'Guest',
    'table.contact': 'Contacts',
    'table.company': 'Company / Sponsor',
    'table.creds': 'Wi-Fi Credentials',
    'table.time': 'Time remaining',
    'table.status': 'Status',
    'table.actions': 'Actions',
    'table.empty': 'No guest found',
    'table.copy': 'Copy',
    'table.copied': 'Copied!',
    'table.resend': 'Re-send Credentials',
    'table.resendSuccess': 'Credentials re-sent to {email}',
    'table.resendFailed': 'Failed to re-send credentials',
    'table.activate': 'Activate',
    'table.revoke': 'Revoke',
    'table.delete': 'Delete',
    'table.confirmDelete': 'Confirm deletion of {name}?',
    'table.remarks': 'Notes',

    'status.pending': 'Pending',
    'status.active': 'Connected',
    'status.expired': 'Expired',
    'status.deactivated': 'Revoked',

    'time.expired': 'Expired',
    'time.days': 'd',
    'time.formatMinutes': '{n} min',
    'time.formatHour': '1 hour',
    'time.formatHours': '{n} hours',
    'time.formatDay': '1 day',
    'time.formatDays': '{n} days',
    'time.formatMonths': '{n} months',
    'time.formatYears': '{n} years',

    'modal.tab.badge': 'Print Badge',
    'modal.tab.sms': 'Mobile SMS',
    'modal.tab.email': 'Corporate Email',
    'modal.sms.recipient': 'Recipient',
    'modal.sms.notSet': 'No phone number set for this guest.',
    'modal.sms.send': 'Send SMS',
    'modal.sms.sending': 'Sending...',
    'modal.sms.sent': 'SMS sent successfully',
    'modal.notAvailable': '(not available)',
    'modal.close': 'Close',
    'modal.sms.defaultBody': 'Wi-Fi {ssid} — User: {username} — Pass: {password}',

    'create.title': 'Register New Guest',
    'create.name': 'Full name',
    'create.email': 'Email',
    'create.phone': 'Phone',
    'create.company': 'Company',
    'create.company.default': 'Individual Guest',
    'create.host': 'Sponsor / Host',
    'create.host.placeholder': 'e.g. Dr. Smith',
    'create.duration': 'Access duration',
    'create.remarks': 'Notes',
    'create.remarks.placeholder': 'Internal notes...',
    'create.submit': 'Create Guest',
    'create.cancel': 'Cancel',
    'create.success': 'Guest {name} created successfully.',
    'create.oneTimePassword': 'Temporary password (shown only once)',
    'create.oneTimePasswordHelp': 'Copy this password and share it with the guest: it is not stored. To generate a new one use "Re-send Credentials" in the table.',
    'create.sedeAuto': 'Location',
    'create.sedeAutoHelp': 'The guest will be registered under the site selected at login.',
    'create.customDuration': 'Custom date',
    'create.preset.30min': '30 min',
    'create.preset.2h': '2 hours',
    'create.preset.4h': '4 hours',
    'create.preset.8h': '8 hours',
    'create.preset.1d': '1 day',
    'create.preset.1w': '1 week',
    'create.endAt': 'Expires at',
    'create.pastDate': 'The expiry date must be in the future.',
    'create.tooLong': 'Maximum duration is 1 week.',
    'create.durationComputed': 'Computed duration',

    'config.title': 'Channel Configuration',
    'config.sensitiveHidden': 'Sensitive fields (passwords) are hidden in standard mode. Click "Admin Mode" to edit them.',
    'config.adminEnable': 'Enable Admin Mode',
    'config.adminDisable': 'Disable Admin Mode',
    'config.adminPrompt': 'Enter admin PIN',
    'config.adminWrongPin': 'Wrong PIN',
    'config.adminPinEnvHint': 'Set via VITE_ADMIN_PIN (default: empty = no PIN required in dev)',
    'config.sms.title': 'SMS Gateway',
    'config.sms.gateway': 'Gateway provider',
    'config.sms.apiKey': 'API Key',
    'config.sms.sender': 'Sender ID',
    'config.sms.webhook': 'Webhook URL',
    'config.wlc.title': 'WLC Controller',
    'config.wlc.status': 'Connection status',
    'config.wlc.account': 'Linked account',
    'config.wlc.ssid': 'WLAN SSID',
    'config.wlc.host': 'Controller IP',
    'config.wlc.port': 'HTTPS Port',
    'config.wlc.test': 'Test Connection',
    'config.save': 'Save',
    'config.saved': 'Configuration saved.',
    'config.sms.textbelt': 'Textbelt',
    'config.sms.sms77': 'SMS77',
    'config.sms.gatewayOption.webhook': 'Custom webhook',
    'config.wlc.online': 'Online',
    'config.wlc.offline': 'Offline',

    'create.emailSent': '✉️ An email with these credentials has been sent to {email}.',

    'config.wlc.connectionError': 'Connection error',

    'login.or': 'or',
    'login.corporateConsole': 'Corporate Console',
    'login.demo.enter': 'Enter Demo Sandbox (without WLC)',
    'login.demo.description': 'Skip WLC login and use local data. Operations requiring the WLC will be recorded as offline.',


    // SSO
    'sso.corporateConsole': 'Single Sign-On',
    'sso.heading': 'Single Sign-On Access',
    'sso.subtitle': 'Authenticate with your Dompé corporate account to access the management console.',
    'sso.loginButton': 'Sign in with SSO',
    'sso.description': 'You will be redirected to the Microsoft Entra ID portal for authentication. Use your corporate credentials.',
    'sso.logout': 'Logout',
    'sso.operator': 'SSO Operator',

    // Break-glass emergency access
    'breakglass.link': 'Emergency access',
    'breakglass.heading': 'Emergency access',
    'breakglass.subtitle': 'Use this only when corporate Single Sign-On is unavailable.',
    'breakglass.warning': 'This login bypasses Single Sign-On and multi-factor authentication. Every attempt is logged and reported to the security team.',
    'breakglass.username': 'Emergency user',
    'breakglass.password': 'Password',
    'breakglass.submit': 'Sign in',
    'breakglass.backToSso': 'Back to SSO sign-in',
    'breakglass.error': 'Invalid credentials, account not enabled, or too many attempts. Contact the security team.',
    'breakglass.badge': 'Emergency',
    'breakglass.banner': 'Emergency session active: Single Sign-On was bypassed. This session is audited and short-lived — sign out as soon as SSO is back.',
    'breakglass.logout': 'Sign out (emergency)',

    // WS notifications
    'app.event': 'Recent event',
    'app.events': '{n} recent events',
    'app.clear': 'Clear',

    'ws.guestExpired': 'Guest {name} expired',
    'ws.label.guest.expired': 'Expired',
    'ws.label.guest.deactivated': 'Disconnected',
    'ws.label.guest.created': 'Registered',
    'ws.label.guest.deleted': 'Deleted',
    'ws.label.guest.imported': 'Imported',
    'ws.label.guest.updated': 'Updated',
    'ws.guestDeactivated': 'Guest {name} disconnected from WLC',
    'ws.guestCreated': 'New guest {name} registered',
    'ws.guestDeleted': 'Guest {name} deleted',
    'ws.guestImported': 'Guest {name} imported from WLC',

    'toast.error': 'Error',
    'toast.success': 'Operation completed',
    'toast.loading': 'Loading...',
    // ── Access pending approval ───────────────────────────────────────────
    'pending.title': 'Access pending approval',
    'pending.description': 'Your account was recognised but has not been enabled yet. An administrator has to assign you a role and the sites you may work on.',
    'pending.yourAccount': 'Your account',
    'pending.contactAdmin': 'Send the address above to the guest portal administrator to get access.',
    'pending.logout': 'Sign out',
    'suspended.title': 'Access suspended',
    'suspended.description': 'Your access has been suspended by an administrator. If you believe this is a mistake, contact them quoting the address below.',
    'sso.error.provisioning': 'Sign-in succeeded but the user record could not be created. Try again; if it persists, contact your administrator.',

    // ── Site selection ────────────────────────────────────────────────────
    'login.sede.noneAssigned': 'No sites are enabled for your account. Contact an administrator.',
    'login.retry': 'Retry',
    'login.error.unreachableSede': 'The {sede} WLC is unreachable.',
    'login.error.credentialMissing': 'Site {sede} is not enabled yet: the controller password is missing from Key Vault.',
    'login.error.sedeInactive': 'Site {sede} is deactivated.',
    'login.error.notConfigured': 'No controller configured for site {sede}.',
    'login.error.forbidden': 'You are not enabled for site {sede}.',

    // ── Roles and user status ─────────────────────────────────────────────
    'role.admin': 'Administrator',
    'role.operator': 'Operator',
    'role.viewer': 'Read only',
    'userStatus.pending': 'Awaiting approval',
    'userStatus.active': 'Active',
    'userStatus.suspended': 'Suspended',

    // ── Administration panel ──────────────────────────────────────────────
    'admin.title': 'Administration',
    'admin.subtitle': 'Users, sites and emergency access',
    'admin.tab.users': 'Users',
    'admin.tab.sedi': 'Sites and WLC',
    'admin.tab.breakglass': 'Emergency',
    'admin.refresh': 'Refresh',
    'admin.users.all': 'All',
    'admin.users.hint': 'Users appear here after their first SSO sign-in, awaiting approval. Until you enable them they cannot do anything.',
    'admin.users.empty': 'No users to show.',
    'admin.users.pendingBadge': 'Awaiting approval',
    'admin.users.autoAdmin': 'Automatic admin',
    'admin.users.autoAdminHelp': 'Administrator by address convention (admin365-...@dompe.onmicrosoft.com): role and status are not editable.',
    'admin.users.you': 'You',
    'admin.users.lastLogin': 'Last sign-in',
    'admin.users.profiledBy': 'approved by',
    'admin.users.role': 'Role',
    'admin.users.status': 'Status',
    'admin.users.sedi': 'Enabled sites',
    'admin.users.adminAllSedi': 'Administrators have access to every site.',
    'admin.users.save': 'Save',

    // ── Sites ─────────────────────────────────────────────────────────────
    'admin.sede.new': 'New site',
    'admin.sede.selectOne': 'Pick a site from the list.',
    'admin.sede.active': 'Active',
    'admin.sede.inactive': 'Deactivated',
    'admin.sede.credential': 'Credential',
    'admin.sede.lastCheck': 'Last test',
    'admin.sede.code': 'Code',
    'admin.sede.codeImmutable': 'Not editable: it links the site to its Key Vault secret.',
    'admin.sede.name': 'Name',
    'admin.sede.city': 'City',
    'admin.sede.address': 'Address',
    'admin.sede.wlcSection': 'WLC controller',
    'admin.sede.host': 'Address / IP',
    'admin.sede.username': 'Admin account',
    'admin.sede.port': 'HTTPS port',
    'admin.sede.sshPort': 'SSH port',
    'admin.sede.ssid': 'Guest network SSID',
    'admin.sede.passwordNote': 'The controller password is not managed here: it lives in Key Vault and is resolved at runtime.',
    'admin.sede.credentialMissing': 'Controller password not configured. Ask the platform team for:',
    'admin.sede.save': 'Save',
    'admin.sede.test': 'Test connection',
    'admin.sede.testOk': 'Connection succeeded',
    'admin.sede.testFailed': 'Connection failed',
    'admin.sede.activate': 'Activate site',
    'admin.sede.deactivate': 'Deactivate site',
    'admin.sede.forceActivate': 'The connection test has never succeeded for this site. Activate it anyway?',
    'admin.sede.delete': 'Delete',
    'admin.sede.confirmDelete': 'Permanently delete site {code}?',

    // ── Break glass ───────────────────────────────────────────────────────
    'admin.bg.cliOnly': 'Emergency accounts are created and their passwords rotated from the CLI only (make breakglass). Here you can enable, disable and unlock them.',
    'admin.bg.empty': 'No emergency accounts configured.',
    'admin.bg.enable': 'Enable',
    'admin.bg.disable': 'Disable',
    'admin.bg.unlock': 'Unlock',
    'admin.bg.lastLogin': 'Last sign-in',
    'admin.bg.failedAttempts': 'failed attempts',
    'admin.bg.expires': 'expires',
    'admin.bg.state.enabled': 'Active',
    'admin.bg.state.disabled': 'Disabled',
    'admin.bg.state.expired': 'Expired',
    'admin.bg.state.locked': 'Locked',
  },
};

function detectInitialLocale(): Locale {
  const stored = (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null) as Locale | null;
  if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'it';
  return nav.toLowerCase().startsWith('en') ? 'en' : 'it';
}

let currentLocale: Locale = detectInitialLocale();
const listeners = new Set<(l: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(l: Locale): void {
  currentLocale = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(l));
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const dict = dictionaries[currentLocale] ?? dictionaries.it;
  let s = dict[key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}

export function useLocale(): [Locale, (l: Locale) => void, (k: string, p?: Record<string, string | number>) => string] {
  const [loc, setLoc] = useState<Locale>(currentLocale);
  useEffect(() => {
    const cb = (l: Locale) => setLoc(l);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);
  const tt = useCallback((k: string, p?: Record<string, string | number>) => t(k, p), [loc]);
  return [loc, setLocale, tt];
}
