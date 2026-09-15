/**
 * CIDR allowlist for the break-glass login endpoint.
 *
 * Built on `node:net`'s `BlockList`, which already implements IPv4/IPv6 subnet
 * matching in core — hand-rolling an IPv6 parser here would be a needless
 * source of off-by-one bugs on a security control.
 *
 * Fail-closed semantics, on purpose: a non-empty allowlist whose entries are
 * all malformed denies every request rather than silently degrading to
 * "allow all". The misconfiguration is logged as an error and only affects the
 * break-glass endpoint — the rest of the API keeps serving, so a typo here
 * cannot take the application down.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { log } from '../logger.js';

export interface IpAllowlist {
  /** True when no restriction is configured (every source IP is allowed). */
  unrestricted: boolean;
  /** Check a source IP against the allowlist. */
  allows: (ip: string | undefined) => boolean;
}

/**
 * Normalise an IPv4-mapped IPv6 address (`::ffff:10.1.2.3`) down to plain
 * IPv4, so that an operator can write `10.0.0.0/8` and have it match
 * regardless of whether the request arrived over a dual-stack socket.
 */
function normaliseIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/**
 * Split a `10.0.0.0/8, 2001:db8::/32` style entry into address and prefix.
 * A bare address is treated as a single host (/32 or /128).
 */
function parseEntry(entry: string): { address: string; prefix: number } | null {
  const [rawAddress, rawPrefix] = entry.split('/');
  const address = normaliseIp(rawAddress.trim());
  const v4 = isIPv4(address);
  const v6 = isIPv6(address);
  if (!v4 && !v6) return null;

  if (rawPrefix === undefined) {
    return { address, prefix: v4 ? 32 : 128 };
  }
  const prefix = Number(rawPrefix.trim());
  const max = v4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix };
}

/**
 * Compile a comma-separated CIDR list into a matcher.
 *
 * An empty or whitespace-only list yields an unrestricted allowlist, which is
 * the default: the network control is opt-in, and the caller decides whether to
 * warn about running without it.
 */
export function createIpAllowlist(raw: string): IpAllowlist {
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (entries.length === 0) {
    return { unrestricted: true, allows: () => true };
  }

  const blockList = new BlockList();
  let valid = 0;
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      log.error(
        { entry },
        'BREAKGLASS_IP_ALLOWLIST contains an invalid CIDR entry — it will be ignored',
      );
      continue;
    }
    blockList.addSubnet(
      parsed.address,
      parsed.prefix,
      isIPv4(parsed.address) ? 'ipv4' : 'ipv6',
    );
    valid += 1;
  }

  if (valid === 0) {
    log.error(
      'BREAKGLASS_IP_ALLOWLIST is set but no entry could be parsed — denying every break-glass request',
    );
    return { unrestricted: false, allows: () => false };
  }

  return {
    unrestricted: false,
    allows: (ip) => {
      if (!ip) return false;
      const normalised = normaliseIp(ip);
      if (isIPv4(normalised)) return blockList.check(normalised, 'ipv4');
      if (isIPv6(normalised)) return blockList.check(normalised, 'ipv6');
      return false;
    },
  };
}
