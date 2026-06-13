// Per-source health tracking — Redis-backed consecutive failure counter.
// An adapter is "blocked" after MAX_FAILURES consecutive failures across runs.
// Counter resets to 0 on any successful fetch.
// Key expires after 7 days so a dormant adapter is automatically unblocked.

import { connection } from "../queue/connection.js";

const MAX_FAILURES = 3;
const KEY_PREFIX = "jobtrackr:health:";
const TTL_SECONDS = 60 * 60 * 24 * 7;

function key(adapterName: string): string {
  return `${KEY_PREFIX}${adapterName}:failures`;
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

export async function getFailureCount(adapterName: string): Promise<number> {
  const val = await connection.get(key(adapterName));
  return val ? parseInt(val, 10) : 0;
}
