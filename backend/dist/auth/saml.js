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
 */
import { Strategy as SamlStrategy } from 'passport-saml';
/**
 * Build the SAML strategy configuration.
 * Returns `null` when SAML env vars are missing (SSO disabled).
 */
export function createSamlStrategy(params) {
    if (!params.entryPoint || !params.issuer) {
        return null;
    }
    return new SamlStrategy({
        entryPoint: params.entryPoint,
        issuer: params.issuer,
        callbackUrl: params.callbackUrl,
        cert: params.cert,
        decryptionPvk: params.decryptionKey,
        signatureAlgorithm: 'sha256',
        identifierFormat: params.identifierFormat ??
            'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        // SLO support (optional)
        logoutUrl: params.logoutUrl,
        logoutCallbackUrl: params.logoutCallbackUrl,
    }, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (profile, done) => {
        if (!profile) {
            return done(null, false);
        }
        const user = {
            nameID: profile.nameID ?? '',
            nameIDFormat: profile.nameIDFormat ?? undefined,
            email: profile?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ?? profile?.email ?? '',
            displayName: profile?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? profile?.displayName ?? profile?.nameID ?? '',
            givenName: profile?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] ?? profile?.givenName ?? '',
            surname: profile?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'] ?? profile?.surname ?? '',
            objectId: profile?.['http://schemas.microsoft.com/identity/claims/objectidentifier'] ?? null,
            raw: profile,
        };
        return done(null, user);
    });
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
export function buildSloRedirectUrl(strategy, req) {
    return new Promise((resolve, reject) => {
        strategy.logout(req, (err, url) => {
            if (err)
                return reject(err);
            if (!url)
                return reject(new Error('SLO redirect URL generation returned empty'));
            resolve(url);
        });
    });
}
//# sourceMappingURL=saml.js.map