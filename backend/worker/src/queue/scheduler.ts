import { pipelineQueue } from "./queue.js";
import { db } from "../db/client.js";

// Weekly digest: Monday 8am AEST = Sunday 10pm UTC (UTC+10)
const WEEKLY_DIGEST_CRON = "0 22 * * 0";

export async function registerGlobalSchedules(): Promise<void> {
  await pipelineQueue.upsertJobScheduler(
    "weekly-digest",
    { pattern: WEEKLY_DIGEST_CRON },
    { name: "send_weekly_digest", data: { type: "send_weekly_digest" as const } }
  );
  console.log(`[scheduler] registered global: weekly-digest (${WEEKLY_DIGEST_CRON})`);
}

const schedulerKey = (profileId: string) => `profile:${profileId}`;

export async function registerProfileSchedule(
  profileId: string,
  cron: string
): Promise<void> {
  await pipelineQueue.upsertJobScheduler(
    schedulerKey(profileId),
    { pattern: cron },
    {
      name: "run_profile",
      data: { type: "run_profile" as const, profileId },
      opts: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    }
  );
  console.log(`[scheduler] registered profile ${profileId} — cron: ${cron}`);
}

export async function removeProfileSchedule(profileId: string): Promise<void> {
  await pipelineQueue.removeJobScheduler(schedulerKey(profileId));
  console.log(`[scheduler] removed scheduler for profile ${profileId}`);
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

  const existing = await pipelineQueue.getJobSchedulers();
  const existingSet = new Set(existing.map((s) => s.id));
  const activeKeys = new Set<string>();

  for (const profile of profiles ?? []) {
    const key = schedulerKey(profile.id);
    if (profile.is_active && profile.schedule_cron) {
      try {
        await registerProfileSchedule(profile.id, profile.schedule_cron);
        activeKeys.add(key);
      } catch (err) {
        console.error(`[scheduler] failed to register profile ${profile.id}:`, err);
      }
    } else if (existingSet.has(key)) {
      try {
        await removeProfileSchedule(profile.id);
      } catch (err) {
        console.error(`[scheduler] failed to remove profile ${profile.id}:`, err);
      }
    }
  }

  // Remove orphaned schedulers (profiles deleted while worker was offline)
  for (const s of existing) {
    const sid = s.id ?? "";
    if (sid.startsWith("profile:") && !activeKeys.has(sid)) {
      try {
        await pipelineQueue.removeJobScheduler(sid);
        console.log(`[scheduler] removed orphan: ${sid}`);
      } catch (err) {
        console.error(`[scheduler] failed to remove orphan ${sid}:`, err);
      }
    }
  }

  console.log(`[scheduler] sync complete — ${profiles?.length ?? 0} profiles processed`);
}
