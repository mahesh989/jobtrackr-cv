// Post-deploy CI guard against the zombie-VM pattern (2026-07-10 incident,
// see .claude/graph.json OPS-36): a Fly deploy can leave the OLD machine
// running and polling Redis while the control plane reports it "stopped",
// doubling BullMQ idle command volume for days before anyone notices via
// the Upstash bill.
//
// Counts distinct worker:heartbeat:<machineId> keys (queue/heartbeat.ts) —
// deliberately NOT BullMQ's getWorkersCount()/CLIENT LIST: two independent
// checks against this Upstash instance failed to see a worker's own
// blocking connection while it was demonstrably alive (proxy/vendor quirk),
// which would make CLIENT LIST-based detection silently under-count and
// miss a real zombie. The heartbeat key is written by the app itself, so
// its presence directly answers "is a process alive right now" regardless
// of what Redis's own connection bookkeeping reports.
//
// A short overlap (old worker's heartbeat not yet expired while the new
// one starts) is normal during a rolling deploy, so this polls with a
// grace window and only fails if more than one heartbeat is still present
// once that window closes.
import { connection } from "../queue/connection.js";
import { HEARTBEAT_KEY_PREFIX } from "../queue/heartbeat.js";

const POLL_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 6; // 60s grace window

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanHeartbeatKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await connection.scan(cursor, "MATCH", `${HEARTBEAT_KEY_PREFIX}*`, "COUNT", 100);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return keys;
}

async function main(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const keys = await scanHeartbeatKeys();
    console.log(`[check] attempt ${attempt}/${MAX_ATTEMPTS}: ${keys.length} live worker heartbeat(s): ${keys.join(", ") || "(none)"}`);

    if (keys.length <= 1) {
      console.log("[check] OK — single worker confirmed");
      connection.disconnect();
      process.exit(0);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(`[check] >1 heartbeat seen — could be a rolling-deploy overlap, retrying in ${POLL_INTERVAL_MS / 1000}s...`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const keys = await scanHeartbeatKeys();
  console.error(`[check] FAILED — ${keys.length} worker heartbeats still present after ${MAX_ATTEMPTS} attempts: ${keys.join(", ")}`);
  console.error("[check] This is the zombie-VM pattern: an old Fly machine is still polling Redis.");
  console.error("");
  console.error("[check] Remediate: fly machine list -a jobtrackr-worker   (cross-reference the machine IDs above against this list)");
  console.error("[check]            fly machine destroy <stale-id> --force -a jobtrackr-worker");
  console.error("[check]            fly logs -a jobtrackr-worker --no-tail   (confirm only one machine is logging)");

  connection.disconnect();
  process.exit(1);
}

main().catch((err) => {
  console.error("[check] script error:", err);
  process.exit(1);
});
