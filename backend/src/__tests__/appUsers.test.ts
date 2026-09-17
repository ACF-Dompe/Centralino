/**
 * Tests for the application user directory repository.
 *
 * The assertions here are deliberately about the SQL text in places. Two
 * properties of the just-in-time provisioning statement are load-bearing and
 * invisible from the outside, so they are pinned where they can be seen:
 *
 *   - Signing in must never change a role or a status. Profiling is an
 *     administrative act; this statement runs on the authentication path.
 *   - The upsert must stay a single statement, so two concurrent logins cannot
 *     race. `DbClient` hands out no transaction to fall back on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../db/index.js';

vi.mock('../db/index.js', () => ({ getDb: vi.fn() }));

import {
  isAutoAdmin,
  samlSubject,
  upsertAppUserFromSaml,
  getAppUserBySubject,
  listAppUsers,
  updateAppUserProfile,
  replaceAppUserSedi,
  countActiveAdmins,
  deleteAppUser,
} from '../repositories/appUsers.js';
import type { SamlUser } from '../auth/saml.js';

/** Records every statement so the tests can assert on the SQL itself. */
function fakeDb(rows: unknown[] = []): DbClient & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    driver: 'postgres',
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as DbClient & { calls: Array<{ sql: string; params?: unknown[] }> };
}

function user(overrides: Partial<SamlUser> = {}): SamlUser {
  return {
    authMethod: 'saml',
    nameID: 'mario.rossi@dompe.com',
    upn: 'mario.rossi@dompe.com',
    email: 'Mario.Rossi@dompe.com',
    displayName: 'Mario Rossi',
    givenName: 'Mario',
    surname: 'Rossi',
    objectId: 'oid-123',
    raw: {},
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('samlSubject', () => {
  /**
   * The objectId is the right key — it survives a change of surname or mail
   * domain — but the claim is only present when the tenant releases it, and
   * this one has had claims go missing before. Falling back beats refusing to
   * provision anybody.
   */
  it('prefers the Entra objectId', () => {
    expect(samlSubject(user())).toBe('oid-123');
  });

  it('falls back to a normalised mail address', () => {
    expect(samlSubject(user({ objectId: null }))).toBe('email:mario.rossi@dompe.com');
  });

  it('falls back to the nameID when there is no mail either', () => {
    expect(samlSubject(user({ objectId: null, email: '' }))).toBe('nameid:mario.rossi@dompe.com');
  });

  it('returns null when the assertion identifies nobody', () => {
    expect(samlSubject(user({ objectId: null, email: '', nameID: '' }))).toBeNull();
  });

  it('ignores whitespace-only claims', () => {
    expect(samlSubject(user({ objectId: '   ' }))).toBe('email:mario.rossi@dompe.com');
  });
});

describe('upsertAppUserFromSaml', () => {
  const returned = [{ subject: 'oid-123', role: 'viewer', status: 'pending', created: true }];

  it('creates a new user blocked and with the lowest role', async () => {
    const db = fakeDb(returned);
    const result = await upsertAppUserFromSaml(user(), db);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO app_users'))!;
    expect(insert.sql).toContain("'viewer'");
    expect(insert.sql).toContain("'pending'");
    expect(result).toMatchObject({ created: true, role: 'viewer', status: 'pending' });
  });

  /**
   * The single most important assertion in this file. If a login could write
   * `role` or `status`, every sign-in would undo the administrator's decision.
   */
  it('never writes role or status when the user already exists', async () => {
    const db = fakeDb(returned);
    await upsertAppUserFromSaml(user(), db);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO app_users'))!;
    const doUpdate = insert.sql.slice(insert.sql.indexOf('DO UPDATE'));
    expect(doUpdate).not.toMatch(/\brole\s*=/);
    expect(doUpdate).not.toMatch(/\bstatus\s*=/);
    // …while the profile data is still refreshed.
    expect(doUpdate).toMatch(/display_name\s*=/);
    expect(doUpdate).toMatch(/last_login_at\s*=/);
  });

  /**
   * One statement, so two concurrent logins — two tabs, two replicas, an ACS
   * posted twice — cannot both read "absent" and both insert.
   */
  it('resolves the race inside a single ON CONFLICT statement', async () => {
    const db = fakeDb(returned);
    await upsertAppUserFromSaml(user(), db);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO app_users'))!;
    expect(insert.sql).toContain('ON CONFLICT (subject)');
    expect(db.calls.some((c) => /^\s*(BEGIN|COMMIT)/i.test(c.sql))).toBe(false);
  });

  it('reports whether the row was newly created', async () => {
    const db = fakeDb([{ subject: 'oid-123', role: 'operator', status: 'active', created: false }]);
    const result = await upsertAppUserFromSaml(user(), db);
    expect(result.created).toBe(false);
    expect(result.role).toBe('operator');
  });

  /**
   * Claims an entry created while the objectId claim was unavailable, so a
   * tenant starting to release it does not orphan somebody's profiling.
   */
  it('adopts a pre-existing mail-keyed row when an objectId appears', async () => {
    const db = fakeDb(returned);
    await upsertAppUserFromSaml(user(), db);

    const adopt = db.calls.find((c) => c.sql.includes('UPDATE app_users'));
    expect(adopt).toBeDefined();
    expect(adopt!.sql).toContain('entra_object_id IS NULL');
    expect(adopt!.params).toEqual(['oid-123', 'email:mario.rossi@dompe.com']);
  });

  it('skips the adoption statement when no objectId was released', async () => {
    const db = fakeDb(returned);
    await upsertAppUserFromSaml(user({ objectId: null }), db);
    expect(db.calls.some((c) => c.sql.includes('UPDATE app_users'))).toBe(false);
  });

  /**
   * The one deliberate exception to "a login never changes a role": an address
   * matching the platform-administrator convention is promoted on every login.
   * It is written to the directory rather than only derived at request time so
   * the admin panel shows the truth and `countActiveAdmins` counts these
   * accounts — otherwise the last-administrator guard would believe there were
   * none.
   */
  describe('platform-administrator convention', () => {
    const autoAdmin = user({ email: 'admin365-tommaso@dompe.onmicrosoft.com' });

    it('promotes a matching address', async () => {
      const db = fakeDb([{ subject: 'oid-123', role: 'viewer', status: 'pending', created: true }]);
      const result = await upsertAppUserFromSaml(autoAdmin, db);

      const promote = db.calls.find((c) => c.sql.includes("SET role = 'admin'"));
      expect(promote).toBeDefined();
      expect(promote!.sql).toContain("status = 'active'");
      expect(result).toMatchObject({ role: 'admin', status: 'active', autoAdmin: true });
    });

    it('does not promote an ordinary address', async () => {
      const db = fakeDb([{ subject: 'oid-123', role: 'viewer', status: 'pending', created: true }]);
      const result = await upsertAppUserFromSaml(user(), db);

      expect(db.calls.some((c) => c.sql.includes("SET role = 'admin'"))).toBe(false);
      expect(result).toMatchObject({ role: 'viewer', status: 'pending', autoAdmin: false });
    });

    it('does not promote the prefix on another domain', async () => {
      const db = fakeDb([{ subject: 'oid-123', role: 'viewer', status: 'pending', created: true }]);
      const result = await upsertAppUserFromSaml(user({ email: 'admin365-x@attacker.com' }), db);

      expect(db.calls.some((c) => c.sql.includes("SET role = 'admin'"))).toBe(false);
      expect(result.autoAdmin).toBe(false);
    });

    /** Nothing to write when the row already agrees. */
    it('skips the promotion when the row is already admin and active', async () => {
      const db = fakeDb([{ subject: 'oid-123', role: 'admin', status: 'active', created: false }]);
      await upsertAppUserFromSaml(autoAdmin, db);

      expect(db.calls.some((c) => c.sql.includes("SET role = 'admin'"))).toBe(false);
    });
  });

  it('refuses an assertion that identifies nobody', async () => {
    const db = fakeDb(returned);
    await expect(
      upsertAppUserFromSaml(user({ objectId: null, email: '', nameID: '' }), db),
    ).rejects.toThrow(/objectId/);
    expect(db.calls).toHaveLength(0);
  });
});

describe('reads', () => {
  const row = {
    id: '7',
    subject: 'oid-123',
    entra_object_id: 'oid-123',
    email: 'mario.rossi@dompe.com',
    display_name: 'Mario Rossi',
    given_name: 'Mario',
    surname: 'Rossi',
    role: 'operator',
    status: 'active',
    sede_ids: ['1', '3'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    profiled_at: null,
    profiled_by: null,
  };

  it('maps a row to the domain shape', async () => {
    const record = await getAppUserBySubject('oid-123', fakeDb([row]));
    expect(record).toMatchObject({ id: 7, role: 'operator', status: 'active', sedeIds: [1, 3] });
  });

  it('flags a row whose address matches the administrator convention', async () => {
    const plain = await getAppUserBySubject('oid-123', fakeDb([row]));
    expect(plain?.autoAdmin).toBe(false);

    const auto = await getAppUserBySubject(
      'oid-123',
      fakeDb([{ ...row, email: 'admin365-x@dompe.onmicrosoft.com' }]),
    );
    expect(auto?.autoAdmin).toBe(true);
  });

  it('returns an empty grant list rather than null', async () => {
    const record = await getAppUserBySubject('oid-123', fakeDb([{ ...row, sede_ids: null }]));
    expect(record?.sedeIds).toEqual([]);
  });

  it('returns null when the subject is unknown', async () => {
    expect(await getAppUserBySubject('nobody', fakeDb([]))).toBeNull();
  });

  it('filters by status', async () => {
    const db = fakeDb([]);
    await listAppUsers({ status: 'pending' }, db);
    expect(db.calls[0].sql).toContain('u.status = $1');
    expect(db.calls[0].params).toEqual(['pending']);
  });

  /** Awaiting approval is the reason an admin opens this screen. */
  it('lists users awaiting approval first', async () => {
    const db = fakeDb([]);
    await listAppUsers(undefined, db);
    expect(db.calls[0].sql).toMatch(/CASE u\.status WHEN 'pending' THEN 0/);
  });
});

describe('writes', () => {
  it('stamps who profiled the user and when', async () => {
    const db = fakeDb([]);
    await updateAppUserProfile(7, { role: 'operator', profiledBy: 'admin@dompe.com' }, db);

    const update = db.calls[0];
    expect(update.sql).toContain('profiled_by = $2');
    expect(update.sql).toContain('profiled_at = NOW()');
    expect(update.params).toContain('admin@dompe.com');
  });

  /**
   * Replacing the grants has to be one statement: the pool hands out no
   * transaction, so a DELETE followed by an INSERT could lose a user's sites
   * entirely if the second half failed.
   */
  it('replaces the granted sites in a single statement', async () => {
    const db = fakeDb([]);
    await replaceAppUserSedi(7, [1, 2], db);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('WITH removed AS');
    expect(db.calls[0].params).toEqual([7, [1, 2]]);
  });

  it('clears every grant when given an empty list', async () => {
    const db = fakeDb([]);
    await replaceAppUserSedi(7, [], db);
    expect(db.calls[0].params).toEqual([7, []]);
  });

  it('de-duplicates and drops non-integer site ids', async () => {
    const db = fakeDb([]);
    await replaceAppUserSedi(7, [1, 1, 2, Number.NaN], db);
    expect(db.calls[0].params).toEqual([7, [1, 2]]);
  });

  /**
   * Break-glass accounts deliberately do not count: they are the way back in
   * when this goes wrong, not a seat in the normal rota.
   */
  it('counts active admins, excluding the one being changed', async () => {
    const db = fakeDb([{ n: 2 }]);
    const n = await countActiveAdmins(7, db);

    expect(n).toBe(2);
    expect(db.calls[0].sql).toContain("role = 'admin'");
    expect(db.calls[0].sql).toContain("status = 'active'");
    expect(db.calls[0].params).toEqual([7]);
  });

  it('counts every active admin when nobody is excluded', async () => {
    const db = fakeDb([{ n: 1 }]);
    await countActiveAdmins(undefined, db);
    expect(db.calls[0].params).toEqual([null]);
  });

  it('deletes a directory entry', async () => {
    const db = fakeDb([{}]);
    expect(await deleteAppUser(7, db)).toBe(true);
    expect(db.calls[0].sql).toContain('DELETE FROM app_users');
  });
});

describe('isAutoAdmin — evaluated on the UPN', () => {
  /**
   * The convention exists so an administrator can reach a fresh deployment
   * without the break-glass account. Keyed on mail it could not do that:
   * `admin365-bernasconi@dompe.onmicrosoft.com` has no mailbox in this tenant,
   * so it signed in and landed `pending` like anybody else.
   */
  it('recognises an administrative account by its UPN', () => {
    expect(isAutoAdmin('admin365-bernasconi@dompe.onmicrosoft.com', null)).toBe(true);
  });

  it('still recognises one by mail when no UPN is available', () => {
    // A tenant that releases no UPN-shaped claim keeps the old behaviour
    // rather than losing the convention entirely.
    expect(isAutoAdmin(null, 'admin365-bernasconi@dompe.onmicrosoft.com')).toBe(true);
    expect(isAutoAdmin('', 'admin365-bernasconi@dompe.onmicrosoft.com')).toBe(true);
  });

  it('lets the UPN override a matching mail address', () => {
    // Deliberately stricter than an "either matches" rule: the UPN is the
    // authoritative identity, so a mail alias cannot confer administrator on
    // an account whose principal name does not qualify.
    expect(
      isAutoAdmin('mario.rossi@dompe.com', 'admin365-x@dompe.onmicrosoft.com'),
    ).toBe(false);
  });

  it('refuses an ordinary account', () => {
    expect(isAutoAdmin('mario.rossi@dompe.com', 'mario.rossi@dompe.com')).toBe(false);
  });

  it('refuses the right prefix on the wrong domain', () => {
    // The domain check is what stops a B2B guest: an invitee's UPN belongs to
    // their own tenant.
    expect(isAutoAdmin('admin365-attacker@attacker.com', null)).toBe(false);
  });

  it('refuses a bare prefix with nothing after it', () => {
    expect(isAutoAdmin('admin365-@dompe.onmicrosoft.com', null)).toBe(false);
  });
});

describe('upsertAppUserFromSaml — UPN persistence', () => {
  it('stores the UPN alongside the immutable key', async () => {
    const db = fakeDb([{ subject: 'oid-123', upn: 'mario.rossi@dompe.com', email: null, role: 'viewer', status: 'pending', created: true }]);
    await upsertAppUserFromSaml(user({ upn: 'mario.rossi@dompe.com' }), db);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO app_users'));
    expect(insert?.sql).toContain('upn');
    expect(insert?.params).toContain('mario.rossi@dompe.com');
  });

  it('keeps the stored UPN when an assertion arrives without one', async () => {
    // COALESCE(NULLIF(EXCLUDED.upn, ''), app_users.upn): a claim that stops
    // being released must not erase what profiling already relies on.
    const db = fakeDb([{ subject: 'oid-123', upn: 'mario.rossi@dompe.com', email: null, role: 'viewer', status: 'pending', created: false }]);
    await upsertAppUserFromSaml(user({ upn: '' }), db);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO app_users'));
    expect(insert?.sql).toContain('COALESCE(NULLIF(EXCLUDED.upn');
  });

  it('applies the convention to the stored row, not only to this assertion', async () => {
    // The row comes back with an administrative UPN while the assertion
    // carried none: a returning user must keep matching.
    const db = fakeDb([{
      subject: 'oid-123',
      upn: 'admin365-bernasconi@dompe.onmicrosoft.com',
      email: null,
      role: 'viewer',
      status: 'pending',
      created: false,
    }]);
    const result = await upsertAppUserFromSaml(user({ upn: '', email: '' }), db);

    expect(result.autoAdmin).toBe(true);
    expect(result.role).toBe('admin');
    expect(result.status).toBe('active');
    const promote = db.calls.find((c) => c.sql.includes("SET role = 'admin'"));
    expect(promote).toBeDefined();
  });

  it('does not promote an ordinary returning user', async () => {
    const db = fakeDb([{ subject: 'oid-123', upn: 'mario.rossi@dompe.com', email: null, role: 'viewer', status: 'pending', created: false }]);
    const result = await upsertAppUserFromSaml(user(), db);

    expect(result.autoAdmin).toBe(false);
    expect(db.calls.find((c) => c.sql.includes("SET role = 'admin'"))).toBeUndefined();
  });
});
