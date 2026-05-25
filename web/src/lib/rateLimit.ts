/**
 * Fixed-window rate limiter backed by the existing Upstash Redis (REDIS_URL).
 *
 * Design choices:
 *  - FAIL-OPEN: if Redis is unset or unreachable, requests are allowed. A rate
 *    limiter must never take the whole app down — degrading to "no limiting" is
 *    the safe failure mode. (This also means a misconfigured REDIS_URL silently
 *    disables limiting rather than 500-ing every request.)
 *  - One short-lived connection per call, mirroring the existing per-request
 *    Redis usage in profiles/[id]/run and lib/actions.
 *
 * Usage:
 *   const rl = await rateLimit(`analyze:${user.id}`, 20, 60);
 *   if (!rl.allowed) return tooMany();
 */

import { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { allowed: true, remaining: limit }; // not configured → fail open

  let redis: Redis | null = null;
  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      retryStrategy: () => null, // don't retry — fail fast, then fail open
      ...(url.startsWith("rediss://") ? { tls: {} } : {}),
    });

    const redisKey = `rl:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (err) {
    console.error(
      "[rateLimit] redis error (failing open):",
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true, remaining: limit };
  } finally {
    if (redis) {
      try { await redis.quit(); } catch { /* ignore */ }
    }
  }
}

/** Standard 429 JSON response body. */
export const RATE_LIMIT_MESSAGE = "Too many requests — please slow down and try again shortly.";
