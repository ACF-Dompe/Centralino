/**
 * WLC passwords in Key Vault: read, write (which creates the secret for a new
 * site), delete, reload.
 *
 * One secret per site, `WLC-PASSWORD-<CODE>` (see `credentialNamesForSedeCode`).
 * Values read here land in the in-memory cache that `wlcPasswordForSede` checks
 * first, so a password changed from the admin panel — or directly in Key Vault
 * followed by a "reload" — is used from the next controller call, without
 * restarting the container.
 *
 * SECURITY (COMPLIANCE.md D4): these functions handle the controller password
 * in clear. Callers must never log the value, and the HTTP routes that expose
 * them are admin-only and audited.
 */
import { SecretClient } from '@azure/keyvault-secrets';
import { config } from '../config.js';
import { log } from '../logger.js';
import { credentialNamesForSedeCode, listSedi } from '../repositories/index.js';
import { getAzureCredential } from '../utils/azureCredential.js';
import { deleteCachedWlcPassword, setCachedWlcPassword } from '../utils/wlcPasswordCache.js';

/** Raised when `KEY_VAULT_URL` is not set: the routes answer 503. */
export class KeyVaultNotConfiguredError extends Error {
  constructor() {
    super('Key Vault non configurato (KEY_VAULT_URL).');
    this.name = 'KeyVaultNotConfiguredError';
  }
}

export interface WlcReloadResult {
  /** Sites whose password was found in Key Vault. */
  loaded: string[];
  /** Sites with no secret in Key Vault (they fall back to the env var, if any). */
  missing: string[];
  /** Sites that could not be read; the previous value, if any, is kept. */
  failed: { code: string; error: string }[];
}

let _client: SecretClient | null = null;

export function isKeyVaultConfigured(): boolean {
  return config.keyVault.url.length > 0;
}

function getClient(): SecretClient {
  if (!isKeyVaultConfigured()) throw new KeyVaultNotConfiguredError();
  if (!_client) {
    _client = new SecretClient(config.keyVault.url, getAzureCredential());
  }
  return _client;
}

/** Test hook: forget the client so a new mock or URL is picked up. */
export function resetKeyVaultClient(): void {
  _client = null;
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === 'SecretNotFound';
}

/**
 * Key Vault keeps a deleted secret, soft-deleted, for the vault's retention
 * period, and refuses a new value under that name until it is recovered or
 * purged. This is what a site recreated with the code of a deleted one meets.
 */
function isDeletedButRecoverable(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  return e?.statusCode === 409 && /deleted but recoverable/i.test(e?.message ?? '');
}

/** A short, loggable description of an SDK error — never a secret value. */
export function describeKeyVaultError(err: unknown): string {
  const e = err as { statusCode?: number; code?: string; message?: string } | null;
  const parts = [e?.statusCode, e?.code].filter((p) => p != null && p !== '');
  const message = (e?.message ?? String(err)).split('\n')[0].slice(0, 300);
  return parts.length > 0 ? `${parts.join(' ')}: ${message}` : message;
}

/**
 * Read a site's password from Key Vault, live, and refresh the cache with it.
 * Returns null when the secret does not exist (the cache entry is dropped).
 */
export async function readWlcPasswordFromVault(code: string): Promise<string | null> {
  const { secretName } = credentialNamesForSedeCode(code);
  try {
    const secret = await getClient().getSecret(secretName);
    const value = secret.value ?? '';
    if (value.length === 0) {
      deleteCachedWlcPassword(code);
      return null;
    }
    setCachedWlcPassword(code, value);
    return value;
  } catch (err) {
    if (isNotFound(err)) {
      deleteCachedWlcPassword(code);
      return null;
    }
    throw err;
  }
}

/**
 * Store a password for a site in Key Vault and use it from now on: it creates
 * the secret for a new site, and adds a version to an existing one. The
 * controller itself is not touched: the password must already be set there.
 *
 * A secret left soft-deleted by a deleted site with the same code is
 * recovered first (its old versions come back with it), rather than purged:
 * purging is irreversible, and recovering needs no more than Secrets Officer.
 */
export async function writeWlcPasswordToVault(code: string, password: string): Promise<void> {
  const { secretName } = credentialNamesForSedeCode(code);
  const client = getClient();
  try {
    await client.setSecret(secretName, password, { contentType: 'text/plain' });
  } catch (err) {
    if (!isDeletedButRecoverable(err)) throw err;
    log.warn({ code, secretName }, 'Recovering a soft-deleted WLC secret before writing it');
    const poller = await client.beginRecoverDeletedSecret(secretName);
    await poller.pollUntilDone();
    await client.setSecret(secretName, password, { contentType: 'text/plain' });
  }
  setCachedWlcPassword(code, password);
}

/**
 * Delete a site's secret from Key Vault and forget it.
 *
 * Soft delete only: the vault keeps it recoverable for its retention period,
 * and a site later recreated with the same code recovers it (see
 * `writeWlcPasswordToVault`). Waits for the deletion to finish, so that such a
 * recreation does not find the name still "being deleted".
 */
export async function deleteWlcPasswordFromVault(code: string): Promise<'deleted' | 'not_found'> {
  const { secretName } = credentialNamesForSedeCode(code);
  try {
    const poller = await getClient().beginDeleteSecret(secretName);
    await poller.pollUntilDone();
  } catch (err) {
    if (!isNotFound(err)) throw err;
    deleteCachedWlcPassword(code);
    return 'not_found';
  }
  deleteCachedWlcPassword(code);
  return 'deleted';
}

/**
 * Re-read the password of every site from Key Vault.
 *
 * One failing site does not stop the others, and does not wipe the value it
 * had: a transient Key Vault error must not take a working controller offline.
 */
export async function reloadWlcPasswords(): Promise<WlcReloadResult> {
  getClient(); // fail fast, before touching the database, when not configured
  const sedi = await listSedi();
  const result: WlcReloadResult = { loaded: [], missing: [], failed: [] };

  type Outcome = { code: string; found: boolean } | { code: string; error: string };
  const outcomes = await Promise.all(
    sedi.map(async (s): Promise<Outcome> => {
      try {
        const value = await readWlcPasswordFromVault(s.code);
        return { code: s.code, found: value != null };
      } catch (err) {
        return { code: s.code, error: describeKeyVaultError(err) };
      }
    }),
  );

  for (const o of outcomes) {
    if ('error' in o) result.failed.push({ code: o.code, error: o.error });
    else if (o.found) result.loaded.push(o.code);
    else result.missing.push(o.code);
  }
  return result;
}

/**
 * Startup hook: load every site's password from Key Vault when it is
 * configured. Never throws — the environment variables remain as a fallback,
 * and a Key Vault outage must not stop the backend from starting.
 */
export async function initWlcPasswords(): Promise<void> {
  if (!isKeyVaultConfigured()) {
    log.info('KEY_VAULT_URL not set: WLC passwords come from the environment only');
    return;
  }
  try {
    const r = await reloadWlcPasswords();
    if (r.failed.length > 0) {
      log.warn({ loaded: r.loaded, missing: r.missing, failed: r.failed }, 'Some WLC passwords could not be read from Key Vault');
    } else {
      log.info({ loaded: r.loaded, missing: r.missing }, 'WLC passwords loaded from Key Vault');
    }
  } catch (err) {
    log.warn({ err: describeKeyVaultError(err) }, 'Could not load WLC passwords from Key Vault; using the environment');
  }
}
