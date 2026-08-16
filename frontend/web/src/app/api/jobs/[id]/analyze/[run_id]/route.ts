/**
 * GET /api/jobs/[id]/analyze/[run_id]
 *
 * JSON twin of the `/jobs/[id]/analyze/[run_id]` server page, trimmed to
 * what the board's "Full analysis" popup actually needs: the run row +
 * enough CV metadata for AnalysisRunClient's "Run details" panel and skills
 * summary. No cover-letter content — that popup deliberately stays scoped to
 * the JD/matching/tailoring analysis; the CV and cover letter already have
 * their own tabs in the board's detail pane.
 *
 * Ownership check mirrors the page's exactly (same three signals): a run row
 * has no direct FK back to a user-owned table other than through the job's
 * search_profile, which can be stale after the auth migration re-owned
 * cover_letters but not search_profiles — see that page's own comment.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { jsonError, withUser } from "@/lib/api-utils";

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; run_id: string }> },
  { user },
) => {
  const { id: jobId, run_id: runId } = await params;
  const admin = createAdminClient();

  const [{ data: job }, { data: run }] = await Promise.all([
    admin.from("jobs").select("profile_id").eq("id", jobId).maybeSingle(),
    admin.from("analysis_runs")
      .select(
        "id, job_id, status, step_status, cover_letter_status, " +
        "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, " +
        "input_recommendations, keyword_feasibility, ai_recommendations, " +
        "tailored_cv_storage_path, tailored_pdf_storage_path, tailored_ats_scoring_result, injected_keywords, " +
        "match_score, tailored_match_score, ats_lift, quality_flags, " +
        "error_message, jd_text, ai_provider, ai_model, cv_version_id, created_at, user_id",
      )
      .eq("id", runId)
      .eq("job_id", jobId)
      .maybeSingle(),
  ]);

  if (!job) return jsonError("Job not found", 404);
  if (!run) return jsonError("Analysis run not found", 404);

  const jobRow = job as { profile_id: string };
  const runRow = run as unknown as { user_id: string | null; cv_version_id: string | null };

  const [{ data: profile }, { count: ownedLetters }] = await Promise.all([
    admin.from("search_profiles").select("user_id").eq("id", jobRow.profile_id).maybeSingle(),
    admin.from("cover_letters").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("user_id", user.id),
  ]);

  const ownsJob =
    (profile as { user_id?: string } | null)?.user_id === user.id ||
    runRow.user_id === user.id ||
    (ownedLetters ?? 0) > 0;
  if (!ownsJob) return jsonError("Job not found", 404);

  const cvVersionId = runRow.cv_version_id;
  const { data: cv } = cvVersionId
    ? await admin.from("cv_versions").select("label, cv_text, categorised_skills").eq("id", cvVersionId).maybeSingle()
    : { data: null };
  const cvRow = cv as { label: string | null; cv_text: string | null; categorised_skills: unknown } | null;

  return NextResponse.json({
    run,
    cvLabel:             cvRow?.label ?? null,
    cvCharLen:           (cvRow?.cv_text ?? "").length,
    cvCategorisedSkills: cvRow?.categorised_skills ?? null,
  });
});
