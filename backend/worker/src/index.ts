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
import { runNotifySweep } from "./notifications/newJobsSweep.js";
import { sendWorkerRestartAlert } from "./notifications/errorAlert.js";
import { markExpectedShutdown, wasShutdownExpected } from "./notifications/restartDetection.js";
import { getLastKnownRun } from "./pipeline/runLog.js";
import { db } from "./db/client.js";
import { startHeartbeat } from "./queue/heartbeat.js";

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

    if (type === "run_notify_sweep") {
      await runNotifySweep();
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
    // Upstash bills per command, and BullMQ's idle loop at the defaults
    // (drainDelay 5s, stalledInterval 30s) measured 1.03 cmds/sec ≈ 2.7M
    // commands/month against this queue doing nothing. Job pickup latency
    // is unaffected: the blocking pop wakes on push; drainDelay only sets
    // how long each block waits before re-issuing. stalledInterval 5min is
    // safe with concurrency 1 — a stalled job just waits one extra cycle.
    drainDelay: 60,
    stalledInterval: 300_000,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed ${job?.id}:`, err.message);
});

const heartbeat = startHeartbeat();
console.log(`[worker] started — queue: ${QUEUE_NAME}, machine=${heartbeat.machineId}`);

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
// Fly.io and Docker send SIGTERM before killing the process (default ~5s grace
// after SIGTERM; SIGINT is sent first, so the real window is a bit longer but
// still short). This ensures a crash/deploy never leaves a run stuck in
// "running" indefinitely. The next run will still auto-expire stale locks,
// but this is cleaner.
//
// ORDERING IS LOAD-BEARING: worker.close() waits for the CURRENTLY PROCESSING
// job to finish (BullMQ's default close() behaviour with concurrency 1) —
// which for a multi-source fetch or a long auto-analyze loop can easily run
// past Fly's kill window, so the process gets SIGKILLed before close()
// resolves. Everything after that await never runs. The DB cleanup (the part
// that actually matters — it's what stops a run_logs row being orphaned in
// "running" forever) must happen FIRST and fast, not gated behind a close()
// that might never return in time. worker.close() is still attempted for a
// clean BullMQ disconnect, but only as best-effort with its own short budget.
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — closing gracefully`);
  try {
    await heartbeat.stop();
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
    // Done before worker.close() for the same reason: guaranteed to run
    // within the kill window even if close() doesn't.
    await markExpectedShutdown();
    // Best-effort only — race against a short timeout so a job that won't
    // finish in time can't block us past Fly's actual kill deadline (the
    // cleanup above already happened regardless of how this settles).
    await Promise.race([
      worker.close(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
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
const CRASH_ALERT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timed-out"> {
  return Promise.race([
    promise,
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), ms)),
  ]);
}

async function attemptCrashAlert(kind: string, message: string): Promise<void> {
  const lastKnownRun = await getLastKnownRun();
  await sendWorkerRestartAlert(`${kind}: ${message}`, lastKnownRun);
}

function crashHandler(kind: string) {
  return async (err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[worker] ${kind}:`, message);
    // The process is in an undefined state after an uncaught exception or
    // unhandled rejection — the correct pattern is attempt cleanup, then
    // exit unconditionally, never try to recover and keep running. Bound
    // the alert attempt so a hung network call (the Redis dedup check —
    // ioredis is configured with unlimited retries for BullMQ's sake, so
    // it has no timeout of its own — the run_logs read, or the Resend API)
    // can never block the exit below indefinitely. A crash handler that
    // never exits is worse than one that does: Fly's restart_policy only
    // fires on actual process exit, not on a hung-but-technically-alive one.
    try {
      const outcome = await withTimeout(attemptCrashAlert(kind, message), CRASH_ALERT_TIMEOUT_MS);
      if (outcome === "timed-out") {
        console.error(`[worker] crash alert send timed out after ${CRASH_ALERT_TIMEOUT_MS}ms — exiting anyway`);
      }
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
