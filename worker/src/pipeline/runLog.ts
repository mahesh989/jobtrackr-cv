// Run log lifecycle — written at start AND end of every pipeline run
import { db } from "../db/client.js";

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
    sources_run: string[];
    sources_saved?: Record<string, number>;
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
      sources_run: outcome.sources_run,
      sources_saved: outcome.sources_saved ?? null,
      error_message: outcome.error_message ?? null,
      current_stage: null,
    })
    .eq("id", runLogId);
}
