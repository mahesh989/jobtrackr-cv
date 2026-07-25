/**
 * GET /api/jobs/[id]/board-detail
 *
 * Lean payload for the job-board's right-hand detail pane (master-detail
 * redesign). The board list already carries everything summary-level AND
 * the full JD text (atsBand, atsThresholds, progress, pipelineState, scores,
 * jd_quality, description, manual_jd_text) via BoardJob — this route only
 * returns what ISN'T on that object: the deep JSON blobs from the latest
 * analysis_run, and the cover letter row.
 *
 * Returns null run/cover_letter when they don't exist yet (not-analysed /
 * needs-JD / stopped-early jobs) — the client renders per-tab based on what's
 * actually present, never a placeholder for missing data.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { jsonError, withUser } from "@/lib/api-utils";

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id: jobId } = await params;
  const admin = createAdminClient();

  // Ownership: job → profile → user (same chain as PATCH /api/jobs/[id]).
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return jsonError("Job not found", 404);

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return jsonError("Job not found", 404);
  }

  const { data: run } = await admin
    .from("analysis_runs")
    .select(
      "id, status, step_status, cover_letter_status, error_message, " +
      "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, " +
      "keyword_feasibility, tailored_ats_scoring_result, injected_keywords, " +
      "quality_flags, match_score, tailored_match_score, ats_lift, " +
      "tailored_cv_storage_path, ai_provider, ai_model, created_at",
    )
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let coverLetter: Record<string, unknown> | null = null;
  if (run) {
    const { data: letter } = await admin
      .from("cover_letters")
      .select("id, status, pass_3_final, tone_target, email_body, email_subject")
      .eq("job_id", jobId)
      .eq("user_id", user.id)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    coverLetter = letter ?? null;
  }

  return NextResponse.json({
    run: run ?? null,
    cover_letter: coverLetter,
  });
});
