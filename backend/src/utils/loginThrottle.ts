/**
 * Per-source-IP throttle for the break-glass login endpoint.
 *
 * This is the second of two rate limits on that route. The primary one is the
 * per-account lockout persisted in `breakglass_users` (global across replicas);
 * this one caps how many attempts a single source IP may make regardless of
 * which usernames it targets, which is what stops username spraying.
 *
 * LIMITATION — the window is held in process memory, so with several ACA
 * replicas an attacker effectively gets the budget once per replica. That is
 * accepted: the database-backed account lockout is the control that has to hold
 * globally, and this one only needs to blunt high-rate spraying. Moving it to a
 * shared store would put the break-glass path behind another dependency, which
 * defeats the purpose of a break-glass path.
 */

export interface LoginThrottle {
  /** True when this IP still has attempts left in the current window. */
  check: (ip: string | undefined) => boolean;
  /** Record a failed attempt for this IP. */
  recordFailure: (ip: string | undefined) => void;
  /** Clear the counter for this IP (called after a successful login). */
  reset: (ip: string | undefined) => void;
}

/** Entries older than the window are dropped when the map is next swept. */
interface Bucket {
  /** Timestamps (ms) of the failures still inside the window. */
  failures: number[];
}

/**
 * Create an in-memory sliding-window throttle.
 *
 * @param maxAttempts - failures allowed per IP inside the window
 * @param windowMs - width of the sliding window in milliseconds
 */
export function createLoginThrottle(maxAttempts: number, windowMs: number): LoginThrottle {
  const buckets = new Map<string, Bucket>();

  /** Drop timestamps that have aged out, and the bucket itself when empty. */
  function prune(key: string, now: number): number[] {
    const bucket = buckets.get(key);
    if (!bucket) return [];
    const fresh = bucket.failures.filter((t) => now - t < windowMs);
    if (fresh.length === 0) {
      buckets.delete(key);
      return [];
    }
    bucket.failures = fresh;
    return fresh;
  }

  /**
   * Sweep every bucket. Called on each failure — the map only ever holds IPs
   * that failed a break-glass login inside the window, so it stays tiny and a
   * full sweep is cheaper than carrying a timer that keeps the process awake.
   */
  function pruneAll(now: number): void {
    for (const key of [...buckets.keys()]) {
      prune(key, now);
    }
  }

  return {
    check(ip) {
      // A request with no resolvable source IP cannot be rate limited, so it is
      // refused rather than handed an unlimited budget.
      if (!ip) return false;
      return prune(ip, Date.now()).length < maxAttempts;
    },

    recordFailure(ip) {
      if (!ip) return;
      const now = Date.now();
      pruneAll(now);
      const bucket = buckets.get(ip);
      if (bucket) {
        bucket.failures.push(now);
      } else {
        buckets.set(ip, { failures: [now] });
      }
    },

    reset(ip) {
      if (!ip) return;
      buckets.delete(ip);
    },
  };
}
