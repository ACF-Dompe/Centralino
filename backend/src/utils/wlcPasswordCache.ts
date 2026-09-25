/**
 * In-memory copy of the WLC passwords read from Key Vault, keyed by site code.
 *
 * Deliberately free of imports: `config.ts` reads it from `wlcPasswordForSede`,
 * and the Key Vault service that fills it imports `config.ts` — a dependency in
 * the other direction would be a cycle.
 *
 * Per process. The backend runs as a single replica today; with more than one,
 * a change made through the admin panel reaches the other replicas at their
 * next restart or "reload".
 */
const cache = new Map<string, string>();

function key(code: string): string {
  return code.toUpperCase();
}

export function getCachedWlcPassword(code: string): string | undefined {
  return cache.get(key(code));
}

export function setCachedWlcPassword(code: string, password: string): void {
  cache.set(key(code), password);
}

export function deleteCachedWlcPassword(code: string): void {
  cache.delete(key(code));
}

export function clearWlcPasswordCache(): void {
  cache.clear();
}
