// Expected-shutdown marker — distinguishes a deploy-triggered SIGTERM
// (expected, don't alert) from anything else the process didn't get a
// chance to announce (crash, OOM-kill, force-stop — alert on next boot).
//
// Mechanism: markExpectedShutdown() is called from index.ts's existing
// SIGTERM/SIGINT handler, right before the process exits cleanly. On the
// next startup, wasShutdownExpected() checks whether that marker is
// present. If it is, this boot follows a normal deploy — clear the marker,
// stay quiet. If it's absent, the previous process never got to announce
// its own shutdown, which is the whole point: OOM kills and force-stops
// skip every signal handler, so the *absence* of the marker is the signal.

import { connection } from "../queue/connection.js";

const MARKER_KEY = "jobtrackr:worker:expected_shutdown";
// Comfortably covers a normal deploy's stop→restart window. Short enough
// that a stale leftover key (e.g. Redis surviving a worker-side wipe)
// can't mask a real crash for long.
const MARKER_TTL_SECONDS = 10 * 60;

export async function markExpectedShutdown(): Promise<void> {
  await connection.set(MARKER_KEY, "1", "EX", MARKER_TTL_SECONDS);
}

/**
 * Call once at startup. Returns true if the previous shutdown was
 * expected (marker present — clears it), false if it wasn't (marker
 * absent — nothing to clear, caller should alert).
 */
export async function wasShutdownExpected(): Promise<boolean> {
  const marker = await connection.get(MARKER_KEY);
  if (marker === null) return false;
  await connection.del(MARKER_KEY);
  return true;
}
