// Patch console.log/warn/error to mirror into run_logs.log_lines when a
// pipeline run is active. Side-effect import — must come first so any code
// path that logs (orchestrator, adapters, AI extractors, ...) is captured.
import "./pipeline/logContext.js";

import { Worker } from "bullmq";
import { connection, QUEUE_NAME } from "./queue/connection.js";
import type { PipelineJobData } from "./queue/queue.js";
import { runPipeline } from "./pipeline/orchestrator.js";
import { syncSchedules, registerGlobalSchedules } from "./queue/scheduler.js";
import { runWeeklyDigest } from "./notifications/weeklyDigest.js";
import { sendWorkerRestartAlert } from "./notifications/errorAlert.js";
import { markExpectedShutdown, wasShutdownExpected } from "./notifications/restartDetection.js";
import { getLastKnownRun } from "./pipeline/runLog.js";
import { db } from "./db/client.js";

const worker = new Worker<PipelineJobData>(
  QUEUE_NAME,
  async (job) => {
    const { type } = job.data;
    console.log(`[worker] job ${job.id} type=${type}`);

    if (type === "noop") {
      return { ok: true, echoed: job.data.message };
    }

    if (type === "run_profile") {
      await runPipeline(job.data.profileId, job.data.trigger ?? "auto", job.data.fullRefresh ?? false);
      return { ok: true };
    }

    if (type === "sync_schedules") {
      await syncSchedules();
      return { ok: true };
    }

    if (type === "send_weekly_digest") {
      await runWeeklyDigest();
      return { ok: true };
    }

    throw new Error(`unknown job type: ${type}`);
  },
  {
    connection,
    // Concurrency MUST stay at 1 on the 512MB shared-cpu-1x machine:
    // Jora spawns a Playwright Chromium per pipeline, ~200-300MB resident.
    // Two parallel runs send the VM into swap thrashing and Jora hangs
    // silently inside makeBrowser() with no error to log. Increase only
    // if memory is bumped via `fly scale memory`.
    concurrency: 1,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed ${job?.id}:`, err.message);
});

console.log(`[worker] started — queue: ${QUEUE_NAME}`);

// ── Crash-notification: was the previous shutdown expected? ───────────────────
// See notifications/restartDetection.ts for the full mechanism. Absence of
// the marker means the previous process never reached the graceful SIGTERM
// path — covers both an uncaught-crash restart (which also alerts directly,
// below — this is the dedup-collapsed follow-up) and an OOM-kill restart
// (which has no other alerting path at all; this is the only place OOM
// notification happens, just delayed to "next boot" rather than instant).
wasShutdownExpected().then(async (expected) => {
  if (expected) {
    console.log("[worker] previous shutdown was graceful — resuming normally");
    return;
  }
  console.warn("[worker] previous shutdown was NOT graceful (no expected-shutdown marker) — alerting");
  const lastKnownRun = await getLastKnownRun();
  await sendWorkerRestartAlert(
    "Previous shutdown was not graceful — no error detail available " +
      "(likely OOM-killed or force-stopped; an uncaught in-process crash " +
      "would have sent its own alert with the real error already).",
    lastKnownRun
  );
}).catch((err) => {
  console.error("[worker] startup shutdown-marker check failed:", err);
});

// ── Graceful shutdown — mark any in-flight run_logs as failed ─────────────────
// Fly.io and Docker send SIGTERM before killing the process (default 10s grace).
// This ensures a crash/deploy never leaves a run stuck in "running" indefinitely.
// The next run will still auto-expire stale locks, but this is cleaner.
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — closing gracefully`);
  try {
    await worker.close();
    // Mark any "running" run_logs as failed — the stale auto-expire catches these
    // too, but doing it here means the next run sees clean state immediately.
    const { data: stuck } = await db
      .from("run_logs")
      .update({
        status:        "failed",
        finished_at:   new Date().toISOString(),
        error_message: `Worker shutdown (${signal}) — run interrupted mid-flight`,
      })
      .eq("status", "running")
      .select("id");
    if (stuck && stuck.length > 0) {
      console.log(`[worker] cleared ${stuck.length} in-flight run_log(s) on shutdown`);
    }
    // Mark this shutdown as expected — SIGTERM/SIGINT are how Fly stops a
    // machine for a deploy, so the next startup shouldn't alert about it.
    await markExpectedShutdown();
  } catch (err) {
    console.error("[worker] shutdown error:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ── Crash notification — the catchable half ────────────────────────────────────
// An uncaught exception or unhandled rejection is a real bug, not a deploy —
// it does NOT go through the SIGTERM shutdown() path above (nothing external
// asked the process to stop), so without this handler it would silently skip
// both the run_logs cleanup AND any alert. Node fires these events before
// actually terminating, same shape as a signal handler — deliberately NOT
// marking this an "expected" shutdown, so if this alert send itself fails,
// the startup-marker check above still catches it as a backup on next boot
// (the dedup in sendWorkerRestartAlert collapses that into one email, not two).
function crashHandler(kind: string) {
  return async (err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[worker] ${kind}:`, message);
    try {
      await sendWorkerRestartAlert(`${kind}: ${message}`, await getLastKnownRun());
    } catch (alertErr) {
      console.error("[worker] failed to send crash alert:", alertErr);
    }
    process.exit(1);
  };
}

process.on("uncaughtException",  crashHandler("uncaughtException"));
process.on("unhandledRejection", crashHandler("unhandledRejection"));

// Reconcile all active profile schedules on every startup so cron state
// in Redis stays in sync even after worker restarts or profile changes
// made while the worker was offline.
syncSchedules().catch((err) => {
  console.error("[worker] startup syncSchedules failed:", err);
});

registerGlobalSchedules().catch((err) => {
  console.error("[worker] startup registerGlobalSchedules failed:", err);
});
