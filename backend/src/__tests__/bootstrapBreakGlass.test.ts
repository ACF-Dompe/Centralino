/**
 * Tests for the bootstrap of the break-glass account.
 *
 * This account is what makes a fresh deployment usable at all: every SSO user
 * is created blocked, so somebody has to be able to profile the first admins.
 * The tests pin the three refusals that keep it from becoming a liability —
 * no password, a weak password, and an account that already exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../db/index.js';

const mockConfig = vi.hoisted(() => ({
  config: {
    breakGlass: {
      seedUsername: 'bk.guestportal',
      seedDisplayName: 'Break Glass Guest Portal',
      seedPassword: '',
    },
  },
}));
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const mockRepo = vi.hoisted(() => ({ insertBreakGlassAccountIfMissing: vi.fn() }));

vi.mock('../config.js', () => mockConfig);
vi.mock('../logger.js', () => ({ log: mockLog }));
vi.mock('../repositories/breakglass.js', () => mockRepo);

import { ensureBreakGlassBootstrapAccount } from '../db/bootstrapBreakGlass.js';
import { MIN_PASSWORD_LENGTH } from '../auth/password.js';

const db = {} as DbClient;
const STRONG = 'a-sufficiently-long-bootstrap-password';

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.config.breakGlass.seedPassword = '';
  mockRepo.insertBreakGlassAccountIfMissing.mockResolvedValue(true);
});

describe('ensureBreakGlassBootstrapAccount', () => {
  /**
   * The two alternatives are both worse than doing nothing: a built-in default
   * would be a backdoor published in the repository, and a generated one would
   * be a credential nobody could ever use.
   */
  it('creates nothing when no password is configured', async () => {
    const outcome = await ensureBreakGlassBootstrapAccount(db);

    expect(outcome).toBe('skipped');
    expect(mockRepo.insertBreakGlassAccountIfMissing).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'breakglass-bootstrap-skipped', reason: 'no-password' }),
      expect.stringContaining('make breakglass'),
    );
  });

  it('refuses a password below the minimum rather than weakening the account', async () => {
    mockConfig.config.breakGlass.seedPassword = 'short';

    const outcome = await ensureBreakGlassBootstrapAccount(db);

    expect(outcome).toBe('skipped');
    expect(mockRepo.insertBreakGlassAccountIfMissing).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'password-too-short', minLength: MIN_PASSWORD_LENGTH }),
      expect.any(String),
    );
  });

  it('creates the account with the admin role and a hashed password', async () => {
    mockConfig.config.breakGlass.seedPassword = STRONG;

    const outcome = await ensureBreakGlassBootstrapAccount(db);

    expect(outcome).toBe('created');
    const [params] = mockRepo.insertBreakGlassAccountIfMissing.mock.calls[0];
    expect(params).toMatchObject({
      username: 'bk.guestportal',
      displayName: 'Break Glass Guest Portal',
      role: 'admin',
      expiresAt: null,
    });
    // Hashed, never the plaintext.
    expect(params.passwordHash).not.toContain(STRONG);
    expect(params.passwordHash).toMatch(/^scrypt\$/);
  });

  /**
   * The migration replays on every start and on every migration job. Using the
   * rotating upsert here would restore a password an operator had already
   * rotated away, and switch an account back on that somebody had turned off.
   */
  it('leaves an existing account untouched', async () => {
    mockConfig.config.breakGlass.seedPassword = STRONG;
    mockRepo.insertBreakGlassAccountIfMissing.mockResolvedValue(false);

    const outcome = await ensureBreakGlassBootstrapAccount(db);

    expect(outcome).toBe('exists');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'breakglass-bootstrap-exists' }),
      expect.stringContaining('not rotated'),
    );
  });

  /** Break-glass events are logged at warn so existing alerting picks them up. */
  it('logs the creation at warn level', async () => {
    mockConfig.config.breakGlass.seedPassword = STRONG;
    await ensureBreakGlassBootstrapAccount(db);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'breakglass-bootstrap-created' }),
      expect.any(String),
    );
  });

  it('passes the caller its own database client', async () => {
    mockConfig.config.breakGlass.seedPassword = STRONG;
    await ensureBreakGlassBootstrapAccount(db);
    expect(mockRepo.insertBreakGlassAccountIfMissing).toHaveBeenCalledWith(expect.anything(), db);
  });
});
