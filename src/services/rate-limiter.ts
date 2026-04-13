interface BucketEntry {
  timestamps: number[];
}

/**
 * In-memory sliding window rate limiter for REST endpoints.
 *
 * Each endpoint (identified by "METHOD:/url") gets a bucket that tracks
 * request timestamps within the configured window. Expired entries are
 * pruned on every check.
 */
export class RateLimiter {
  private static instance: RateLimiter;
  private readonly buckets = new Map<string, BucketEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    // Periodic cleanup every 60s to prevent stale buckets from leaking memory
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  static getInstance(): RateLimiter {
    RateLimiter.instance ??= new RateLimiter();
    return RateLimiter.instance;
  }

  /**
   * Check if a request is allowed under the rate limit.
   *
   * @param key      Unique identifier for the endpoint (e.g. "POST:/api/leads")
   * @param limit    Maximum number of requests allowed in the window
   * @param windowMs Window duration in milliseconds
   * @returns true if the request is allowed, false if rate-limited
   */
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    // Prune expired timestamps
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= limit) {
      return false;
    }

    bucket.timestamps.push(now);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter((t) => t > now - 300_000);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Parse a rate limit value. A plain number (e.g. "100") defaults to per minute.
   * Optionally accepts "count/unit" (e.g. "50/second", "1000/hour").
   *
   * @returns [limit, windowMs] or null if the value is invalid
   */
  static parseRateLimit(value: string): [number, number] | null {
    if (!value) return null;
    const trimmed = value.trim();
    const parts = trimmed.split('/');

    const limit = parseInt(parts[0].trim(), 10);
    if (isNaN(limit) || limit <= 0) return null;

    if (parts.length === 1) {
      // Plain number defaults to per minute
      return [limit, 60_000];
    }

    if (parts.length !== 2) return null;

    const unit = parts[1].trim().toLowerCase();
    let windowMs: number;
    switch (unit) {
      case 'second':
      case 'sec':
      case 's':
        windowMs = 1_000;
        break;
      case 'minute':
      case 'min':
      case 'm':
        windowMs = 60_000;
        break;
      case 'hour':
      case 'hr':
      case 'h':
        windowMs = 3_600_000;
        break;
      default:
        return null;
    }
    return [limit, windowMs];
  }
}
