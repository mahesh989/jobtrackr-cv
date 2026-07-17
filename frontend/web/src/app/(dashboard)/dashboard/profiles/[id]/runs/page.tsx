import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { cancelRun } from "@/lib/actions";
import { RunJobsTable } from "@/features/profiles/RunJobsTable";
import { LiveRunStatus } from "@/features/profiles/LiveRunStatus";
import { LiveLogConsole } from "@/features/profiles/LiveLogConsole";
import { Badge, Button } from "@/ui";

export default async function RunHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!profile) redirect("/dashboard");
  const p = profile as { id: string; name: string };

  const { data: runs } = await supabase
    .from("run_logs")
    .select("id, started_at, finished_at, status, current_stage, jobs_fetched, jobs_after_dedup, jobs_saved, sources_run, error_message, ai_tokens_input, ai_tokens_output, ai_cost_cents")
    .eq("profile_id", id)
    .order("started_at", { ascending: false })
    .limit(50);

  type RunRow = {
    id: string; started_at: string; finished_at: string | null; status: string;
    current_stage: string | null;
    jobs_fetched: number; jobs_after_dedup: number; jobs_saved: number;
    sources_run: string[]; error_message: string | null;
    ai_tokens_input: number; ai_tokens_output: number; ai_cost_cents: number;
  };
  const runList = (runs ?? []) as RunRow[];

  function duration(start: string, end: string | null) {
    if (!end) return "running…";
    const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function costLabel(millicents: number) {
    if (!millicents) return null;
    const cents = millicents / 1000;
    return cents < 100 ? `<$0.01` : `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <Link href="/dashboard/profiles" className="hover:text-text transition-colors">Job Searches</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <Link href={`/dashboard/profiles/${id}/jobs`} className="hover:text-text transition-colors truncate max-w-[200px]">
                {p.name}
              </Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Run history</span>
            </div>
            <h1 className="text-[16px] font-semibold text-text">Run history</h1>
          </div>
          <Link href={`/dashboard/profiles/${id}/jobs`}>
            <Button size="sm" className="px-2.5 py-1">← Back to jobs</Button>
          </Link>
        </div>
      </div>

      <div className="px-6 py-5">
        <LiveRunStatus
          profileId={id}
          initialIsRunning={runList.some((r) => r.status === "running")}
        />
        <LiveLogConsole profileId={id} />

        {runList.length === 0 ? (
          <div className="bg-surface border border-border rounded-md flex flex-col items-center justify-center py-16 text-center anim-in">
            <div className="w-10 h-10 rounded-md bg-[var(--surface-2)] border border-border flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-text-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <p className="text-[14px] font-semibold text-text mb-1">No runs yet</p>
            <p className="text-[12px] text-text-2">Trigger a run from the dashboard to see history here.</p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-md overflow-hidden anim-in">
            {/* Table header */}
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[var(--surface-2)] border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
              <div className="col-span-3">Started</div>
              <div className="col-span-1">Duration</div>
              <div className="col-span-1 text-center">Status</div>
              <div className="col-span-1 text-center">Fetched</div>
              <div className="col-span-1 text-center">Deduped</div>
              <div className="col-span-1 text-center">Saved</div>
              <div className="col-span-2">Sources</div>
              <div className="col-span-1 text-right">AI cost</div>
              <div className="col-span-1 text-right">Actions</div>
            </div>

            {runList.map((run, i) => {
              const isRunning = run.status === "running";
              const isFailed  = run.status === "failed";
              const isDone    = run.status === "completed";

              return (
                <div key={run.id} className={`border-b border-border last:border-0 anim-in anim-delay-${Math.min(i, 5)}`}>
                  <div className={`grid grid-cols-12 gap-2 px-4 py-3 hover:bg-[var(--surface-2)] transition-colors ${
                    isRunning ? "border-l-2 border-l-[var(--brand)]" : ""
                  }`}>
                    {/* Started */}
                    <div className="col-span-3 flex items-center gap-2">
                      {isRunning && (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75"/>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--brand)]"/>
                        </span>
                      )}
                      <span className="text-[12px] font-medium text-text">
                        {new Date(run.started_at).toLocaleString("en-AU", {
                          day: "numeric", month: "short",
                          hour: "numeric", minute: "2-digit",
                        })}
                      </span>
                    </div>

                    {/* Duration */}
                    <div className="col-span-1 flex items-center">
                      <span
                        className={`text-[12px] ${isRunning ? "text-[var(--brand)] font-medium" : "text-text-2"}`}
                        title={isRunning && run.current_stage ? run.current_stage : undefined}
                      >
                        {isRunning && run.current_stage
                          ? run.current_stage
                          : duration(run.started_at, run.finished_at)}
                      </span>
                    </div>

                    {/* Status */}
                    <div className="col-span-1 flex items-center justify-center">
                      {isRunning ? (
                        <Badge variant="blue" className="text-[10px]">Running</Badge>
                      ) : isFailed ? (
                        <Badge variant="red" className="text-[10px]">Failed</Badge>
                      ) : isDone ? (
                        <Badge variant="green" className="text-[10px]">Done</Badge>
                      ) : (
                        <Badge variant="gray" className="text-[10px]">{run.status}</Badge>
                      )}
                    </div>

                    {/* Fetched */}
                    <div className="col-span-1 flex items-center justify-center">
                      <span className="text-[12px] text-text-2">{run.jobs_fetched ?? "—"}</span>
                    </div>

                    {/* Deduped */}
                    <div className="col-span-1 flex items-center justify-center">
                      <span className="text-[12px] text-text-2">{run.jobs_after_dedup ?? "—"}</span>
                    </div>

                    {/* Saved */}
                    <div className="col-span-1 flex items-center justify-center">
                      {run.jobs_saved > 0 ? (
                        <span className="text-[12px] font-semibold text-[#1A7F37]">+{run.jobs_saved}</span>
                      ) : (
                        <span className="text-[12px] text-text-3">—</span>
                      )}
                    </div>

                    {/* Sources */}
                    <div className="col-span-2 flex items-center">
                      <span className="text-[11px] text-text-2 truncate">
                        {run.sources_run?.length > 0
                          ? `${run.sources_run.length} source${run.sources_run.length !== 1 ? "s" : ""}`
                          : "—"}
                      </span>
                    </div>

                    {/* AI cost */}
                    <div className="col-span-1 flex items-center justify-end">
                      <span className="text-[11px] text-text-3">
                        {costLabel(run.ai_cost_cents) ?? "—"}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="col-span-1 flex items-center justify-end">
                      {isRunning && (
                        <form action={cancelRun.bind(null, run.id, id)}>
                          <Button type="submit" size="sm" className="px-2 py-1 text-[#CF222E] hover:bg-[#FFEBE9] hover:border-[#CF222E]/30">
                            Cancel
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>

                  {/* Error message */}
                  {run.error_message && (
                    <div className="px-4 pb-3">
                      <p className="text-[11px] text-[#CF222E] bg-[#FFEBE9] border border-[#CF222E]/20 rounded px-3 py-2">
                        {run.error_message}
                      </p>
                    </div>
                  )}

                  {/* Expandable saved jobs */}
                  {run.jobs_saved > 0 && (
                    <div className="px-4 pb-3">
                      <RunJobsTable
                        profileId={id}
                        startedAt={run.started_at}
                        finishedAt={run.finished_at}
                        jobsSaved={run.jobs_saved}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
