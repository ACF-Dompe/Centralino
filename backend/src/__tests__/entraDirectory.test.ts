/**
 * Tests for the live Entra ID people search behind the "Referente" field.
 *
 * The Graph client is mocked at library level, so these tests pin the request
 * actually sent (filter, advanced-query header, selected fields) and what is
 * allowed back out: display names of users on the permitted UPN domains only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockRequest, mockApi, mockDirectoryConfig } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockRequest = {
    header: vi.fn(),
    count: vi.fn(),
    filter: vi.fn(),
    select: vi.fn(),
    orderby: vi.fn(),
    top: vi.fn(),
    get: mockGet,
  };
  return {
    mockGet,
    mockRequest,
    mockApi: vi.fn(),
    mockDirectoryConfig: { enabled: true, upnDomains: ['dompe.com', 'ext.dompe.com'], maxResults: 15 },
  };
});

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { initWithMiddleware: vi.fn(() => ({ api: mockApi })) },
}));

vi.mock('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js', () => ({
  TokenCredentialAuthenticationProvider: class {},
}));

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));

vi.mock('../config.js', () => ({ config: { directory: mockDirectoryConfig } }));

import {
  searchDirectoryUsers,
  buildDirectoryFilter,
  DirectoryDisabledError,
  resetDirectoryClient,
} from '../services/entraDirectory.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [mockRequest.header, mockRequest.count, mockRequest.filter, mockRequest.select, mockRequest.orderby, mockRequest.top]) {
    fn.mockReturnValue(mockRequest);
  }
  mockApi.mockReturnValue(mockRequest);
  mockDirectoryConfig.enabled = true;
  mockDirectoryConfig.upnDomains = ['dompe.com', 'ext.dompe.com'];
  resetDirectoryClient();
});

describe('buildDirectoryFilter', () => {
  it('matches the text on name, surname, mail and UPN, and restricts the domain', () => {
    const f = buildDirectoryFilter('ros', ['dompe.com', 'ext.dompe.com']);

    for (const field of ['displayName', 'givenName', 'surname', 'mail', 'userPrincipalName']) {
      expect(f).toContain(`startswith(${field},'ros')`);
    }
    expect(f).toContain("endswith(userPrincipalName,'@dompe.com')");
    expect(f).toContain("endswith(userPrincipalName,'@ext.dompe.com')");
    expect(f).toContain('accountEnabled eq true');
  });

  /** An unescaped quote would end the literal and let the rest act as filter syntax. */
  it('doubles single quotes in the search text', () => {
    const f = buildDirectoryFilter("d'amico') or (true", ['dompe.com']);
    expect(f).toContain("startswith(displayName,'d''amico'') or (true')");
  });
});

describe('searchDirectoryUsers', () => {
  it('sends an advanced query and returns display names only', async () => {
    mockGet.mockResolvedValue({
      value: [
        { id: 'a', displayName: 'Maria Rossi', userPrincipalName: 'maria.rossi@dompe.com' },
        { id: 'b', displayName: 'Luca Rossini', userPrincipalName: 'luca.rossini@ext.dompe.com' },
      ],
    });

    const users = await searchDirectoryUsers('ros');

    expect(mockApi).toHaveBeenCalledWith('/users');
    expect(mockRequest.header).toHaveBeenCalledWith('ConsistencyLevel', 'eventual');
    expect(mockRequest.count).toHaveBeenCalledWith(true);
    expect(mockRequest.top).toHaveBeenCalledWith(15);
    expect(users).toEqual([
      { id: 'a', displayName: 'Maria Rossi' },
      { id: 'b', displayName: 'Luca Rossini' },
    ]);
    // The UPN never leaves the backend.
    expect(JSON.stringify(users)).not.toContain('@');
  });

  it('drops anything outside the allowed domains, whatever Graph returned', async () => {
    mockGet.mockResolvedValue({
      value: [
        { id: 'a', displayName: 'Interno', userPrincipalName: 'interno@DOMPE.COM' },
        { id: 'b', displayName: 'Ospite B2B', userPrincipalName: 'guest_x.com#EXT#@dompe.onmicrosoft.com' },
        { id: 'c', displayName: 'Lookalike', userPrincipalName: 'x@notdompe.com' },
        { id: 'd', displayName: 'Senza UPN', userPrincipalName: null },
      ],
    });

    const users = await searchDirectoryUsers('xx');

    expect(users).toEqual([{ id: 'a', displayName: 'Interno' }]);
  });

  it('skips entries without a display name', async () => {
    mockGet.mockResolvedValue({ value: [{ id: 'a', displayName: null, userPrincipalName: 'a@dompe.com' }] });
    expect(await searchDirectoryUsers('xx')).toEqual([]);
  });

  it('refuses to search when the feature is off', async () => {
    mockDirectoryConfig.enabled = false;
    await expect(searchDirectoryUsers('ros')).rejects.toBeInstanceOf(DirectoryDisabledError);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('propagates Graph errors to the caller', async () => {
    mockGet.mockRejectedValue(new Error('Insufficient privileges'));
    await expect(searchDirectoryUsers('ros')).rejects.toThrow('Insufficient privileges');
  });
});
