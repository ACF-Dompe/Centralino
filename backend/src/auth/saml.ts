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
 *   - wantAssertionsSigned: true — reject unsigned assertions (unconditional)
 *   - wantAuthnResponseSigned: true — reject unsigned authn responses. Needs
 *     Entra's Signing Option set to "Sign SAML response and assertion";
 *     overridable with SAML_WANT_AUTHN_RESPONSE_SIGNED when it cannot be.
 *   - validateInResponseTo: true — prevent SAML response replay
 *   - audience: set to SAML_ISSUER — verify intended audience
 *   - disableRequestedAuthnContext: true — do not dictate the auth method
 */
import { Strategy as SamlStrategy, ValidateInResponseTo } from '@node-saml/passport-saml';
import { log } from '../logger.js';

export type { SamlStrategy };

export interface SamlUser {
  /**
   * Discriminant for `AppUser` (see auth/user.ts): distinguishes an Entra ID
   * SSO session from a break-glass one. Both shapes are stored under
   * `session.passport.user`, so anything reading the session must be able to
   * tell them apart — the logout route in particular, which may only attempt
   * SAML Single Logout for a genuine SAML session.
   */
  authMethod: 'saml';
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
 * Check that `cert` is something node-saml can actually parse, and say so
 * clearly at startup instead of at the first login.
 *
 * node-saml resolves `idpCert` lazily, when it validates a response — so a
 * misconfigured certificate stays invisible until a user completes an SSO
 * round-trip, and then surfaces as a bare
 * "idpCert is not in PEM format or in base64 format" in the browser.
 *
 * Returns null when the value is usable, otherwise a human-readable reason.
 */
function describeInvalidCert(cert: string): string | null {
  const trimmed = cert.trim();

  if (trimmed.length === 0) {
    return 'SAML_CERT is empty';
  }

  // The mistake we actually hit in production: Azure Container Apps does not
  // understand the `@Microsoft.KeyVault(SecretUri=...)` syntax — that belongs
  // to App Service / Functions. In ACA the literal string reaches the
  // container, so name the problem explicitly rather than letting node-saml
  // complain about the format.
  if (trimmed.startsWith('@Microsoft.KeyVault')) {
    return (
      'SAML_CERT contains an unresolved App Service style Key Vault reference. ' +
      'Container Apps does not expand @Microsoft.KeyVault(...): define an ACA ' +
      'secret with `az containerapp secret set --secrets ' +
      '"saml-cert=keyvaultref:<secret-uri>,identityref:<uami-id>"` and set ' +
      'SAML_CERT=secretref:saml-cert'
    );
  }

  if (trimmed.startsWith('secretref:')) {
    return 'SAML_CERT still holds the literal "secretref:..." string — the ACA secret was not resolved';
  }

  if (trimmed.includes('BEGIN CERTIFICATE')) {
    return null; // PEM
  }

  // Bare base64 DER is also accepted by node-saml. A DER certificate always
  // starts with an ASN.1 SEQUENCE (0x30), which is a cheap sanity check that
  // catches truncated or escaped values.
  const body = trimmed.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(body) && body.length > 100) {
    try {
      if (Buffer.from(body, 'base64')[0] === 0x30) {
        return null;
      }
    } catch {
      /* fall through to the generic message */
    }
    return 'SAML_CERT looks like base64 but does not decode to a DER certificate';
  }

  if (trimmed.includes('\\n')) {
    return 'SAML_CERT contains literal "\\n" sequences instead of real newlines';
  }

  return 'SAML_CERT is neither PEM (-----BEGIN CERTIFICATE-----) nor base64 DER';
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
  /**
   * Omit RequestedAuthnContext from the AuthnRequest. Defaults to `true`.
   * See the `disableRequestedAuthnContext` note in the strategy config below.
   */
  disableRequestedAuthnContext?: boolean;
  /**
   * Require the `<Response>` element to be signed too. Defaults to `true`.
   * See the note on `wantAuthnResponseSigned` in the strategy config below.
   */
  wantAuthnResponseSigned?: boolean;
}): SamlStrategy | null {
  if (!params.entryPoint || !params.issuer) {
    return null;
  }

  // Refuse to build a strategy around a certificate we know cannot validate a
  // response. Returning null (rather than throwing) keeps the process alive:
  // the SSO routes then answer 501 and, crucially, the break-glass login still
  // works — it exists precisely for when SSO is broken. The caller disables
  // SSO based on this null, and the reason is unmistakable in startup logs.
  const certProblem = describeInvalidCert(params.cert);
  if (certProblem) {
    log.error(
      { reason: certProblem },
      'SSO SAML disabled — the IdP certificate is unusable, so no SAML response could ever be validated',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verifyCallback = (profile: any, done: (err: Error | null, user?: any) => void) => {
    if (!profile) {
      return done(null, false);
    }

    const user: SamlUser = {
      authMethod: 'saml',
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
      //
      // Entra ID's default Signing Option is 'Sign SAML assertion', which
      // signs the <Assertion> but NOT the enclosing <Response>. Against that
      // default this requirement rejects every login with
      // "Invalid document signature". The right fix is on the IdP — set the
      // Enterprise Application to 'Sign SAML response and assertion' — so the
      // default here stays strict; the override exists for the case where that
      // setting cannot be changed. The identity claims remain protected either
      // way, because wantAssertionsSigned below is unconditional.
      wantAuthnResponseSigned: params.wantAuthnResponseSigned ?? true,
      // Prevent SAML response replay attacks by validating InResponseTo.
      // 'ifPresent' validates InResponseTo when the IdP includes it (replay
      // protection for SP-initiated SSO) but does NOT reject unsolicited
      // responses (IdP-initiated SSO). 'always' would also work but would
      // break IdP-initiated flows — 'ifPresent' is the standard production
      // value providing protection without the edge-case risk.
      validateInResponseTo: ValidateInResponseTo.ifPresent,
      // Verify the SAML response was intended for this specific app instance.
      audience: params.issuer,
      // Do NOT tell the IdP *how* the user must authenticate.
      //
      // node-saml defaults to injecting
      //   <RequestedAuthnContext Comparison="exact">
      //     <AuthnContextClassRef>...PasswordProtectedTransport</AuthnContextClassRef>
      // into every AuthnRequest. Entra ID honours that constraint, so any user
      // who signed in with certificate-based auth, Windows Hello or FIDO2
      // (amr = X509, MultiFactor, X509Device) cannot satisfy it and the login
      // fails with AADSTS75011 instead of being let through.
      //
      // Choosing the authentication method is the IdP's job — it is driven by
      // Conditional Access / Authentication Strength policies in Entra, not by
      // the service provider. Omitting the element lets Entra apply them.
      disableRequestedAuthnContext: params.disableRequestedAuthnContext ?? true,
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
