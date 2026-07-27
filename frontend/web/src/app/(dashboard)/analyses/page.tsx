import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { AnalysisHistoryClient, type HistoryRun, type HistoryJob } from "@/features/cv/analysis/AnalysisHistoryClient";
export const metadata = { title: "Analyses — JobTrackr" };

export default async function AnalysesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Most recent runs for this user — capped like every other run/job list in
  // the app (dashboard, per-profile boards) instead of loading full history
  // unbounded, which grows without limit as usage accumulates.
  const RUN_HISTORY_LIMIT = 200;
  const { data: runs } = await admin
    .from("analysis_runs")
    .select(
      "id, job_id, status, match_score, tailored_match_score, ats_lift, is_stale, error_message, created_at, completed_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(RUN_HISTORY_LIMIT);

  const safeRuns = (runs ?? []) as HistoryRun[];

  // Look up the jobs they reference so we can group by job + show titles.
  const jobIds = Array.from(new Set(safeRuns.map((r) => r.job_id)));
  let jobs: HistoryJob[] = [];
  if (jobIds.length > 0) {
    const { data: jobRows } = await admin
      .from("jobs")
      .select("id, title, company, location, source, url")
      .in("id", jobIds);
    jobs = (jobRows ?? []) as HistoryJob[];
  }

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Analyses</h1>
          <p className="page-subtitle">
            {safeRuns.length >= RUN_HISTORY_LIMIT
              ? `Your ${RUN_HISTORY_LIMIT} most recent CV-tailoring analyses, grouped by job. Click any row to view the full breakdown.`
              : "Every CV-tailoring analysis you've run, grouped by job. Click any row to view the full breakdown."}
          </p>
        </div>
        <AnalysisHistoryClient initialRuns={safeRuns} jobs={jobs} />
      </div>
    </div>
  );
}
