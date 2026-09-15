/**
 * Tests for the SAML strategy configuration.
 *
 * The behaviour under test is the fix for AADSTS75011: node-saml defaults to
 * injecting `RequestedAuthnContext = PasswordProtectedTransport` with
 * `Comparison="exact"` into every AuthnRequest, which Entra ID honours — so any
 * user signing in with certificate-based auth, Windows Hello or FIDO2 is
 * rejected outright. The strategy must therefore omit the element by default.
 */
import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createSamlStrategy } from '../auth/saml.js';

/**
 * node-saml only asserts that `idpCert` is non-empty at construction time —
 * the value is parsed lazily when a response is validated, which these tests
 * never do. A placeholder is therefore enough, and avoids shipping a
 * throwaway keypair in the repository.
 */
const TEST_CERT = 'placeholder-idp-certificate-not-used-for-request-generation';

const BASE_PARAMS = {
  entryPoint: 'https://login.microsoftonline.com/tenant-id/saml2',
  issuer: 'https://guestportal.dompe.com/saml',
  callbackUrl: 'https://guestportal.dompe.com/api/auth/callback',
  cert: TEST_CERT,
};

/**
 * Generate an AuthnRequest and return its XML.
 * The HTTP-Redirect binding deflates and base64-encodes the request, so it has
 * to be inflated back to inspect what Entra ID would actually receive.
 */
async function generateAuthnRequestXml(
  params: Parameters<typeof createSamlStrategy>[0],
): Promise<string> {
  const strategy = createSamlStrategy(params);
  const saml = strategy?._saml;
  if (!saml) throw new Error('strategy was not created');
  const message = await saml.getAuthorizeMessageAsync('', 'guestportal.dompe.com', {});
  return inflateRawSync(Buffer.from(String(message.SAMLRequest), 'base64')).toString('utf8');
}

describe('createSamlStrategy', () => {
  it('returns null when SAML is not configured', () => {
    expect(createSamlStrategy({ ...BASE_PARAMS, entryPoint: '' })).toBeNull();
    expect(createSamlStrategy({ ...BASE_PARAMS, issuer: '' })).toBeNull();
  });

  it('disables RequestedAuthnContext by default (AADSTS75011 fix)', () => {
    const strategy = createSamlStrategy(BASE_PARAMS);
    expect(strategy).not.toBeNull();
    expect(strategy?._saml?.options.disableRequestedAuthnContext).toBe(true);
  });

  it('emits an AuthnRequest with no RequestedAuthnContext element', async () => {
    const xml = await generateAuthnRequestXml(BASE_PARAMS);
    expect(xml).toContain('AuthnRequest');
    expect(xml).not.toContain('RequestedAuthnContext');
    expect(xml).not.toContain('PasswordProtectedTransport');
  });

  it('still emits RequestedAuthnContext when explicitly re-enabled', async () => {
    const params = { ...BASE_PARAMS, disableRequestedAuthnContext: false };
    expect(createSamlStrategy(params)?._saml?.options.disableRequestedAuthnContext).toBe(false);

    // Guards the test above against silently passing if node-saml ever stops
    // emitting the element altogether: the assertion only means something if
    // the opposite configuration does emit it.
    const xml = await generateAuthnRequestXml(params);
    expect(xml).toContain('RequestedAuthnContext');
    expect(xml).toContain('PasswordProtectedTransport');
  });

  it('keeps the existing hardening options', () => {
    const options = createSamlStrategy(BASE_PARAMS)?._saml?.options;
    expect(options?.wantAssertionsSigned).toBe(true);
    expect(options?.wantAuthnResponseSigned).toBe(true);
    expect(options?.audience).toBe(BASE_PARAMS.issuer);
  });
});
