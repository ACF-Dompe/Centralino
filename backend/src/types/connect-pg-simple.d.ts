/**
 * Minimal type declaration for `connect-pg-simple`.
 * The package internally accesses `session.Store` (the Store class
 * constructor from express-session), so we accept an object with
 * a Store property rather than the session function itself.
 */
declare module 'connect-pg-simple' {
  import { Store } from 'express-session';
  import type { Pool } from 'pg';

  interface PgStoreOptions {
    conString?: string;
    pool?: Pool;
    schemaName?: string;
    tableName?: string;
    createTableIfMissing?: boolean;
    errorLog?: (...args: unknown[]) => void;
    pruneSessionInterval?: number;
    ttl?: number;
  }

  function pgSession(session: { Store: typeof Store }): new (options?: PgStoreOptions) => Store;
  export default pgSession;
}
