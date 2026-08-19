// Per-source health tracking — Redis-backed consecutive failure counter.
// An adapter is "blocked" after MAX_FAILURES consecutive failures across runs.
// Counter resets to 0 on any successful fetch.
// Key expires after 7 days so a dormant adapter is automatically unblocked.

import { connection } from "../queue/connection.js";

const MAX_FAILURES = 3;
const KEY_PREFIX = "jobtrackr:health:";
const TTL_SECONDS = 60 * 60 * 24 * 7;
// A blocked source is retried at most once per cooldown window rather than
// staying blocked for the full 7-day TTL — see isBlocked()'s comment.
const PROBE_COOLDOWN_SECONDS = 60 * 60;

// Health state is namespaced per deployment. .env.example points local dev at
// the SAME Upstash instance production uses, so without this a developer
// running the worker locally shares production's failure counters — and some
// sources CANNOT succeed off-Fly (Careerjet's API is IP-whitelisted to the Fly
// egress IP), so a few local runs would reach MAX_FAILURES and block that
// source in production for the full 7-day TTL.
//
// FLY_APP_NAME is injected by Fly and is absent anywhere else, so it doubles as
// the "is this a real deployment" signal and the namespace: a future staging app
// gets its own bucket automatically rather than sharing production's.
const ENV_NS = process.env.FLY_APP_NAME ?? "local";

function key(adapterName: string): string {
  return `${KEY_PREFIX}${ENV_NS}:${adapterName}:failures`;
}

export async function recordSuccess(adapterName: string): Promise<void> {
  await connection.del(key(adapterName));
}

export async function recordFailure(adapterName: string): Promise<number> {
  const count = await connection.incr(key(adapterName));
  await connection.expire(key(adapterName), TTL_SECONDS);
  return count;
}

export async function isBlocked(adapterName: string): Promise<boolean> {
  const k = key(adapterName);
  const val = await connection.get(k);
  const count = val === null ? 0 : parseInt(val, 10);
  if (count < MAX_FAILURES) return false;

  // Blocked — but a source blocked by transient failures could otherwise
  // never clear its own counter: recordSuccess() only fires from a real
  // fetch attempt, and the caller (sourceFetch.ts) skips a blocked source
  // entirely, so with no escape hatch it stays blocked for the full 7-day
  // TTL even if the underlying issue resolved an hour later. recordFailure()
  // refreshes this key's TTL to a fresh TTL_SECONDS on every failure, so
  // (TTL_SECONDS - remaining TTL) is exactly "time since the last failure".
  // Once that exceeds PROBE_COOLDOWN_SECONDS, let ONE attempt through this
  // run — a fresh failure re-blocks it for another cooldown window (TTL
  // refreshed again), a success clears the counter entirely.
  const remaining = await connection.ttl(k);
  if (remaining < 0) return false; // no TTL set, or the key just expired — nothing to enforce
  const sinceLastFailure = TTL_SECONDS - remaining;
  return sinceLastFailure < PROBE_COOLDOWN_SECONDS;
}


