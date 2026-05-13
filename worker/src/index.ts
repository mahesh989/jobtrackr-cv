import { Worker } from "bullmq";
import { connection, QUEUE_NAME } from "./queue/connection.js";
import type { PipelineJobData } from "./queue/queue.js";
import { runPipeline } from "./pipeline/orchestrator.js";
import { syncSchedules, registerGlobalSchedules } from "./queue/scheduler.js";
import { runWeeklyDigest } from "./notifications/weeklyDigest.js";
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
      await runPipeline(job.data.profileId, job.data.trigger ?? "auto");
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
    concurrency: 2,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed ${job?.id}:`, err.message);
});

console.log(`[worker] started — queue: ${QUEUE_NAME}`);

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
  } catch (err) {
    console.error("[worker] shutdown error:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Reconcile all active profile schedules on every startup so cron state
// in Redis stays in sync even after worker restarts or profile changes
// made while the worker was offline.
syncSchedules().catch((err) => {
  console.error("[worker] startup syncSchedules failed:", err);
});

registerGlobalSchedules().catch((err) => {
  console.error("[worker] startup registerGlobalSchedules failed:", err);
});
