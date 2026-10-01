/**
 * Which guests the controllers currently see associated, per site.
 *
 * "Active" only ever meant the account is valid; the dashboard showed it as
 * "Connesso" whether or not a device was on the air. This holds what the
 * background sync last read from the controller's client table.
 *
 * Kept in memory on purpose: it is a copy of live controller state refreshed
 * every 30 s, and persisting it would only give it a way to go stale. A replica
 * that has not read a site yet, or whose reading is too old, answers "unknown"
 * — never "not connected".
 */
import type { WirelessClientScan } from './wlcSsh.js';

/** Three sync intervals: past this, a reading says nothing about now. */
const MAX_AGE_MS = 90_000;

const readings = new Map<number, { at: number; tokens: Set<string> }>();

/** Store the latest client table of a site; null (or unreadable) forgets it. */
export function recordPresence(sedeId: number, scan: WirelessClientScan | null): void {
  if (!scan || !scan.readable) {
    readings.delete(sedeId);
    return;
  }
  readings.set(sedeId, { at: Date.now(), tokens: scan.runTokens });
}

/**
 * Whether a device is associated and authenticated with this username.
 * @returns null when the controller's client table is not known.
 */
export function guestConnected(sedeId: number | null, username: string): boolean | null {
  if (sedeId == null) return null;
  const reading = readings.get(sedeId);
  if (!reading || Date.now() - reading.at > MAX_AGE_MS) return null;
  return reading.tokens.has(username.toLowerCase());
}

/** Test hook. */
export function clearPresence(): void {
  readings.clear();
}
