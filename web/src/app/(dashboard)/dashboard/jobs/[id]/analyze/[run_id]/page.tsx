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
    .select("id, status, step_status, jd_analysis_result, error_message, created_at")
    .eq("id", runId)
    .eq("user_id", user.id)
    .eq("job_id", jobId)
    .maybeSingle();

  if (!run) notFound();

  const { data: job } = await admin
    .from("jobs")
    .select("title, company, location, url")
    .eq("id", jobId)
    .maybeSingle();

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

      <div className="px-6 py-6 max-w-4xl">
        <AnalysisRunClient runId={runId} initial={run} />
      </div>
    </div>
  );
}
