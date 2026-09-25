/**
 * Tests for the WLC passwords held in Key Vault, and for how they take
 * precedence over the environment in `wlcPasswordForSede`.
 *
 * The Key Vault SDK is mocked at library level. `config.js` is the real one:
 * the precedence rule lives there, and a mocked config would test nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSecret, mockSetSecret, mockSecretClientCtor, mockListSedi } = vi.hoisted(() => ({
  mockGetSecret: vi.fn(),
  mockSetSecret: vi.fn(),
  mockSecretClientCtor: vi.fn(),
  mockListSedi: vi.fn(),
}));

vi.mock('@azure/keyvault-secrets', () => ({
  SecretClient: class {
    constructor(...args: unknown[]) {
      mockSecretClientCtor(...args);
    }
    getSecret = mockGetSecret;
    setSecret = mockSetSecret;
  },
}));

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));

vi.mock('../repositories/index.js', () => ({
  listSedi: mockListSedi,
  credentialNamesForSedeCode: (code: string) => ({
    envVar: `WLC_PASSWORD_${code}`,
    secretName: `WLC-PASSWORD-${code}`,
  }),
}));

vi.mock('../logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { config, wlcPasswordForSede } from '../config.js';
import {
  readWlcPasswordFromVault,
  writeWlcPasswordToVault,
  reloadWlcPasswords,
  KeyVaultNotConfiguredError,
  resetKeyVaultClient,
  describeKeyVaultError,
} from '../services/wlcCredentials.js';
import { clearWlcPasswordCache, getCachedWlcPassword, setCachedWlcPassword } from '../utils/wlcPasswordCache.js';

function notFound(): Error {
  return Object.assign(new Error('Secret not found'), { statusCode: 404, code: 'SecretNotFound' });
}

const ENV_KEYS = ['WLC_PASSWORD_MIL', 'WLC_PASSWORD_AQ'];

beforeEach(() => {
  vi.clearAllMocks();
  config.keyVault.url = 'https://kv-test.vault.azure.net';
  resetKeyVaultClient();
  clearWlcPasswordCache();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearWlcPasswordCache();
});

describe('readWlcPasswordFromVault', () => {
  it('reads the site secret and caches it', async () => {
    mockGetSecret.mockResolvedValue({ value: 'kv-pass' });

    expect(await readWlcPasswordFromVault('MIL')).toBe('kv-pass');
    expect(mockGetSecret).toHaveBeenCalledWith('WLC-PASSWORD-MIL');
    expect(mockSecretClientCtor).toHaveBeenCalledWith('https://kv-test.vault.azure.net', expect.anything());
    expect(getCachedWlcPassword('MIL')).toBe('kv-pass');
  });

  it('returns null and forgets the cached value when the secret is gone', async () => {
    setCachedWlcPassword('MIL', 'old');
    mockGetSecret.mockRejectedValue(notFound());

    expect(await readWlcPasswordFromVault('MIL')).toBeNull();
    expect(getCachedWlcPassword('MIL')).toBeUndefined();
  });

  it('keeps the cached value on any other error', async () => {
    setCachedWlcPassword('MIL', 'old');
    mockGetSecret.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));

    await expect(readWlcPasswordFromVault('MIL')).rejects.toThrow('Forbidden');
    expect(getCachedWlcPassword('MIL')).toBe('old');
  });

  it('refuses when Key Vault is not configured', async () => {
    config.keyVault.url = '';
    await expect(readWlcPasswordFromVault('MIL')).rejects.toBeInstanceOf(KeyVaultNotConfiguredError);
    expect(mockGetSecret).not.toHaveBeenCalled();
  });
});

describe('writeWlcPasswordToVault', () => {
  it('writes a new secret version and uses it at once', async () => {
    mockSetSecret.mockResolvedValue({});

    await writeWlcPasswordToVault('MIL', 'new-pass');

    expect(mockSetSecret).toHaveBeenCalledWith('WLC-PASSWORD-MIL', 'new-pass', expect.any(Object));
    expect(wlcPasswordForSede('MIL')).toBe('new-pass');
  });

  it('leaves the cache alone when the write fails', async () => {
    setCachedWlcPassword('MIL', 'old');
    mockSetSecret.mockRejectedValue(new Error('Forbidden'));

    await expect(writeWlcPasswordToVault('MIL', 'new-pass')).rejects.toThrow('Forbidden');
    expect(getCachedWlcPassword('MIL')).toBe('old');
  });
});

describe('reloadWlcPasswords', () => {
  it('reports loaded, missing and failed sites, one failure not stopping the rest', async () => {
    mockListSedi.mockResolvedValue([{ code: 'MIL' }, { code: 'AQ' }, { code: 'NA' }]);
    mockGetSecret.mockImplementation(async (name: string) => {
      if (name === 'WLC-PASSWORD-MIL') return { value: 'mil-pass' };
      if (name === 'WLC-PASSWORD-AQ') throw notFound();
      throw Object.assign(new Error('Service unavailable'), { statusCode: 503 });
    });

    const r = await reloadWlcPasswords();

    expect(r.loaded).toEqual(['MIL']);
    expect(r.missing).toEqual(['AQ']);
    expect(r.failed).toEqual([{ code: 'NA', error: expect.stringContaining('Service unavailable') }]);
    expect(wlcPasswordForSede('MIL')).toBe('mil-pass');
  });

  it('fails fast, without touching the database, when not configured', async () => {
    config.keyVault.url = '';
    await expect(reloadWlcPasswords()).rejects.toBeInstanceOf(KeyVaultNotConfiguredError);
    expect(mockListSedi).not.toHaveBeenCalled();
  });
});

describe('wlcPasswordForSede precedence', () => {
  it('prefers the value read from Key Vault over the environment', () => {
    process.env.WLC_PASSWORD_MIL = 'env-pass';
    setCachedWlcPassword('MIL', 'kv-pass');
    expect(wlcPasswordForSede('MIL')).toBe('kv-pass');
  });

  it('falls back to the environment variable', () => {
    process.env.WLC_PASSWORD_MIL = 'env-pass';
    expect(wlcPasswordForSede('MIL')).toBe('env-pass');
  });

  /** Container Apps passes the App Service syntax through as literal text. */
  it.each([
    '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/WLC-PASSWORD-MIL/)',
    'secretref:wlc-password-mil',
  ])('ignores an unresolved reference (%s)', (value) => {
    process.env.WLC_PASSWORD_MIL = value;
    expect(wlcPasswordForSede('MIL')).toBe(config.wlc.defaultPassword);
  });
});

describe('describeKeyVaultError', () => {
  it('keeps the status and first line only', () => {
    const err = Object.assign(new Error('Forbidden\nlong body'), { statusCode: 403, code: 'Forbidden' });
    expect(describeKeyVaultError(err)).toBe('403 Forbidden: Forbidden');
  });
});
