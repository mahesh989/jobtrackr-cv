import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { AnalysisRunClient } from "@/components/cv/AnalysisRunClient";
import { CoverLetterPanel }  from "@/components/cv/CoverLetterPanel";

interface Props {
  params: Promise<{ id: string; run_id: string }>;
}

export const metadata = { title: "Analysis — JobTrackr" };

export default async function AnalyzeRunPage({ params }: Props) {
  const { id: jobId, run_id: runId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("analysis_runs")
    .select(
      "id, job_id, status, step_status, cover_letter_status, " +
      "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, " +
      "input_recommendations, keyword_feasibility, ai_recommendations, " +
      "tailored_cv_storage_path, tailored_pdf_storage_path, tailored_ats_scoring_result, injected_keywords, " +
      "match_score, tailored_match_score, ats_lift, " +
      "error_message, jd_text, ai_provider, ai_model, cv_version_id, created_at",
    )
    .eq("id", runId)
    .eq("user_id", user.id)
    .eq("job_id", jobId)
    .maybeSingle();

  if (!run) notFound();

  const { data: job } = await admin
    .from("jobs")
    .select("title, company, location, url, manual_jd_text, description, hiring_manager")
    .eq("id", jobId)
    .maybeSingle();

  // Look up the CV label that was used so the diagnostic shows
  // "Master CV 2026" rather than a UUID.
  const cvVersionId = (run as unknown as { cv_version_id: string }).cv_version_id;
  const { data: cv } = await admin
    .from("cv_versions")
    .select("label, cv_text, categorised_skills")
    .eq("id", cvVersionId)
    .maybeSingle();
  const cvLabel     = cv?.label ?? null;
  const cvCharLen   = (cv?.cv_text ?? "").length;
  const cvSkills    = (cv?.categorised_skills as { technical?: string[]; soft_skills?: string[]; domain_knowledge?: string[] } | null) ?? null;

  // Soft-stale check: compare the JD text snapshot the run used against the
  // job's current JD source (manual override if present, else description).
  // If they differ, the user has edited the input — surface a banner.
  const currentJd = (job?.manual_jd_text ?? job?.description ?? "").trim();
  const ranJd     = ((run as unknown as { jd_text: string }).jd_text ?? "").trim();
  const jdChanged = currentJd.length > 0 && ranJd.length > 0 && currentJd !== ranJd;

  // Pre-fetch most recent non-stale cover letter for this job (if any)
  const { data: existingLetter } = await admin
    .from("cover_letters")
    .select(
      "id, status, generation_status, pass_3_final, burstiness_score, " +
      "naturalness_score, coherence_score, specificity_ok, honesty_ok, " +
      "quality_flags, company_hook_text, tone_target, error_message, " +
      "pass_1_model, pass_2_model, pass_3_model",
    )
    .eq("user_id", user.id)
    .eq("job_id", jobId)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const runStatus    = (run as unknown as { status: string }).status;
  const completedAt  = (run as unknown as { completed_at: string | null }).completed_at;
  const subtitleText =
    runStatus === "running"   ? "Pipeline running…" :
    runStatus === "pending"   ? "Pipeline queued — starting shortly." :
    runStatus === "completed" ? `Completed${completedAt ? " · " + new Date(completedAt).toLocaleString("en-AU") : ""}` :
    runStatus === "failed"    ? "Failed." :
                                "";

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <a
          href="/dashboard/analyses"
          className="inline-flex items-center text-[12px] text-text-3 hover:text-text"
        >
          ← Back to analyses
        </a>
        <h1 className="mt-1 text-[20px] font-serif font-bold text-text">Analysis Run</h1>
        <p className="text-[12px] text-text-3 italic mt-0.5">{subtitleText}</p>
        <p className="text-[11px] text-text-3 mt-1 truncate">
          <span className="font-medium text-text-2">{job?.title ?? "Job"}</span>
          {job?.company ? ` · ${job.company}` : ""}
          {job?.location ? ` · ${job.location}` : ""}
          {job?.url && (
            <>
              {" · "}
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">
                Listing ↗
              </a>
            </>
          )}
        </p>
      </div>

      <div className="px-6 pt-6 pb-24">
        <div className="max-w-4xl mx-auto space-y-4">
        {jdChanged && (
          <div className="rounded-md bg-[#FFF8C5] border border-[#D4A72C]/40 px-4 py-3 text-[12px] text-[#9A6700]">
            <strong className="font-semibold">JD has changed since this analysis ran.</strong>{" "}
            The job description you saved is different from what was analysed.{" "}
            <a href={`/dashboard/profiles`} className="underline hover:opacity-80">
              Re-run from the job board
            </a>{" "}
            to refresh with the current JD.
          </div>
        )}
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <AnalysisRunClient
          runId={runId}
          initial={run as any}
          cvLabel={cvLabel}
          cvCharLen={cvCharLen}
          cvCategorisedSkills={cvSkills}
        />
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CoverLetterPanel
          jobId={jobId}
          initial={existingLetter as any}
          jobHiringManager={job?.hiring_manager ?? null}
        />
        </div>
      </div>
    </div>
  );
}
