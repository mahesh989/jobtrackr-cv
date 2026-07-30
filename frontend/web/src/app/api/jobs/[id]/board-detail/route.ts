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

  // All three in one flight. This used to be four sequential awaits — job,
  // then profile (to resolve ownership), then run, then letter — on top of
  // withUser's own auth round trip, so selecting a job cost five serial hops
  // to Supabase and the pane sat on a spinner for 1.5-3s every time. None of
  // them actually depend on each other's *data*: ownership is a gate, not an
  // input, so it can be checked concurrently and enforced before we respond.
  //
  // Safe to fetch before the gate resolves because every query here is already
  // scoped to this user — the run and letter both filter on user_id, and the
  // ownership row is the join itself. Nothing is returned until the check
  // below passes, and nothing user-foreign could be returned even if it didn't.
  const [ownership, runResult, letterResult] = await Promise.all([
    admin
      .from("jobs")
      .select("id, description, manual_jd_text, jd_quality, role_match, search_profiles!inner(user_id)")
      .eq("id", jobId)
      .eq("search_profiles.user_id", user.id)
      .maybeSingle(),
    admin
      .from("analysis_runs")
      .select(
        "id, status, step_status, cover_letter_status, error_message, " +
        "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, " +
        "keyword_feasibility, tailored_ats_scoring_result, injected_keywords, " +
        "quality_flags, match_score, tailored_match_score, ats_lift, " +
        "tailored_cv_storage_path, ai_provider, ai_model, created_at",
      )
      .eq("job_id", jobId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("cover_letters")
      .select("id, status, pass_3_final, tone_target, email_body, email_subject, email_sent_at")
      .eq("job_id", jobId)
      .eq("user_id", user.id)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!ownership.data) return jsonError("Job not found", 404);

  const run = runResult.data ?? null;
  const job = ownership.data as unknown as {
    description: string | null;
    manual_jd_text: string | null;
    jd_quality: string | null;
    role_match: string | null;
  };

  return NextResponse.json({
    run,
    // A letter without a run is not a state the pipeline produces, and the tabs
    // key off the run — keep the original shape rather than surfacing an orphan.
    cover_letter: run ? letterResult.data ?? null : null,
    // The JD text rides along on this per-job fetch rather than on every row of
    // the board list. It is by far the largest column on `jobs` (~2KB/row), and
    // shipping it for all ~120 cards cost ~480ms of query time and ~230KB of
    // payload to render list items that never display it. Free to add here —
    // the ownership query already reads this exact row.
    description:    job?.description ?? null,
    manual_jd_text: job?.manual_jd_text ?? null,
    // Fresh copies of the two fields the board list's own `job` prop carries
    // stale (it's the server-rendered row from selection time, never patched
    // after a JD edit or a re-classification) — the pane's pipelineState
    // recompute needs the CURRENT values or a job that just had its thin JD
    // filled in and analysed successfully gets patched right back to
    // "needs_jd" using the pre-edit "thin" flag.
    jd_quality:     job?.jd_quality ?? null,
    role_match:     job?.role_match ?? null,
  });
});
