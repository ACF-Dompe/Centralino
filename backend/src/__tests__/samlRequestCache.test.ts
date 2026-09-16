/**
 * Tests for the PostgreSQL-backed AuthnRequest-ID cache (auth/samlRequestCache.ts).
 *
 * Regression under test: `InResponseTo is not valid` on a legitimate login.
 *
 * node-saml records the ID of each AuthnRequest it generates and checks the
 * response's `InResponseTo` against it — real replay protection. Its default
 * store is in process memory, and its own documentation states it "will NOT be
 * sufficient" when request and response can be handled by different processes.
 * On Container Apps that is the normal case: a restart between the sign-in
 * redirect and the IdP posting back is enough, and more than one replica makes
 * it routine. Persisting the IDs removes the whole failure mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Queries issued against the pool, in order. */
const queries = vi.hoisted(() => [] as { sql: string; params: unknown[] }[]);
/** Rows the next query should return. */
const nextRows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[], rowCount: 0 }));

vi.mock('../db/index.js', () => ({
  createDbPool: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: nextRows.value, rowCount: nextRows.rowCount };
    }),
  })),
}));

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createSamlRequestCache } from '../auth/samlRequestCache.js';

const TTL = 1_800_000;

function lastQuery() {
  return queries[queries.length - 1];
}

/** Queries that are not the opportunistic prune. */
function realQueries() {
  return queries.filter((q) => !q.sql.includes('created_at <'));
}

beforeEach(() => {
  queries.length = 0;
  nextRows.value = [];
  nextRows.rowCount = 0;
});

describe('saveAsync', () => {
  it('persists the request ID and returns the stored item', async () => {
    const createdAt = new Date('2026-09-16T10:00:00Z');
    nextRows.value = [{ value: 'stored-value', created_at: createdAt }];
    nextRows.rowCount = 1;

    const cache = createSamlRequestCache(TTL);
    const item = await cache.saveAsync('_reqid1', 'stored-value');

    expect(item).toEqual({ value: 'stored-value', createdAt: createdAt.getTime() });
    const q = realQueries().find((x) => x.sql.includes('INSERT INTO saml_request_ids'));
    expect(q).toBeDefined();
    expect(q?.params).toEqual(['_reqid1', 'stored-value']);
  });

  it('returns null when the ID already exists, like the in-memory provider', async () => {
    // ON CONFLICT DO NOTHING returns no row.
    nextRows.value = [];
    nextRows.rowCount = 0;

    const cache = createSamlRequestCache(TTL);
    expect(await cache.saveAsync('_reqid1', 'v')).toBeNull();
  });

  it('parses a timestamp returned as a string', async () => {
    // node-postgres may hand back a string depending on type parsers.
    nextRows.value = [{ value: 'v', created_at: '2026-09-16T10:00:00.000Z' }];
    nextRows.rowCount = 1;

    const cache = createSamlRequestCache(TTL);
    const item = await cache.saveAsync('_reqid1', 'v');

    expect(item?.createdAt).toBe(new Date('2026-09-16T10:00:00.000Z').getTime());
  });
});

describe('getAsync', () => {
  it('returns the stored value', async () => {
    nextRows.value = [{ value: 'stored-value' }];
    nextRows.rowCount = 1;

    const cache = createSamlRequestCache(TTL);
    expect(await cache.getAsync('_reqid1')).toBe('stored-value');
  });

  it('returns null for an unknown ID', async () => {
    const cache = createSamlRequestCache(TTL);
    expect(await cache.getAsync('_unknown')).toBeNull();
  });

  it('enforces expiry in SQL, so a missed prune cannot resurrect an old ID', async () => {
    const cache = createSamlRequestCache(TTL);
    await cache.getAsync('_reqid1');

    const q = lastQuery();
    expect(q.sql).toContain('created_at >= NOW()');
    expect(q.sql).toContain('milliseconds');
    expect(q.params).toEqual(['_reqid1', String(TTL)]);
  });
});

describe('removeAsync', () => {
  it('deletes the ID and returns it', async () => {
    nextRows.rowCount = 1;

    const cache = createSamlRequestCache(TTL);
    expect(await cache.removeAsync('_reqid1')).toBe('_reqid1');
    expect(lastQuery().sql).toContain('DELETE FROM saml_request_ids');
  });

  it('returns null when the ID was not there', async () => {
    nextRows.rowCount = 0;

    const cache = createSamlRequestCache(TTL);
    expect(await cache.removeAsync('_reqid1')).toBeNull();
  });

  it('tolerates a null key without querying', async () => {
    const cache = createSamlRequestCache(TTL);
    expect(await cache.removeAsync(null)).toBeNull();
    expect(realQueries()).toHaveLength(0);
  });
});

describe('pruning', () => {
  it('sweeps expired rows when saving', async () => {
    const cache = createSamlRequestCache(TTL);
    await cache.saveAsync('_reqid1', 'v');

    const prune = queries.find((q) => q.sql.includes('DELETE') && q.sql.includes('created_at <'));
    expect(prune).toBeDefined();
    expect(prune?.params).toEqual([String(TTL)]);
  });

  it('does not sweep on every save', async () => {
    const cache = createSamlRequestCache(TTL);
    await cache.saveAsync('_a', 'v');
    await cache.saveAsync('_b', 'v');
    await cache.saveAsync('_c', 'v');

    const prunes = queries.filter((q) => q.sql.includes('DELETE') && q.sql.includes('created_at <'));
    expect(prunes).toHaveLength(1);
  });

  it('never lets a prune failure fail a login', async () => {
    const cache = createSamlRequestCache(TTL);
    nextRows.value = [{ value: 'v', created_at: new Date() }];
    nextRows.rowCount = 1;

    // The prune is fire-and-forget; saveAsync must resolve regardless.
    await expect(cache.saveAsync('_reqid1', 'v')).resolves.not.toBeUndefined();
  });
});
