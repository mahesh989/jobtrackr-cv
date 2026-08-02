import { db } from "../../db/client.js";

/**
 * Lookback window from the last completed run, applied by every date-aware
 * adapter (Adzuna, SEEK, Careerjet). Avoids re-fetching jobs dedup would drop.
 *   - First run (cold start): fetch DEEP - 28 days back, more pages.
 *   - Subsequent runs (incremental): only what's new since last success
 *     + 1 day buffer for timing jitter, capped at 30 days.
 * `deepRun` also drives is_first_run (more pages per source).
 */
export async function computeLookbackWindow(
  profileId: string,
  fullRefresh: boolean,
): Promise<{ lookbackDays: number; deepRun: boolean }> {
  // Compute the lookback window from the last completed run, then apply it to
  // all date-aware adapters (Adzuna, SEEK, Careerjet). Avoids re-fetching jobs
  // the dedup would throw away anyway.
  //   - First run (cold start): fetch DEEP — 28 days back, more pages.
  //   - Subsequent runs (incremental): only what's new since last success
  //     + 1 day buffer for timing jitter, capped at 30 days.
  const FIRST_RUN_LOOKBACK_DAYS = 28;
  const { data: lastRun } = await db
    .from("run_logs")
    .select("started_at")
    .eq("profile_id", profileId)
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const isFirstRun = !lastRun;
  // A user-requested "full refresh" re-runs the deep cold-start window even
  // when prior runs exist — for when the incremental 2-3 day window is too
  // narrow and the user wants the whole backlog again.
  const deepRun = isFirstRun || fullRefresh;
  let lookbackDays: number;
  if (deepRun) {
    lookbackDays = FIRST_RUN_LOOKBACK_DAYS;
    const why = isFirstRun ? "first run — deep cold-start backfill" : "full refresh requested";
    console.log(`[pipeline] lookback: ${lookbackDays}d (${why})`);
  } else {
    // Incremental: fetch only what's new since last success + 1 day buffer
    const daysSince = Math.ceil(
      (Date.now() - new Date(lastRun!.started_at).getTime()) / 86_400_000
    );
    lookbackDays = Math.min(daysSince + 1, 30);
    console.log(`[pipeline] lookback: ${lookbackDays}d (incremental — last run ${daysSince}d ago)`);
  }
  return { lookbackDays, deepRun };
}
