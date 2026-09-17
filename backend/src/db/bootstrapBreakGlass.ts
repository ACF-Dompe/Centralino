/**
 * Creation of the bootstrap break-glass account.
 *
 * Why this runs with the migrations rather than with the seed: the seed is
 * gated behind SEED_ENABLED, which is false in production — correctly, since it
 * rewrites site data on every start. Migrations run in both places that matter,
 * locally at startup and as the ACA migration job, so hooking in there covers
 * every environment with one call site.
 *
 * Why it matters: with the user directory in place, every SSO user is created
 * blocked, so somebody has to be able to profile the first admins. This account
 * is that somebody. Without it a fresh deployment has nobody who can act.
 */
import type { DbClient } from './index.js';
import { config } from '../config.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { insertBreakGlassAccountIfMissing } from '../repositories/breakglass.js';
import { log } from '../logger.js';

export type BootstrapOutcome = 'created' | 'exists' | 'skipped';

/**
 * Create the bootstrap account if it is missing and a password was supplied.
 *
 * Deliberately does nothing when BREAKGLASS_SEED_PASSWORD is empty. The two
 * alternatives are both worse: a built-in default password would be a backdoor
 * published in the repository, and a randomly generated one would be a
 * credential nobody could ever use.
 */
export async function ensureBreakGlassBootstrapAccount(
  client: DbClient,
): Promise<BootstrapOutcome> {
  const username = config.breakGlass.seedUsername;
  const displayName = config.breakGlass.seedDisplayName;
  const password = config.breakGlass.seedPassword;

  if (!password) {
    log.warn(
      { event: 'breakglass-bootstrap-skipped', reason: 'no-password', username },
      'Bootstrap break-glass account NOT created: BREAKGLASS_SEED_PASSWORD is empty. ' +
        'Create it with `make breakglass ARGS="set ' + username + ' --display \'' + displayName + '\'"` ' +
        'before anyone can profile the first administrators.',
    );
    return 'skipped';
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    log.error(
      {
        event: 'breakglass-bootstrap-skipped',
        reason: 'password-too-short',
        username,
        minLength: MIN_PASSWORD_LENGTH,
      },
      'Bootstrap break-glass account NOT created: BREAKGLASS_SEED_PASSWORD is shorter than the minimum. ' +
        'Refusing rather than weakening the only account that bypasses Entra.',
    );
    return 'skipped';
  }

  const created = await insertBreakGlassAccountIfMissing(
    {
      username,
      displayName,
      passwordHash: hashPassword(password),
      role: 'admin',
      expiresAt: null,
    },
    client,
  );

  // Logged at warn, like every other break-glass event, so the existing Log
  // Analytics alerting picks it up without a new rule.
  log.warn(
    { event: created ? 'breakglass-bootstrap-created' : 'breakglass-bootstrap-exists', username },
    created
      ? 'Bootstrap break-glass account CREATED'
      : 'Bootstrap break-glass account already present — left untouched (password not rotated, account not re-enabled)',
  );

  return created ? 'created' : 'exists';
}
