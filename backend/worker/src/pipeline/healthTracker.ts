// Per-source health tracking — Redis-backed consecutive failure counter.
// An adapter is "blocked" after MAX_FAILURES consecutive failures across runs.
// Counter resets to 0 on any successful fetch.
// Key expires after 7 days so a dormant adapter is automatically unblocked.

import { connection } from "../queue/connection.js";

const MAX_FAILURES = 3;
const KEY_PREFIX = "jobtrackr:health:";
const TTL_SECONDS = 60 * 60 * 24 * 7;

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
  const val = await connection.get(key(adapterName));
  return val !== null && parseInt(val, 10) >= MAX_FAILURES;
}


