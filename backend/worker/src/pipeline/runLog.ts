// Run log lifecycle — written at start AND end of every pipeline run
import { db } from "../db/client.js";

/**
 * Most recent run_logs row across all profiles, regardless of status.
 * Used by the worker-restart alert to give "what was the worker doing
 * last" context — best-effort, never throws (a failed read shouldn't
 * block sending the alert itself).
 */
export async function getLastKnownRun(): Promise<
  { profileId: string; status: string; startedAt: string } | null
> {
  try {
    const { data } = await db
      .from("run_logs")
      .select("profile_id, status, started_at")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      profileId: data.profile_id as string,
      status:    data.status as string,
      startedAt: data.started_at as string,
    };
  } catch (err) {
    console.warn(`[runLog] getLastKnownRun failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function startRunLog(profileId: string): Promise<string> {
  const { data, error } = await db
    .from("run_logs")
    .insert({ profile_id: profileId, status: "running", current_stage: "starting" })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create run_log: ${error?.message}`);
  }
  return data.id as string;
}

// Best-effort progress write. Never throws — UI signal only.
export async function setStage(runLogId: string, stage: string): Promise<void> {
  const { error } = await db
    .from("run_logs")
    .update({ current_stage: stage })
    .eq("id", runLogId);
  if (error) console.warn(`[runLog] setStage(${stage}) failed: ${error.message}`);
}

export async function finishRunLog(
  runLogId: string,
  outcome: {
    status: "completed" | "failed";
    jobs_fetched: number;
    jobs_after_dedup: number;
    jobs_saved: number;
    jobs_deduped?: number;
    sources_run: string[];
    sources_saved?: Record<string, number>;
    source_methods?: Record<string, unknown>;
    error_message?: string;
  }
): Promise<void> {
  await db
    .from("run_logs")
    .update({
      finished_at: new Date().toISOString(),
      status: outcome.status,
      jobs_fetched: outcome.jobs_fetched,
      jobs_after_dedup: outcome.jobs_after_dedup,
      jobs_saved: outcome.jobs_saved,
      jobs_deduped: outcome.jobs_deduped ?? 0,
      sources_run: outcome.sources_run,
      sources_saved: outcome.sources_saved ?? null,
      source_methods: outcome.source_methods ?? null,
      error_message: outcome.error_message ?? null,
      current_stage: null,
    })
    .eq("id", runLogId);
}
