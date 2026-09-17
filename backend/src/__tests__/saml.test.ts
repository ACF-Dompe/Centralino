/**
 * Tests for the SAML strategy configuration.
 *
 * The behaviour under test is the fix for AADSTS75011: node-saml defaults to
 * injecting `RequestedAuthnContext = PasswordProtectedTransport` with
 * `Comparison="exact"` into every AuthnRequest, which Entra ID honours — so any
 * user signing in with certificate-based auth, Windows Hello or FIDO2 is
 * rejected outright. The strategy must therefore omit the element by default.
 */
import { describe, it, expect, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({ log: mockLog }));

import { createSamlStrategy, buildDisplayName } from '../auth/saml.js';
import type { CacheProvider } from '@node-saml/node-saml';

/**
 * Minimal in-memory CacheProvider for the AuthnRequest IDs.
 *
 * The strategy's default store is PostgreSQL-backed and these tests must not
 * reach a database. node-saml's own InMemoryCacheProvider is not exported from
 * the package root, so this keeps the tests off a deep internal path.
 */
function createFakeCacheProvider(): CacheProvider {
  const store = new Map<string, { value: string; createdAt: number }>();
  return {
    async saveAsync(key, value) {
      if (store.has(key)) return null;
      const item = { value, createdAt: Date.now() };
      store.set(key, item);
      return item;
    },
    async getAsync(key) {
      return store.get(key)?.value ?? null;
    },
    async removeAsync(key) {
      if (key === null) return null;
      return store.delete(key) ? key : null;
    },
  };
}

/**
 * PEM-shaped placeholder. node-saml parses `idpCert` lazily, when it validates
 * a response — which these tests never do — but `createSamlStrategy` now checks
 * the SHAPE up front, so the value has to look like a certificate. This avoids
 * shipping a throwaway keypair in the repository.
 */
const TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBmTCCAQICCQDL4zPGUJ5x1DANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls',
  'b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMzQwMTAxMDAwMDAwWjAUMRIwEAYD',
  '-----END CERTIFICATE-----',
].join('\n');

const BASE_PARAMS = {
  entryPoint: 'https://login.microsoftonline.com/tenant-id/saml2',
  issuer: 'https://guestportal.dompe.com/saml',
  callbackUrl: 'https://guestportal.dompe.com/api/auth/callback',
  cert: TEST_CERT,
  // Keep the AuthnRequest-ID store in memory: the default one is backed by
  // PostgreSQL, and these tests must not reach a database.
  cacheProvider: createFakeCacheProvider(),
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

  describe('certificate validation at startup', () => {
    /**
     * These cover the second production incident: `SAML_CERT` held the literal
     * string `@Microsoft.KeyVault(SecretUri=...)`, because Container Apps does
     * not expand that App Service syntax. node-saml parses the certificate
     * lazily, so the only symptom was
     * "idpCert is not in PEM format or in base64 format" in the browser after a
     * full SSO round-trip. The strategy now refuses to build, and says why in
     * the startup logs.
     *
     * It returns null rather than throwing on purpose: the process stays up, so
     * the break-glass login — which exists for exactly this situation — keeps
     * working.
     */
    it('refuses an unresolved App Service Key Vault reference, and names it', () => {
      const strategy = createSamlStrategy({
        ...BASE_PARAMS,
        cert: '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/SAML-CERT/)',
      });

      expect(strategy).toBeNull();
      const reason = String(mockLog.error.mock.calls.at(-1)?.[0]?.reason ?? '');
      expect(reason).toContain('Container Apps does not expand');
      expect(reason).toContain('secretref:saml-cert');
    });

    it('refuses an unresolved ACA secret reference', () => {
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: 'secretref:saml-cert' })).toBeNull();
    });

    it('refuses an empty or whitespace-only certificate', () => {
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: '' })).toBeNull();
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: '   \n  ' })).toBeNull();
    });

    it('refuses a value whose newlines were flattened to literal \\n', () => {
      const strategy = createSamlStrategy({ ...BASE_PARAMS, cert: 'MIIBmTCC\\nAQICCQDL' });
      expect(strategy).toBeNull();
    });

    it('refuses a placeholder that is neither PEM nor base64', () => {
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: 'not-a-certificate' })).toBeNull();
    });

    it('accepts a PEM certificate', () => {
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: TEST_CERT })).not.toBeNull();
    });

    it('accepts bare base64 DER, which node-saml also supports', () => {
      // A DER certificate opens with an ASN.1 SEQUENCE (0x30).
      const der = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.alloc(300, 7)]);
      const strategy = createSamlStrategy({ ...BASE_PARAMS, cert: der.toString('base64') });
      expect(strategy).not.toBeNull();
    });

    it('rejects base64 that does not decode to a DER certificate', () => {
      const notDer = Buffer.alloc(300, 0x41).toString('base64');
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: notDer })).toBeNull();
    });

    it('tolerates a PEM with surrounding whitespace', () => {
      expect(createSamlStrategy({ ...BASE_PARAMS, cert: `\n  ${TEST_CERT}\n\n` })).not.toBeNull();
    });
  });

  it('keeps the existing hardening options', () => {
    const options = createSamlStrategy(BASE_PARAMS)?._saml?.options;
    expect(options?.wantAssertionsSigned).toBe(true);
    expect(options?.wantAuthnResponseSigned).toBe(true);
    expect(options?.audience).toBe(BASE_PARAMS.issuer);
  });

  describe('wantAuthnResponseSigned', () => {
    /**
     * Entra ID signs the <Assertion> but not the enclosing <Response> unless
     * the Enterprise Application Signing Option is changed. Against the
     * default, requiring a signed response rejects every login with
     * 'Invalid document signature'. The strict default stays; the override
     * exists for tenants where that setting cannot be changed.
     */
    it('requires a signed response by default', () => {
      expect(createSamlStrategy(BASE_PARAMS)?._saml?.options.wantAuthnResponseSigned).toBe(true);
    });

    it('can be relaxed without touching assertion signing', () => {
      const options = createSamlStrategy({
        ...BASE_PARAMS,
        wantAuthnResponseSigned: false,
      })?._saml?.options;

      expect(options?.wantAuthnResponseSigned).toBe(false);
      // The identity claims must stay protected either way.
      expect(options?.wantAssertionsSigned).toBe(true);
    });
  });
});

describe('buildDisplayName', () => {
  // Entra releases the UPN — the mail address — as the `name` claim for this
  // tenant, so using it made the header print the address next to itself.
  it('prefers given name and surname over the name claim', () => {
    expect(buildDisplayName({
      givenName: 'Mario',
      surname: 'Rossi',
      nameClaim: 'mario.rossi@dompe.com',
      nameID: 'mario.rossi@dompe.com',
    })).toBe('Mario Rossi');
  });

  it('falls back to the name claim when neither given name nor surname is released', () => {
    expect(buildDisplayName({
      givenName: '',
      surname: '',
      nameClaim: 'Mario Rossi',
      nameID: 'mario.rossi@dompe.com',
    })).toBe('Mario Rossi');
  });

  it('falls back to the nameID when no name claim is released either', () => {
    expect(buildDisplayName({
      givenName: '',
      surname: '',
      nameClaim: '',
      nameID: 'mario.rossi@dompe.com',
    })).toBe('mario.rossi@dompe.com');
  });

  it('uses whichever of the two name parts is present', () => {
    expect(buildDisplayName({ givenName: 'Mario', surname: '', nameClaim: 'x', nameID: 'y' }))
      .toBe('Mario');
    expect(buildDisplayName({ givenName: '', surname: 'Rossi', nameClaim: 'x', nameID: 'y' }))
      .toBe('Rossi');
  });

  // Claims are values we do not control: blank-but-present is a real case.
  it('ignores whitespace-only claims', () => {
    expect(buildDisplayName({
      givenName: '   ',
      surname: '	',
      nameClaim: '  ',
      nameID: 'mario.rossi@dompe.com',
    })).toBe('mario.rossi@dompe.com');
  });

  it('returns an empty string when the IdP releases nothing usable', () => {
    expect(buildDisplayName({ givenName: '', surname: '', nameClaim: '', nameID: '' })).toBe('');
  });
});
