/**
 * Live search of the Entra ID directory, for the "Referente" field.
 *
 * Every call goes to Microsoft Graph: nothing is cached here or in the
 * browser, so a person added to (or removed from) the tenant shows up at the
 * next keystroke.
 *
 * Authenticates as the backend's managed identity (`getAzureCredential`), which
 * needs the Graph application permission `User.Read.All` with admin consent.
 *
 * Only the display name leaves the backend (plus the object id, used by the UI
 * as a list key): the fewer directory attributes an operator's browser sees,
 * the less there is to leak.
 */
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { config } from '../config.js';
import { getAzureCredential } from '../utils/azureCredential.js';

export interface DirectoryUser {
  id: string;
  displayName: string;
}

/** Raised when the search is switched off: the route answers 503. */
export class DirectoryDisabledError extends Error {
  constructor() {
    super('Ricerca nella directory non abilitata.');
    this.name = 'DirectoryDisabledError';
  }
}

interface GraphUser {
  id?: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
}

let _client: Client | null = null;

function getClient(): Client {
  if (!_client) {
    const authProvider = new TokenCredentialAuthenticationProvider(getAzureCredential(), {
      scopes: ['https://graph.microsoft.com/.default'],
    });
    _client = Client.initWithMiddleware({ authProvider });
  }
  return _client;
}

/** Test hook: forget the Graph client so a new mock is picked up. */
export function resetDirectoryClient(): void {
  _client = null;
}

/** Quote a value for an OData string literal: single quotes are doubled. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the Graph `$filter`: the text is a prefix of the display name, first
 * name, surname, mail or UPN; the UPN is on one of the allowed domains; the
 * account is enabled. `endswith` is an advanced query, hence the
 * `ConsistencyLevel: eventual` header and `$count` in the request.
 */
export function buildDirectoryFilter(query: string, domains: string[]): string {
  const q = odataString(query);
  const text = ['displayName', 'givenName', 'surname', 'mail', 'userPrincipalName']
    .map((field) => `startswith(${field},${q})`)
    .join(' or ');
  const domain = domains
    .map((d) => `endswith(userPrincipalName,${odataString('@' + d)})`)
    .join(' or ');
  return `(${text}) and (${domain}) and accountEnabled eq true`;
}

function hasAllowedDomain(upn: string | null | undefined, domains: string[]): boolean {
  if (!upn) return false;
  const lower = upn.toLowerCase();
  return domains.some((d) => lower.endsWith('@' + d));
}

/**
 * Search users by name, surname or email. The caller validates the query
 * (length, control characters); this function only escapes it.
 */
export async function searchDirectoryUsers(query: string): Promise<DirectoryUser[]> {
  const cfg = config.directory;
  if (!cfg.enabled) throw new DirectoryDisabledError();
  if (cfg.upnDomains.length === 0) return [];

  const response = (await getClient()
    .api('/users')
    .header('ConsistencyLevel', 'eventual')
    .count(true)
    .filter(buildDirectoryFilter(query, cfg.upnDomains))
    .select(['id', 'displayName', 'userPrincipalName'])
    .orderby('displayName')
    .top(cfg.maxResults)
    .get()) as { value?: GraphUser[] };

  // The domain is checked again on the way out: the Graph filter is the
  // efficient place to apply it, this is the place that cannot be wrong.
  return (response.value ?? [])
    .filter((u) => hasAllowedDomain(u.userPrincipalName, cfg.upnDomains))
    .filter((u): u is GraphUser & { id: string; displayName: string } => !!u.id && !!u.displayName)
    .map((u) => ({ id: u.id, displayName: u.displayName }));
}
