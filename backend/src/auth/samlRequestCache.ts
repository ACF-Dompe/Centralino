/**
 * PostgreSQL-backed cache of outstanding SAML AuthnRequest IDs.
 *
 * node-saml records the ID of every AuthnRequest it generates and, when the
 * IdP posts the response back, checks that the response's `InResponseTo`
 * refers to one of them. That is genuine replay protection and worth keeping.
 *
 * Its default `InMemoryCacheProvider` cannot do the job here, and says so in
 * its own documentation: "For multiple server instances/load balanced
 * scenarios (I.e. the SAML request could have been generated from a different
 * server/process handling the SAML response) this implementation will NOT be
 * sufficient." Two things break it in Container Apps:
 *
 *   - a container restart between the click on "Sign in" and the IdP posting
 *     back — a deploy, a scaling event or a health-probe restart is enough;
 *   - more than one replica, where the response can simply land elsewhere.
 *
 * Either way the user gets `InResponseTo is not valid` and no way to recover
 * except trying again and hoping. Persisting the IDs in the database the app
 * already owns makes the check survive restarts and work across replicas.
 *
 * The rows are tiny and short-lived: one per login attempt, pruned past the
 * expiration window.
 */
import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import { createDbPool } from '../db/index.js';
import { log } from '../logger.js';
import type pg from 'pg';

/** How often to sweep expired rows, regardless of how many logins happen. */
const PRUNE_INTERVAL_MS = 60_000;

interface RequestIdRow {
  value: string;
}

/**
 * Build the cache provider.
 *
 * @param expirationPeriodMs - how long an AuthnRequest ID stays valid. Must
 *   match the strategy's `requestIdExpirationPeriodMs`.
 */
export function createSamlRequestCache(expirationPeriodMs: number): CacheProvider {
  /**
   * A dedicated, very small pool — this is touched twice per login attempt.
   *
   * Created lazily so that building a SAML strategy stays free of I/O: an
   * eager pool would make `createSamlStrategy` depend on a reachable
   * DATABASE_URL at construction time, which is both a surprising coupling and
   * a needless way to fail startup.
   */
  let pool: pg.Pool | null = null;
  function getPool(): pg.Pool {
    pool ??= createDbPool({ max: 2 });
    return pool;
  }

  let lastPrune = 0;

  /**
   * Delete expired rows. Best-effort and time-boxed: a failure here must never
   * fail a login, and the age check in `getAsync` is what actually enforces
   * expiry, so a missed prune only leaves dead rows behind.
   */
  async function pruneExpired(): Promise<void> {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    try {
      await getPool().query(
        `DELETE FROM saml_request_ids
          WHERE created_at < NOW() - ($1 || ' milliseconds')::INTERVAL`,
        [String(expirationPeriodMs)],
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Could not prune expired SAML request IDs');
    }
  }

  return {
    /**
     * Record a newly generated AuthnRequest ID.
     * Returns null when the key already exists, matching the in-memory
     * provider's contract.
     */
    async saveAsync(key: string, value: string): Promise<CacheItem | null> {
      void pruneExpired();
      const res = await getPool().query(
        `INSERT INTO saml_request_ids (id, value)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING value, created_at`,
        [key, value],
      );
      const rows = res.rows as { value: string; created_at: string | Date }[];
      if (rows.length === 0) {
        return null;
      }
      const createdAt = rows[0].created_at;
      return {
        value: rows[0].value,
        createdAt: (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime(),
      };
    },

    /**
     * Look up an ID, treating anything past the expiration window as absent.
     * The age check lives in SQL so it cannot drift from a prune that has not
     * run yet.
     */
    async getAsync(key: string): Promise<string | null> {
      const res = await getPool().query(
        `SELECT value FROM saml_request_ids
          WHERE id = $1
            AND created_at >= NOW() - ($2 || ' milliseconds')::INTERVAL`,
        [key, String(expirationPeriodMs)],
      );
      const rows = res.rows as RequestIdRow[];
      return rows.length > 0 ? rows[0].value : null;
    },

    /**
     * Consume an ID. node-saml calls this after a successful validation and
     * also from its error path, so an ID is spent either way — which is
     * correct for replay protection, and the reason a retried login must
     * always start from /api/auth/login rather than by re-posting a response.
     */
    async removeAsync(key: string | null): Promise<string | null> {
      if (key === null) return null;
      const res = await getPool().query(
        `DELETE FROM saml_request_ids WHERE id = $1 RETURNING id`,
        [key],
      );
      return (res.rowCount ?? 0) > 0 ? key : null;
    },
  };
}
