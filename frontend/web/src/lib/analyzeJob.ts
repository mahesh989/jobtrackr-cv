/**
 * Client-side helper to kick off (or re-run) a job analysis.
 * POSTs /api/jobs/[id]/analyze and returns the new run id.
 * Shared by the jobs board (CardMenu, JobEditModal) and the cv/analysis
 * feature (AnalyzeJobButton) — lives in lib/ so neither feature imports
 * the other's internals for it.
 */
export async function triggerReanalyze(jobId: string): Promise<string> {
  const res  = await fetch(`/api/jobs/${jobId}/analyze`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error as string) ?? `Failed (${res.status})`);
  return json.run_id as string;
}
