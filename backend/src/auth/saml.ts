/**
 * Passport SAML strategy configured for Microsoft Entra ID.
 *
 * The strategy is only initialised when SAML_ENTRY_POINT is set.
 * When SAML is disabled, auth routes return 404 so the frontend
 * knows SSO is not available and falls back to WLC-only auth.
 *
 * Supports Single Logout (SLO): when SAML_LOGOUT_URL is set, the
 * /api/auth/logout endpoint redirects to the IdP's SLO endpoint
 * and the IdP sends a LogoutResponse to /api/auth/slo/callback.
 *
 * Hardening (guidelines §5.5):
 *   - wantAssertionsSigned: true — reject unsigned assertions
 *   - wantAuthnResponseSigned: true — reject unsigned authn responses
 *   - validateInResponseTo: true — prevent SAML response replay
 *   - audience: set to SAML_ISSUER — verify intended audience
 */
import { Strategy as SamlStrategy, ValidateInResponseTo } from '@node-saml/passport-saml';

export type { SamlStrategy };

export interface SamlUser {
  nameID: string;
  nameIDFormat?: string;
  email: string;
  displayName: string;
  givenName: string;
  surname: string;
  objectId: string | null;
  /** Raw profile returned by the IdP (useful for debugging / audit logs). */
  raw: Record<string, unknown>;
}

/**
 * Build the SAML strategy configuration.
 * Returns `null` when SAML env vars are missing (SSO disabled).
 */
export function createSamlStrategy(params: {
  entryPoint: string;
  issuer: string;
  callbackUrl: string;
  cert: string;
  decryptionKey?: string;
  identifierFormat?: string;
  logoutUrl?: string;
  logoutCallbackUrl?: string;
}): SamlStrategy | null {
  if (!params.entryPoint || !params.issuer) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verifyCallback = (profile: any, done: (err: Error | null, user?: any) => void) => {
    if (!profile) {
      return done(null, false);
    }

    const user: SamlUser = {
      nameID: profile.nameID ?? '',
      nameIDFormat: profile.nameIDFormat ?? undefined,
      email:
        profile?.[
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
        ] ?? profile?.email ?? '',
      displayName:
        profile?.[
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
        ] ?? profile?.displayName ?? profile?.nameID ?? '',
      givenName:
        profile?.[
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
        ] ?? profile?.givenName ?? '',
      surname:
        profile?.[
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'
        ] ?? profile?.surname ?? '',
      objectId:
        profile?.[
          'http://schemas.microsoft.com/identity/claims/objectidentifier'
        ] ?? null,
      raw: profile as Record<string, unknown>,
    };

    return done(null, user);
  };

  return new SamlStrategy(
    {
      entryPoint: params.entryPoint,
      issuer: params.issuer,
      callbackUrl: params.callbackUrl,
      idpCert: params.cert,
      decryptionPvk: params.decryptionKey,
      signatureAlgorithm: 'sha256' as const,
      identifierFormat:
        params.identifierFormat ??
        'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      // SLO support (optional)
      logoutUrl: params.logoutUrl,
      logoutCallbackUrl: params.logoutCallbackUrl,
      // ── Hardening ───────────────────────────────────────────────────────
      // Reject unsigned SAML assertions — IdP must sign every assertion.
      wantAssertionsSigned: true,
      // Reject unsigned AuthnResponse messages.
      wantAuthnResponseSigned: true,
      // Prevent SAML response replay attacks by validating InResponseTo.
      // 'ifPresent' validates InResponseTo when the IdP includes it (replay
      // protection for SP-initiated SSO) but does NOT reject unsolicited
      // responses (IdP-initiated SSO). 'always' would also work but would
      // break IdP-initiated flows — 'ifPresent' is the standard production
      // value providing protection without the edge-case risk.
      validateInResponseTo: ValidateInResponseTo.ifPresent,
      // Verify the SAML response was intended for this specific app instance.
      audience: params.issuer,
      // Cache request IDs for InResponseTo validation (30 minute TTL).
      requestIdExpirationPeriodMs: 1_800_000,
    },
    verifyCallback,
    verifyCallback,
  );
}

/**
 * Generate the SAML SLO redirect URL.
 * Passport-saml v3's `strategy.logout(req, callback)` reads the user's
 * SAML profile from `req.user` (which must have `nameID` and optionally
 * `nameIDFormat`) and returns the IdP SLO redirect URL via callback.
 *
 * Returns the URL to redirect the browser to for IdP-initiated logout.
 * Rejects with an error if the URL could not be generated.
 */
export function buildSloRedirectUrl(
  strategy: SamlStrategy,
  req: Express.Request,
): Promise<string> {
  return new Promise((resolve, reject) => {
    strategy.logout(
      req as Parameters<typeof strategy.logout>[0],
      (err: Error | null, url?: string | null) => {
        if (err) return reject(err);
        if (!url) return reject(new Error('SLO redirect URL generation returned empty'));
        resolve(url);
      },
    );
  });
}
