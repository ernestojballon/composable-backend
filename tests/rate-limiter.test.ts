import { describe, expect, it, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/services/rate-limiter.js';

describe('RateLimiter', () => {
  describe('parseRateLimit', () => {
    it('plain number defaults to per minute', () => {
      expect(RateLimiter.parseRateLimit('100')).toEqual([100, 60_000]);
      expect(RateLimiter.parseRateLimit(' 50 ')).toEqual([50, 60_000]);
    });

    it('parses count/minute', () => {
      expect(RateLimiter.parseRateLimit('100/minute')).toEqual([100, 60_000]);
    });

    it('parses count/second', () => {
      expect(RateLimiter.parseRateLimit('10/second')).toEqual([10, 1_000]);
    });

    it('parses count/hour', () => {
      expect(RateLimiter.parseRateLimit('5000/hour')).toEqual([
        5000, 3_600_000,
      ]);
    });

    it('parses short unit aliases', () => {
      expect(RateLimiter.parseRateLimit('50/s')).toEqual([50, 1_000]);
      expect(RateLimiter.parseRateLimit('50/sec')).toEqual([50, 1_000]);
      expect(RateLimiter.parseRateLimit('200/m')).toEqual([200, 60_000]);
      expect(RateLimiter.parseRateLimit('200/min')).toEqual([200, 60_000]);
      expect(RateLimiter.parseRateLimit('1000/h')).toEqual([1000, 3_600_000]);
      expect(RateLimiter.parseRateLimit('1000/hr')).toEqual([1000, 3_600_000]);
    });

    it('returns null for invalid formats', () => {
      expect(RateLimiter.parseRateLimit('')).toBeNull();
      expect(RateLimiter.parseRateLimit('abc')).toBeNull();
      expect(RateLimiter.parseRateLimit('0')).toBeNull();
      expect(RateLimiter.parseRateLimit('-5')).toBeNull();
      expect(RateLimiter.parseRateLimit('0/minute')).toBeNull();
      expect(RateLimiter.parseRateLimit('-5/minute')).toBeNull();
      expect(RateLimiter.parseRateLimit('100/year')).toBeNull();
    });
  });

  describe('allow', () => {
    it('allows requests under the limit', () => {
      const limiter = RateLimiter.getInstance();
      const key = 'test:under-limit';
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow(key, 5, 60_000)).toBe(true);
      }
    });

    it('blocks requests over the limit', () => {
      const limiter = RateLimiter.getInstance();
      const key = 'test:over-limit';
      for (let i = 0; i < 10; i++) {
        limiter.allow(key, 10, 60_000);
      }
      expect(limiter.allow(key, 10, 60_000)).toBe(false);
    });

    it('allows requests again after the window expires', () => {
      const limiter = RateLimiter.getInstance();
      const key = 'test:window-expiry';
      const realNow = Date.now;

      let now = 1000000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      // Fill up the bucket
      for (let i = 0; i < 3; i++) {
        expect(limiter.allow(key, 3, 1_000)).toBe(true);
      }
      expect(limiter.allow(key, 3, 1_000)).toBe(false);

      // Advance time past the window
      now += 1_001;
      expect(limiter.allow(key, 3, 1_000)).toBe(true);

      vi.restoreAllMocks();
    });

    it('uses independent counters per key', () => {
      const limiter = RateLimiter.getInstance();
      expect(limiter.allow('test:key-a', 1, 60_000)).toBe(true);
      expect(limiter.allow('test:key-a', 1, 60_000)).toBe(false);
      // Different key should still be allowed
      expect(limiter.allow('test:key-b', 1, 60_000)).toBe(true);
    });
  });
});
