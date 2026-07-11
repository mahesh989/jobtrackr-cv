// Zombie-VM detector (see .claude/graph.json OPS-36): a Fly deploy on
// 2026-07-10 left an OLD worker machine running and polling Redis while the
// control plane reported it "stopped", doubling BullMQ idle command volume
// for days before it showed up on the Upstash bill. BullMQ's own
// getWorkersCount()/CLIENT LIST proved unreliable for detecting this on
// Upstash — two independent fresh connections both failed to see this
// worker's own blocking connection while it was demonstrably alive and
// ticking on schedule (proxy/vendor quirk, not a bug in bullmq). This is a
// simple application-level presence key instead: provider-agnostic, and
// directly answers "how many worker processes are alive right now" rather
// than relying on Redis's own client-connection bookkeeping.
import { connection } from "./connection.js";

export const HEARTBEAT_KEY_PREFIX = "worker:heartbeat:";
const REFRESH_INTERVAL_MS = 60_000;
const TTL_SECONDS = 150; // 2.5x the refresh interval — margin for a slow tick, not for a dead process

export function startHeartbeat(): { machineId: string; stop: () => Promise<void> } {
  // FLY_MACHINE_ID is injected automatically by Fly — falling back to a pid-based
  // id keeps this working under `npm run dev` where it's unset.
  const machineId = process.env.FLY_MACHINE_ID ?? `local:${process.pid}`;
  const key = `${HEARTBEAT_KEY_PREFIX}${machineId}`;

  const beat = () => {
    connection.set(key, Date.now().toString(), "EX", TTL_SECONDS).catch((err) => {
      console.error("[heartbeat] refresh failed:", err);
    });
  };
  beat();
  const interval = setInterval(beat, REFRESH_INTERVAL_MS);

  return {
    machineId,
    stop: async () => {
      clearInterval(interval);
      // Best-effort — if this fails (e.g. mid-crash) the TTL still expires
      // the key on its own within TTL_SECONDS, just not instantly.
      await connection.del(key).catch((err) => {
        console.error("[heartbeat] cleanup failed:", err);
      });
    },
  };
}
