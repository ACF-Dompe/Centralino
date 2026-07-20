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
    'login.password': 'Password amministratore',
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
    'header.disconnect': 'Disconnetti',
    'header.language': 'Lingua',

    // Stats
    'stats.registered': 'Registrati',
    'stats.online': 'Connessi Ora',
    'stats.pending': 'In attesa',
    'stats.completed': 'Conclusi',

    // Toolbar
    'toolbar.search': 'Cerca per nome, email, azienda, host, username...',
    'toolbar.statusAll': 'Tutti',
    'toolbar.config': 'Configura Canali',
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
    'table.badge': 'Invia Badge',
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
    'modal.guest': 'Ospite',
    'modal.tab.badge': 'Stampa Badge',
    'modal.tab.sms': 'SMS Cellulare',
    'modal.tab.email': 'Email Corporate',
    'modal.badge.title': 'BADGE DI ACCESSO OSPITI',
    'modal.badge.network': 'Rete Wi-Fi',
    'modal.badge.username': 'Username',
    'modal.badge.password': 'Password',
    'modal.badge.duration': 'Durata accesso',
    'modal.badge.host': 'Referente',
    'modal.badge.print': 'Stampa Badge',
    'modal.sms.recipient': 'Destinatario',
    'modal.sms.notSet': 'Numero di telefono non impostato per questo ospite.',
    'modal.sms.send': 'Invia SMS',
    'modal.sms.sending': 'Invio in corso...',
    'modal.sms.sent': 'SMS inviato correttamente',
    'modal.email.from': 'Mittente',
    'modal.email.to': 'Destinatario',
    'modal.email.subject': 'Oggetto',
    'modal.email.body': 'Messaggio',
    'modal.email.send': 'Invia Email',
    'modal.email.sending': 'Invio in corso...',
    'modal.email.sent': 'Email inviata correttamente',
    'modal.notAvailable': '(non disponibile)',
    'modal.close': 'Chiudi',
    'modal.email.defaultSubject': 'Abilitazione Password Wi-Fi Ospiti',
    'modal.email.defaultBody': 'Gentile ospite, di seguito le credenziali per accedere alla rete Wi-Fi {ssid}.',
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
    'create.oneTimePasswordHelp': 'Copia questa password e comunicala all\'ospite. Non è salvata nel database: per re-inviarla usa "Re-invia Credenziali" nella tabella.',
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
    'config.smtp.title': 'Server SMTP (Email)',
    'config.smtp.host': 'Server SMTP',
    'config.smtp.port': 'Porta',
    'config.smtp.sender': 'Mittente',
    'config.smtp.encryption': 'Crittografia',
    'config.smtp.requireAuth': 'Richiedi autenticazione',
    'config.smtp.username': 'Username SMTP',
    'config.smtp.password': 'Password SMTP',
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
    'config.wlc.disconnect': 'Disconnetti',
    'config.wlc.password': 'Password WLC',
    'config.save': 'Salva',
    'config.saved': 'Configurazione salvata.',
    'config.enc.none': 'Nessuna',
    'config.enc.starttls': 'STARTTLS',
    'config.enc.ssl': 'SSL',
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
    'modal.badge.durationLabel': 'Durata',
    'modal.badge.hostLabel': 'Referente',

    // SSO
    'sso.corporateConsole': 'Single Sign-On',
    'sso.heading': 'Accesso con Single Sign-On',
    'sso.subtitle': 'Autenticati con il tuo account aziendale Dompé per accedere alla console di gestione.',
    'sso.loginButton': 'Accedi con SSO',
    'sso.description': 'Verrai reindirizzato al portale Microsoft Entra ID per l\'autenticazione. Utilizza le tue credenziali aziendali.',
    'sso.logout': 'Logout SSO',
    'sso.operator': 'Operatore SSO',

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
    'login.password': 'Admin password',
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
    'header.disconnect': 'Disconnect',
    'header.language': 'Language',

    'stats.registered': 'Registered',
    'stats.online': 'Online Now',
    'stats.pending': 'Pending',
    'stats.completed': 'Completed',

    'toolbar.search': 'Search by name, email, company, host, username...',
    'toolbar.statusAll': 'All',
    'toolbar.config': 'Configure Channels',
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
    'table.badge': 'Send Badge',
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

    'modal.guest': 'Guest',
    'modal.tab.badge': 'Print Badge',
    'modal.tab.sms': 'Mobile SMS',
    'modal.tab.email': 'Corporate Email',
    'modal.badge.title': 'GUEST ACCESS BADGE',
    'modal.badge.network': 'Wi-Fi Network',
    'modal.badge.username': 'Username',
    'modal.badge.password': 'Password',
    'modal.badge.duration': 'Access duration',
    'modal.badge.host': 'Sponsor',
    'modal.badge.print': 'Print Badge',
    'modal.sms.recipient': 'Recipient',
    'modal.sms.notSet': 'No phone number set for this guest.',
    'modal.sms.send': 'Send SMS',
    'modal.sms.sending': 'Sending...',
    'modal.sms.sent': 'SMS sent successfully',
    'modal.email.from': 'From',
    'modal.email.to': 'To',
    'modal.email.subject': 'Subject',
    'modal.email.body': 'Message',
    'modal.email.send': 'Send Email',
    'modal.email.sending': 'Sending...',
    'modal.email.sent': 'Email sent successfully',
    'modal.notAvailable': '(not available)',
    'modal.close': 'Close',
    'modal.email.defaultSubject': 'Guest Wi-Fi Password Enablement',
    'modal.email.defaultBody': 'Dear guest, below are the credentials to access the {ssid} Wi-Fi network.',
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
    'create.oneTimePasswordHelp': 'Copy this password and share it with the guest. It is not stored in the database: to re-send it use "Re-send Credentials" in the table.',
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
    'config.smtp.title': 'SMTP Server (Email)',
    'config.smtp.host': 'SMTP server',
    'config.smtp.port': 'Port',
    'config.smtp.sender': 'Sender',
    'config.smtp.encryption': 'Encryption',
    'config.smtp.requireAuth': 'Require authentication',
    'config.smtp.username': 'SMTP username',
    'config.smtp.password': 'SMTP password',
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
    'config.wlc.disconnect': 'Disconnect',
    'config.wlc.password': 'WLC password',
    'config.save': 'Save',
    'config.saved': 'Configuration saved.',
    'config.enc.none': 'None',
    'config.enc.starttls': 'STARTTLS',
    'config.enc.ssl': 'SSL',
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

    'modal.badge.durationLabel': 'Duration',
    'modal.badge.hostLabel': 'Sponsor',

    // SSO
    'sso.corporateConsole': 'Single Sign-On',
    'sso.heading': 'Single Sign-On Access',
    'sso.subtitle': 'Authenticate with your Dompé corporate account to access the management console.',
    'sso.loginButton': 'Sign in with SSO',
    'sso.description': 'You will be redirected to the Microsoft Entra ID portal for authentication. Use your corporate credentials.',
    'sso.logout': 'SSO Logout',
    'sso.operator': 'SSO Operator',

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
