/**
 * Unit tests for pure parser/helper functions in wlcSsh.ts.
 *
 * These functions parse WLC CLI output or convert between formats —
 * no mocking needed since they are pure functions with no dependencies.
 */
import { describe, it, expect } from 'vitest';
import {
  parseUsernameList,
  getGuestUsers,
  parseLifetimeToMinutes,
  minutesToLifetime,
  extractGuestUsers,
  extractGuestUserNames,
  parseWirelessClients,
} from '../services/wlcSsh.js';

// ── parseUsernameList ──────────────────────────────────────────────────────

describe('parseUsernameList', () => {
  it('parses usernames with privilege levels', () => {
    const output = [
      'username admin privilege 15',
      'username operator privilege 7',
      'username monitor privilege 3',
    ].join('\n');

    const result = parseUsernameList(output);
    expect(result).toEqual([
      { username: 'admin', privilege: 15 },
      { username: 'operator', privilege: 7 },
      { username: 'monitor', privilege: 3 },
    ]);
  });

  it('parses guest usernames without privilege (null)', () => {
    const output = [
      'username g.marior123',
      'username m.rossi456',
    ].join('\n');

    const result = parseUsernameList(output);
    expect(result).toEqual([
      { username: 'g.marior123', privilege: null },
      { username: 'm.rossi456', privilege: null },
    ]);
  });

  it('parses mixed output with management and guest users', () => {
    const output = [
      'username admin privilege 15',
      'username g.marior123',
      'username operator privilege 7',
      'username m.rossi456',
    ].join('\n');

    const result = parseUsernameList(output);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ username: 'admin', privilege: 15 });
    expect(result[1]).toEqual({ username: 'g.marior123', privilege: null });
    expect(result[2]).toEqual({ username: 'operator', privilege: 7 });
    expect(result[3]).toEqual({ username: 'm.rossi456', privilege: null });
  });

  it('handles leading whitespace', () => {
    const output = '  username admin privilege 15\n  username g.guest1\n';
    const result = parseUsernameList(output);
    expect(result).toEqual([
      { username: 'admin', privilege: 15 },
      { username: 'g.guest1', privilege: null },
    ]);
  });

  it('returns empty array for empty output', () => {
    expect(parseUsernameList('')).toEqual([]);
  });

  it('returns empty array when no username lines exist', () => {
    const output = [
      'building running-config ...',
      'Current configuration : 1234 bytes',
    ].join('\n');
    expect(parseUsernameList(output)).toEqual([]);
  });

  it('handles carriage returns (\\r\\n)', () => {
    const output = 'username admin privilege 15\r\nusername g.guest1\r\n';
    const result = parseUsernameList(output);
    expect(result).toEqual([
      { username: 'admin', privilege: 15 },
      { username: 'g.guest1', privilege: null },
    ]);
  });
});

// ── getGuestUsers ──────────────────────────────────────────────────────────

describe('getGuestUsers', () => {
  it('filters to only users without privilege (guest type)', () => {
    const users = [
      { username: 'admin', privilege: 15 },
      { username: 'operator', privilege: 7 },
      { username: 'g.marior123', privilege: null },
      { username: 'g.rossi456', privilege: null },
    ];

    const result = getGuestUsers(users);
    expect(result).toEqual([
      { username: 'g.marior123' },
      { username: 'g.rossi456' },
    ]);
  });

  it('returns empty array when no guest users exist', () => {
    const users = [
      { username: 'admin', privilege: 15 },
    ];
    expect(getGuestUsers(users)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getGuestUsers([])).toEqual([]);
  });

  it('excludes privilege 0 users (they are lobby-admin, not guests)', () => {
    const users = [
      { username: 'guestadmin', privilege: 0 },
      { username: 'g.mario1', privilege: null },
    ];
    const result = getGuestUsers(users);
    expect(result).toEqual([{ username: 'g.mario1' }]);
  });
});

// ── parseLifetimeToMinutes ─────────────────────────────────────────────────

describe('parseLifetimeToMinutes', () => {
  it('parses 6 months to 259200 minutes', () => {
    const result = parseLifetimeToMinutes(
      'year 0 month 6 day 0 hour 0 minute 0 second 0',
    );
    // 6 months * 30 days * 24h * 60m = 259200
    expect(result).toBe(259200);
  });

  it('parses 1 year to 525600 minutes', () => {
    const result = parseLifetimeToMinutes(
      'year 1 month 0 day 0 hour 0 minute 0 second 0',
    );
    // 1 year * 365 days * 24h * 60m = 525600
    expect(result).toBe(525600);
  });

  it('parses mixed duration correctly', () => {
    const result = parseLifetimeToMinutes(
      'year 1 month 2 day 10 hour 4 minute 30 second 0',
    );
    // 1y*365 + 2m*30 + 10d = 435 days = 626400 min + 4h*60 = 240 + 30
    // 435 * 24 * 60 + 4 * 60 + 30 = 626400 + 240 + 30 = 626670
    expect(result).toBe(626670);
  });

  it('parses lifetime with "guest-user lifetime" prefix (from WLC config)', () => {
    // This is how it appears in "show running-config | section user-name"
    const result = parseLifetimeToMinutes(
      'guest-user lifetime year 0 month 6 day 0 hour 0 minute 0 second 0',
    );
    expect(result).toBe(259200);
  });

  it('returns null for unrecognised format', () => {
    expect(parseLifetimeToMinutes('')).toBeNull();
    expect(parseLifetimeToMinutes('invalid')).toBeNull();
    expect(parseLifetimeToMinutes('year X month Y')).toBeNull();
  });
});

// ── minutesToLifetime ──────────────────────────────────────────────────────

describe('minutesToLifetime', () => {
  it('converts 240 minutes to "year 0 month 0 day 0 hour 4 minute 0 second 0"', () => {
    expect(minutesToLifetime(240)).toBe(
      'year 0 month 0 day 0 hour 4 minute 0 second 0',
    );
  });

  it('converts 259200 minutes to 6 months', () => {
    expect(minutesToLifetime(259200)).toBe(
      'year 0 month 6 day 0 hour 0 minute 0 second 0',
    );
  });

  it('converts 525600 minutes to 1 year', () => {
    expect(minutesToLifetime(525600)).toBe(
      'year 1 month 0 day 0 hour 0 minute 0 second 0',
    );
  });

  it('round-trips correctly: minutesToLifetime → parseLifetimeToMinutes', () => {
    const originalMinutes = 6270; // 4 days 8 hours 30 minutes
    const lifetime = minutesToLifetime(originalMinutes);
    const parsed = parseLifetimeToMinutes(lifetime);
    expect(parsed).toBe(originalMinutes);
  });

  it('round-trips with large values', () => {
    const originalMinutes = 525600 + 259200 + 1440 + 120; // 1y 6m 1d 2h
    const lifetime = minutesToLifetime(originalMinutes);
    const parsed = parseLifetimeToMinutes(lifetime);
    expect(parsed).toBe(originalMinutes);
  });
});

// ── extractGuestUsers ──────────────────────────────────────────────────────

describe('extractGuestUsers', () => {
  it('extracts guest users from "show running-config | section user-name" output', () => {
    const output = [
      'user-name mario.rossi@example.com',
      ' creation-time 1782900000',
      ' description Guest-User',
      ' password 0 test123',
      ' type network-user description Guest-User guest-user lifetime year 0 month 6 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      username: 'mario.rossi@example.com',
      createdAt: 1782900000,
      durationMinutes: 259200, // 6 months
    });
  });

  it('extracts multiple guest users', () => {
    const output = [
      'user-name mario.rossi@example.com',
      ' creation-time 1782900000',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
      '',
      'user-name anna.bianchi@example.com',
      ' creation-time 1782986400',
      ' type network-user guest-user lifetime year 0 month 2 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);

    expect(result).toHaveLength(2);
    expect(result[0].username).toBe('mario.rossi@example.com');
    expect(result[0].durationMinutes).toBe(43200); // 1 month
    expect(result[1].username).toBe('anna.bianchi@example.com');
    expect(result[1].durationMinutes).toBe(86400); // 2 months
  });

  it('excludes lobby-admin users', () => {
    const output = [
      'user-name guestadmin',
      ' creation-time 1782900000',
      ' privilege 0',
      ' view LobbyAdminView',
      ' type lobby-admin',
      '',
      'user-name g.mario1@example.com',
      ' creation-time 1782986400',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe('g.mario1@example.com');
  });

  it('strips surrounding quotes from usernames', () => {
    const output = [
      'user-name "giovanni.verdi@example.com"',
      ' creation-time 1782900000',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);
    expect(result[0].username).toBe('giovanni.verdi@example.com');
  });

  it('handles empty output', () => {
    expect(extractGuestUsers('')).toEqual([]);
  });

  it('handles output with no user-name lines', () => {
    expect(extractGuestUsers('Building configuration...\nCurrent configuration: 1234 bytes\n')).toEqual([]);
  });

  it('parses creation-time correctly', () => {
    const output = [
      'user-name test@example.com',
      ' creation-time 1700000000',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);
    expect(result[0].createdAt).toBe(1700000000);
  });

  it('gracefully handles missing creation-time (sets null)', () => {
    const output = [
      'user-name test@example.com',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUsers(output);
    expect(result[0].createdAt).toBeNull();
  });

  it('gracefully handles missing lifetime string (sets null)', () => {
    const output = [
      'user-name test@example.com',
      ' creation-time 1782900000',
      ' type network-user',
    ].join('\n');

    const result = extractGuestUsers(output);
    expect(result[0].durationMinutes).toBeNull();
  });
});

// ── extractGuestUserNames (deprecated wrapper) ─────────────────────────────

describe('extractGuestUserNames (deprecated)', () => {
  it('returns usernames from extractGuestUsers', () => {
    const output = [
      'user-name mario.rossi@example.com',
      ' creation-time 1782900000',
      ' type network-user guest-user lifetime year 0 month 1 day 0 hour 0 minute 0 second 0',
    ].join('\n');

    const result = extractGuestUserNames(output);
    expect(result).toEqual(['mario.rossi@example.com']);
  });

  it('returns empty array when no guest users', () => {
    expect(extractGuestUserNames('')).toEqual([]);
  });
});

// ── parseWirelessClients ───────────────────────────────────────────────────

describe('parseWirelessClients', () => {
  const header =
    'MAC Address    SSID          AP Name        State   IP Address    Device-type  VLAN  BSSID           Auth Method  Created  Connected  Protocol  Channel  Width  SGI  NSS  Rate   CAP  Username';
  const table = (...rows: string[]) => [
    '>>> show wireless client summary detail',
    'WLC#show wireless client summary detail',
    '',
    `Number of Clients: ${rows.length}`,
    '',
    header,
    '-'.repeat(header.length),
    ...rows,
    'WLC#',
  ].join('\r\n');

  it('collects the tokens of clients in the Run state', () => {
    const scan = parseWirelessClients(table(
      'aaaa.bbbb.cccc Dompe Guest   AP-MIL-01      Run     10.1.1.10     Apple-Device 20    0011.2233.4455  Web Auth     120      118        11ac      36       80     Y/Y  2/2  866.7  E    G.Mario123',
    ));
    expect(scan.readable).toBe(true);
    // Lower-cased: the guest may type the username in any case.
    expect(scan.runTokens.has('g.mario123')).toBe(true);
  });

  it('ignores clients that have not finished authenticating', () => {
    const scan = parseWirelessClients(table(
      'aaaa.bbbb.cccc Dompe Guest   AP-MIL-01      Webauth Pending 10.1.1.10  Apple-Device 20  0011.2233.4455  Web Auth  120  0  11ac  36  80  Y/Y  2/2  866.7  E  g.anna456',
    ));
    expect(scan.readable).toBe(true);
    expect(scan.runTokens.has('g.anna456')).toBe(false);
  });

  it('is readable with no clients at all', () => {
    const scan = parseWirelessClients(['Number of Clients: 0', '', 'WLC#'].join('\r\n'));
    expect(scan).toEqual({ readable: true, runTokens: new Set() });
  });

  it('is not readable when the table carries no user names', () => {
    const scan = parseWirelessClients([
      'Number of Clients: 1',
      'MAC Address    AP Name        Type ID   State   Protocol Method     Role',
      'aaaa.bbbb.cccc AP-MIL-01      WLAN 1    Run     11ac     Web Auth   Local',
    ].join('\r\n'));
    expect(scan.readable).toBe(false);
  });

  it('is not readable when the command was refused', () => {
    const scan = parseWirelessClients("% Invalid input detected at '^' marker.\r\nWLC#");
    expect(scan.readable).toBe(false);
  });
});
