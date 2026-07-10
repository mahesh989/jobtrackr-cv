// Default import: cron-parser is CJS; Node's ESM named-export detection
// doesn't surface parseExpression as a named binding.
import cronParser from "cron-parser";
import { pipelineQueue } from "./queue.js";
import { db } from "../db/client.js";

// Crons are armed on IN-PROCESS timers, not BullMQ job schedulers. A BullMQ
// job scheduler keeps a delayed job in Redis at all times, and the mere
// existence of a delayed job caps the worker's blocking wait at a hardcoded
// 10s (bullmq worker.js `maximumBlockTimeout`) — drainDelay is ignored and
// the worker polls Upstash ~8 commands every 10s around the clock (~2M+
// commands/month billed, measured 2026-07-10). Timers enqueue a normal job
// only at tick time, so the queue holds no delayed jobs between ticks and
// the worker blocks for the full drainDelay.
//
// Trade-off vs job schedulers: a tick that lands while the worker is down
// (mid-deploy) is skipped, not queued for later. Acceptable for these
// cadences; the next tick catches up.

// Weekly digest: Monday 8am AEST = Sunday 10pm UTC (UTC+10)
const WEEKLY_DIGEST_CRON = "0 22 * * 0";

// New-jobs notification sweep — drains pending_job_notifications every 15
// minutes (5-minute settle window batches multi-profile ticks into one email).
const NOTIFY_SWEEP_CRON = "*/15 * * * *";

// setTimeout clamps delays above 2^31-1 ms (~24.8 days) to 1ms, which would
// make a long cron fire in a hot loop. Chain intermediate sleeps instead.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Next occurrence of `cron` strictly after `from` (ms epoch). Pinned to UTC:
 * all cron strings here are written against UTC (digest comment above), and
 * the old BullMQ job schedulers evaluated them in server time, which is UTC
 * on Fly — explicit tz keeps dev machines and tests consistent with that.
 */
export function nextCronTime(cron: string, from: Date): number {
  return cronParser
    .parseExpression(cron, { currentDate: from, tz: "UTC" })
    .next()
    .getTime();
}

function armAt(key: string, cron: string, at: number, enqueue: () => Promise<unknown>): void {
  const delay = at - Date.now();
  if (delay > MAX_TIMEOUT_MS) {
    timers.set(key, setTimeout(() => armAt(key, cron, at, enqueue), MAX_TIMEOUT_MS));
    return;
  }
  timers.set(
    key,
    setTimeout(() => {
      // Re-arm before enqueueing so a slow/failed enqueue can never stall
      // the schedule; next occurrence is computed from this tick's time so
      // a delayed callback can't skip a tick.
      armAt(key, cron, nextCronTime(cron, new Date(at)), enqueue);
      enqueue().catch((err) => {
        console.error(`[scheduler] enqueue failed for ${key}:`, err);
      });
    }, Math.max(0, delay))
  );
}

function schedule(key: string, cron: string, enqueue: () => Promise<unknown>): void {
  clearSchedule(key);
  armAt(key, cron, nextCronTime(cron, new Date()), enqueue);
}

function clearSchedule(key: string): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
}

/**
 * One-time migration: earlier versions registered BullMQ job schedulers,
 * whose persistent delayed jobs are exactly what re-triggers the 10s block
 * cap. Remove any that remain in Redis. No-ops (one getJobSchedulers read)
 * once Redis is clean.
 */
async function removeRedisJobSchedulers(): Promise<void> {
  try {
    const existing = await pipelineQueue.getJobSchedulers();
    for (const s of existing) {
      if (!s.id) continue;
      await pipelineQueue.removeJobScheduler(s.id);
      console.log(`[scheduler] removed legacy Redis job scheduler: ${s.id}`);
    }
  } catch (err) {
    console.error("[scheduler] legacy job-scheduler cleanup failed:", err);
  }
}

export async function registerGlobalSchedules(): Promise<void> {
  schedule("weekly-digest", WEEKLY_DIGEST_CRON, () =>
    pipelineQueue.add("send_weekly_digest", { type: "send_weekly_digest" as const })
  );
  console.log(`[scheduler] armed global: weekly-digest (${WEEKLY_DIGEST_CRON})`);

  schedule("notify-sweep", NOTIFY_SWEEP_CRON, () =>
    pipelineQueue.add("run_notify_sweep", { type: "run_notify_sweep" as const })
  );
  console.log(`[scheduler] armed global: notify-sweep (${NOTIFY_SWEEP_CRON})`);

  await removeRedisJobSchedulers();
}

const schedulerKey = (profileId: string) => `profile:${profileId}`;

export async function registerProfileSchedule(
  profileId: string,
  cron: string
): Promise<void> {
  schedule(schedulerKey(profileId), cron, () =>
    pipelineQueue.add(
      "run_profile",
      { type: "run_profile" as const, profileId },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
    )
  );
  console.log(`[scheduler] armed profile ${profileId} — cron: ${cron}`);
}

export async function removeProfileSchedule(profileId: string): Promise<void> {
  clearSchedule(schedulerKey(profileId));
  console.log(`[scheduler] removed schedule for profile ${profileId}`);
}

export async function syncSchedules(): Promise<void> {
  console.log("[scheduler] syncing schedules...");

  const { data: profiles, error } = await db
    .from("search_profiles")
    .select("id, schedule_cron, is_active, is_manual")
    .eq("is_manual", false);  // Saved Jobs profiles must never be auto-fetched

  if (error) {
    console.error("[scheduler] failed to load profiles:", error.message);
    return;
  }

  const activeKeys = new Set<string>();

  for (const profile of profiles ?? []) {
    const key = schedulerKey(profile.id);
    if (profile.is_active && profile.schedule_cron) {
      try {
        await registerProfileSchedule(profile.id, profile.schedule_cron);
        activeKeys.add(key);
      } catch (err) {
        console.error(`[scheduler] failed to arm profile ${profile.id}:`, err);
      }
    } else {
      clearSchedule(key);
    }
  }

  // Remove orphaned timers (profiles deleted or deactivated since last sync)
  for (const key of [...timers.keys()]) {
    if (key.startsWith("profile:") && !activeKeys.has(key)) {
      clearSchedule(key);
      console.log(`[scheduler] removed orphan: ${key}`);
    }
  }

  console.log(`[scheduler] sync complete — ${profiles?.length ?? 0} profiles processed`);
}
