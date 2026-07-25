// Recent CV-analysis runs for the dashboard-wide RunNotifier toast.
//
// Sibling of /api/user/runs, which covers the job-*sourcing* pipeline
// (run_logs). CV analysis writes to analysis_runs and had no notifier at all,
// so a 1–2 minute analysis finished silently. The Realtime payload carries the
// run row but not the job title, so the client re-fetches this enriched feed on
// a terminal transition, exactly as it does for sourcing runs.

import { NextResponse } from "next/server";
import { jsonError, withUser } from "@/lib/api-utils";

interface AnalysisRunRow {
  id:                   string;
  job_id:               string;
  status:               string;
  match_score:          number | null;
  tailored_match_score: number | null;
  created_at:           string;
  jobs: { title: string | null; company: string | null } | null;
}

export const GET = withUser(async (_req, _ctx, { user, supabase }) => {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // analysis_runs carries user_id directly, so ownership needs no join —
  // `jobs` is joined only for the toast's display title.
  const { data, error } = await supabase
    .from("analysis_runs")
    .select("id, job_id, status, match_score, tailored_match_score, created_at, jobs(title, company)")
    .eq("user_id", user.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const runs = ((data ?? []) as unknown as AnalysisRunRow[]).map((r) => ({
    id:           r.id,
    job_id:       r.job_id,
    job_title:    r.jobs?.title ?? "Job",
    company:      r.jobs?.company ?? null,
    status:       r.status,
    match_score:  r.match_score,
    tailored_match_score: r.tailored_match_score,
  }));

  return NextResponse.json({ runs });
});
