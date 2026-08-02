import { db } from "../../db/client.js";
import { sendPipelineFailureAlert } from "../../notifications/errorAlert.js";

export async function checkCancellation(runLogId: string): Promise<void> {
  const { data } = await db.from("run_logs").select("status").eq("id", runLogId).maybeSingle();
  if (data?.status === "failed") {
    throw new Error("Cancelled by user");
  }
}


/**
 * Concurrency guard — two SQL operations, both done by Postgres so timezone
 * format differences between JS (.toISOString -> "Z") and Postgres ("+00:00")
 * never affect the comparison.
 *
 * Normal pipeline ceiling: ~5 min (SEEK actor is the slow one at 300s).
 * Stale threshold: 15 min - if a run is still "running" after that, the worker
 * crashed or was OOM-killed and finishRunLog never ran.
 *
 * Returns false when a genuinely active run exists and this run must skip.
 */
export async function expireStaleAndCheckActiveRun(profileId: string): Promise<boolean> {
  // Concurrency guard — two SQL operations, both done by Postgres so timezone
  // format differences between JS (.toISOString → "Z") and Postgres ("+00:00")
  // never affect the comparison.
  //
  // Normal pipeline ceiling: ~5 min (SEEK actor is the slow one at 300s).
  // Stale threshold: 15 min — if a run is still "running" after that, the worker
  // crashed or was OOM-killed and finishRunLog never ran.
  const STALE_MINUTES = 15;
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  // Step 1: expire anything that's been "running" for > STALE_MINUTES.
  // Postgres does the timestamp comparison — no JS string-vs-timezone issues.
  const { data: expired, error: expireErr } = await db
    .from("run_logs")
    .update({
      status:        "failed",
      finished_at:   new Date().toISOString(),
      error_message: `Stale lock auto-expired after ${STALE_MINUTES} min (worker crash or OOM kill)`,
    })
    .eq("profile_id", profileId)
    .eq("status", "running")
    .lt("started_at", staleThreshold)   // Postgres TIMESTAMPTZ < — correct always
    .select("id");

  if (expireErr) {
    console.warn(`[pipeline] stale-expire failed: ${expireErr.message}`);
  } else if (expired && expired.length > 0) {
    console.log(`[pipeline] expired ${expired.length} stale lock(s): ${expired.map((r) => r.id).join(", ")}`);
    await sendPipelineFailureAlert(
      profileId,
      `Stale lock auto-expired after ${STALE_MINUTES} min (worker crash or OOM kill)`,
      "stale_crash"
    );
  }

  // Step 2: check for a genuinely active run (started within the last STALE_MINUTES).
  const { data: activeRuns } = await db
    .from("run_logs")
    .select("id, started_at")
    .eq("profile_id", profileId)
    .eq("status", "running")
    .gte("started_at", staleThreshold);  // only recent ones — Postgres comparison

  if (activeRuns && activeRuns.length > 0) {
    console.log(`[pipeline] profile ${profileId} already running (run_log ${activeRuns[0].id}, started ${activeRuns[0].started_at}) — skipping`);
    return false;
  }
  return true;
}
