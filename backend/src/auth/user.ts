/**
 * The authenticated user stored in the session (`session.passport.user`).
 *
 * Two authentication paths produce a session:
 *   - SAML SSO via Entra ID  → `SamlUser`        (authMethod: 'saml')
 *   - break-glass local login → `BreakGlassUser` (authMethod: 'breakglass')
 *
 * `BreakGlassUser` deliberately mirrors the field names of `SamlUser` so that
 * every downstream consumer keeps working untouched: `ensureAuthenticated`, the
 * WebSocket upgrade verifier (which only checks that `session.passport.user`
 * exists) and the `/api/auth/me` payload all read the same properties. The
 * `authMethod` discriminant is what code must branch on when the difference
 * actually matters — SAML Single Logout being the main case.
 */
import type { SamlUser } from './saml.js';

export interface BreakGlassUser {
  authMethod: 'breakglass';
  /** The break-glass username (mirrors SamlUser.nameID). */
  nameID: string;
  displayName: string;
  /** Always '' — break-glass accounts are not mailboxes. */
  email: string;
  givenName: string;
  surname: string;
  /** Always null — there is no Entra object behind a break-glass account. */
  objectId: null;
}

export type AppUser = SamlUser | BreakGlassUser;

/** Type guard: narrow an `AppUser` to a genuine SAML SSO session. */
export function isSamlUser(user: AppUser): user is SamlUser {
  return user.authMethod === 'saml';
}

/** Type guard: narrow an `AppUser` to a break-glass session. */
export function isBreakGlassUser(user: AppUser): user is BreakGlassUser {
  return user.authMethod === 'breakglass';
}

/** Build the session user object for a successful break-glass login. */
export function toBreakGlassUser(username: string, displayName: string): BreakGlassUser {
  return {
    authMethod: 'breakglass',
    nameID: username,
    displayName,
    email: '',
    givenName: '',
    surname: '',
    objectId: null,
  };
}
