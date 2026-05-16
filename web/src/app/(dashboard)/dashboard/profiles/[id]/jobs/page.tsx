import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { JobTable } from "@/components/JobTable";
import { JobStatusTabs } from "@/components/JobFilters";
import { JobFilterBar } from "@/components/JobFilterBar";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { MarkSeenOnLoad } from "@/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/components/LiveRunStatus";

interface SearchParams {
  sort?: string; dir?: string; status?: string;
  min_keywords?: string; min_visa?: string; visa_toggle?: string;
  source?: string; location?: string; posted_within?: string;
}

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, keywords, schedule_cron")
    .eq("id", id).eq("user_id", user.id).single();
  if (!profile) redirect("/dashboard");

  const { data: activeRun } = await supabase
    .from("run_logs")
    .select("id")
    .eq("profile_id", id)
    .eq("status", "running")
    .maybeSingle();
  const isRunning = !!activeRun;

  const p = profile as {
    id: string; name: string; is_active: boolean;
    keywords: string[]; schedule_cron: string;
  };

  // Build filtered query
  let query = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  // Status filter
  if (sp.status === "new")       query = query.is("seen_at", null).is("dismissed_at", null);
  else if (sp.status === "applied")   query = query.not("applied_at", "is", null).is("dismissed_at", null);
  else if (sp.status === "dismissed") query = query.not("dismissed_at", "is", null);
  else                                query = query.is("dismissed_at", null);

  if (sp.location) query = query.ilike("location", `%${sp.location}%`);

  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      query = query.gte("posted_at", d.toISOString());
    }
  }

  const sortCol = sp.sort ?? "posted_at";
  const sortDir = sp.dir === "asc";
  const allowed = ["title", "company", "location", "posted_at", "created_at", "visa_likelihood"];
  query = allowed.includes(sortCol)
    ? query.order(sortCol, { ascending: sortDir, nullsFirst: false })
    : query.order("posted_at", { ascending: false, nullsFirst: false });

  query = query.limit(200);
  const { data: jobs } = await query;
  let jobList = (jobs ?? []) as any[];

  if (sp.min_keywords) {
    const minK = parseInt(sp.min_keywords, 10);
    if (!isNaN(minK)) jobList = jobList.filter((j) => (j.keywords_matched?.length ?? 0) >= minK);
  }

  // ── Latest non-stale analysis run per job (for the 'View analysis' affordance)
  // We pull all non-stale runs scoped to this profile's jobs, then group client-side.
  const jobIds = jobList.map((j) => j.id);
  const { data: recentRuns } = jobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("id, job_id, status, created_at")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as Array<{ id: string; job_id: string; status: string; created_at: string }> };

  const latestRunByJob = new Map<string, { id: string; status: string }>();
  for (const r of recentRuns ?? []) {
    if (!latestRunByJob.has(r.job_id)) {
      latestRunByJob.set(r.job_id, { id: r.id, status: r.status });
    }
  }
  // Attach to each job for JobTable consumption
  jobList = jobList.map((j) => ({
    ...j,
    latest_run_id:     latestRunByJob.get(j.id)?.id ?? null,
    latest_run_status: latestRunByJob.get(j.id)?.status ?? null,
  }));

  // Counts (always against unfiltered active list)
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  const allRows     = countRows ?? [];
  const totalCount  = allRows.filter((j) => !j.dismissed_at).length;
  const newCount    = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;
  const appliedCount = allRows.filter((j) => j.applied_at).length;
  const dismissedCount = allRows.filter((j) => j.dismissed_at).length;

  const exportParams = new URLSearchParams();
  if (sp.sort) exportParams.set("sort", sp.sort);
  if (sp.min_keywords) exportParams.set("min_keywords", sp.min_keywords);
  if (sp.min_visa) exportParams.set("min_visa", sp.min_visa);

  return (
    <div className="min-h-full">
      <MarkSeenOnLoad profileId={id} />

      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          {/* Breadcrumb + title */}
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Profiles</span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text font-medium truncate max-w-[200px]">{p.name}</span>
            </div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[16px] font-semibold text-text">{p.name}</h1>
              {newCount > 0 && (
                <span className="badge badge-blue font-bold">{newCount} new</span>
              )}
              {appliedCount > 0 && (
                <span className="badge badge-green">{appliedCount} applied</span>
              )}
              <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                {p.is_active ? "● Auto-scheduled" : "○ Manual"}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/api/profiles/${id}/jobs/export?${exportParams.toString()}`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Export CSV
            </Link>
            <Link
              href={`/dashboard/profiles/${id}/runs`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              Run history
            </Link>
            <Link
              href={`/dashboard/profiles/${id}/edit`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              Edit
            </Link>
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteProfileButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Pipeline running status */}
        <LiveRunStatus profileId={id} />

        {/* Row 1: status tabs */}
        <div className="anim-in">
          <Suspense>
            <JobStatusTabs
              totalCount={totalCount}
              newCount={newCount}
              appliedCount={appliedCount}
              dismissedCount={dismissedCount}
            />
          </Suspense>
        </div>

        {/* Row 2: secondary filters (left) + sort bar (right) — unified single row */}
        <div className="anim-in">
          <Suspense>
            <JobFilterBar total={jobList.length} />
          </Suspense>
        </div>

        {/* Job table */}
        <div className="anim-in anim-delay-1">
          <JobTable
            jobs={jobList}
            showVisa={sp.visa_toggle === "1"}
            currentTab={sp.status ?? "all"}
          />
        </div>

        {/* Footer links */}
        <div className="flex items-center gap-3 text-[11px] text-text-3 pt-2 anim-in anim-delay-2">
          <Link href={`/dashboard/profiles/${id}/runs`} className="hover:text-text transition-colors">
            Run history
          </Link>
          <span>·</span>
          <Link href={`/api/profiles/${id}/jobs/export`} className="hover:text-text transition-colors">
            Export all as CSV
          </Link>
          <span>·</span>
          <Link href={`/dashboard/profiles/${id}/edit`} className="hover:text-text transition-colors">
            Edit profile
          </Link>
        </div>
      </div>
    </div>
  );
}
