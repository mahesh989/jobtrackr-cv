/**
 * C67: the API distinguishes several distinct outcomes by HTTP status (429
 * rate-limited, 402 quota/billing exceeded, 404 job not found, 422
 * validation, 502 upstream) — a bare `Error` flattened all of them to just a
 * message string, so no caller could special-case any of them (e.g. link a
 * 402 to /billing) without re-parsing the message text. `status` rides
 * alongside the message instead of being discarded.
 */
export class AnalyzeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AnalyzeApiError";
    this.status = status;
  }
}

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
  if (!res.ok) throw new AnalyzeApiError((json.error as string) ?? `Failed (${res.status})`, res.status);
  return json.run_id as string;
}
