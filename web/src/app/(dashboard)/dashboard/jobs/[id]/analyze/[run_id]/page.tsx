import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { AnalysisRunClient } from "@/components/cv/AnalysisRunClient";

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
      "id, status, step_status, " +
      "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, " +
      "input_recommendations, keyword_feasibility, ai_recommendations, " +
      "tailored_cv_storage_path, tailored_ats_scoring_result, injected_keywords, " +
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
    .select("title, company, location, url, manual_jd_text, description")
    .eq("id", jobId)
    .maybeSingle();

  // Look up the CV label that was used so the diagnostic shows
  // "Master CV 2026" rather than a UUID.
  const cvVersionId = (run as unknown as { cv_version_id: string }).cv_version_id;
  const { data: cv } = await admin
    .from("cv_versions")
    .select("label, cv_text")
    .eq("id", cvVersionId)
    .maybeSingle();
  const cvLabel    = cv?.label ?? null;
  const cvCharLen  = (cv?.cv_text ?? "").length;

  // Soft-stale check: compare the JD text snapshot the run used against the
  // job's current JD source (manual override if present, else description).
  // If they differ, the user has edited the input — surface a banner.
  const currentJd = (job?.manual_jd_text ?? job?.description ?? "").trim();
  const ranJd     = ((run as unknown as { jd_text: string }).jd_text ?? "").trim();
  const jdChanged = currentJd.length > 0 && ranJd.length > 0 && currentJd !== ranJd;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">
          {job?.title ?? "Analysis"}{job?.company ? ` · ${job.company}` : ""}
        </h1>
        <p className="text-[12px] text-text-3 mt-0.5">
          {job?.location ?? ""}
          {job?.url && (
            <>
              {" · "}
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">
                Job listing ↗
              </a>
            </>
          )}
        </p>
      </div>

      <div className="px-6 py-6 max-w-4xl space-y-4">
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
        <AnalysisRunClient runId={runId} initial={run as any} cvLabel={cvLabel} cvCharLen={cvCharLen} />
      </div>
    </div>
  );
}
