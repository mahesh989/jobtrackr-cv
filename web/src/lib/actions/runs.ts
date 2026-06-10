"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { authedClient } from "./_helpers";

/**
 * Cancel a running analysis_run (individual job tailoring pipeline).
 * Marks the run as failed so cv-backend's orchestrator stops at its next
 * checkpoint and the Realtime subscription on the analysis page updates
 * instantly. Tokens for already-completed steps are already spent; this
 * stops any remaining steps (e.g. tailoring + cover-letter generation).
 */
export async function cancelAnalysisRun(runId: string) {
  const { supabase, user } = await authedClient();
  // Verify ownership via analysis_runs directly.
  const { data: existing } = await supabase
    .from("analysis_runs")
    .select("id, status")
    .eq("id", runId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) return;
  if (existing.status !== "pending" && existing.status !== "running") return;

  const admin = createAdminClient();
  await admin
    .from("analysis_runs")
    .update({
      status:        "failed",
      error_message: "Cancelled by user",
      completed_at:  new Date().toISOString(),
    })
    .eq("id", runId);
}

export async function cancelRun(runId: string, profileId: string) {
  const { supabase, user } = await authedClient();
  const { data: profile } = await supabase.from("search_profiles").select("id").eq("id", profileId).eq("user_id", user.id).single();
  if (!profile) return;

  // run_logs RLS exposes select/insert to the owning user but no UPDATE policy,
  // so the user-scoped client silently matches 0 rows. Use the admin client —
  // same pattern as the DELETE handler in /api/profiles/[id]/runs/route.ts.
  const admin = createAdminClient();
  await admin
    .from("run_logs")
    .update({
      status:        "failed",
      finished_at:   new Date().toISOString(),
      error_message: "Cancelled by user",
    })
    .eq("id", runId)
    .eq("status", "running");

  revalidatePath(`/dashboard/profiles/${profileId}/runs`);
  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
}

export async function getSavedJobsForRun(profileId: string, startedAt: string, finishedAt: string | null) {
  const { supabase, user } = await authedClient();
  const { data: profile } = await supabase.from("search_profiles").select("id").eq("id", profileId).eq("user_id", user.id).single();
  if (!profile) return [];

  let query = supabase
    .from("jobs")
    .select("url, title, company, location, keywords_matched, visa_likelihood, sponsorship_status, citizen_pr_only")
    .eq("profile_id", profileId)
    .gte("created_at", startedAt);
    
  if (finishedAt) {
    query = query.lte("created_at", finishedAt);
  }
  
  query = query.order("created_at", { ascending: false, nullsFirst: false });
  
  const { data } = await query;
  return data || [];
}

