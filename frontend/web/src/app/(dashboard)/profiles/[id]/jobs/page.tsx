/**
 * Per-profile job board — /profiles/[id]/jobs.
 *
 * Server responsibilities (unchanged after refactor):
 *   1. Auth + profile ownership check.
 *   2. Fetch the capped (≤200) non-dismissed job set, filtered by:
 *        location, posted_within   ← dataset filters (change which rows arrive)
 *      Applied / dismissed switch still goes through the server too.
 *   3. Fetch analysis_runs + cover_letters to derive progress/pipeline state.
 *   4. Compute funnelCounts from a separate lightweight query.
 *   5. Attach atsBand to each job (needed for the shared filterJobs helper).
 *
 * Everything else (stage / triage / sort / keywords) is now handled
 * client-side in ProfileJobBoard — clicking a funnel tab is instant.
 */

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/features/auth/server";
import { redirect } from "next/navigation";
import { resolveThresholds } from "@/lib/atsThresholds";
import { Badge } from "@/components/ui";
import { Suspense } from "react";
import Link from "next/link";
import { RunNowButton } from "@/features/profiles/components/RunNowButton";
import { DeleteButton } from "@/features/profiles/components/DeleteButton";
import { MarkSeenOnLoad } from "@/features/profiles/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/features/profiles/components/LiveRunStatus";
import { LiveLogConsole } from "@/features/profiles/components/LiveLogConsole";
import { type FunnelCounts } from "@/features/jobs/components/PipelineFunnel";
import { ProfileJobBoard } from "@/features/jobs/components/ProfileJobBoard";
import { Button } from "@/components/ui";
import { jobNeedsJd, normalizeWorkTypes, passesWorkTypes, type BoardJob } from "@/features/jobs/lib/jobFilters";
import {
  indexLatestByJob,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "@/features/jobs/lib/progressFlags";
import { recomputeGates } from "@/features/jobs/lib/pipelineState";
import { deriveBoardJob } from "@/features/jobs/lib/boardDerivation";
import { computeEligibility, hoursCapConflict, isUserVisaStatus } from "@/lib/eligibility";
import { ADMIN_ROLES } from "@/lib/constants";

interface SearchParams {
  sort?:          string;
  dir?:           string;
  stage?:         string;
  triage?:        string;
  /** "new" — show only the latest fetched batch (jobs discovered by the most
   *  recent completed run that found anything). Stable until the next run. */
  view?:          string;
  /** @deprecated — kept for backward compat with old bookmarks */
  status?:        string;
  /** @deprecated — kept for backward compat with old bookmarks */
  chips?:         string;
  min_keywords?:  string;
  min_visa?:      string;
  visa_toggle?:   string;
  source?:        string;
  location?:      string;
  posted_within?: string;
}

export default async function JobsPage({
  params,
  searchParams,
}: {
  params:       Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp     = await searchParams;

  const supabase = await createClient();
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, is_manual, keywords, schedule_cron, home_address, target_verticals, adzuna_exclude_keywords")
    .eq("id", id).eq("user_id", user.id).single();
  if (!profile) redirect("/dashboard");

  // Pipeline console + run history are internal/diagnostic surfaces — admin
  // only. Gated on ROLE, deliberately NOT on the jt_user_view cookie, so an
  // admin browsing in "view as user" mode keeps them.
  const { data: meRow } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes((meRow?.role as string) ?? "");

  // Per-vertical cutoffs (healthcare/nursing = 55/65). Drives live re-bucketing
  // so the ATS tabs/counts match the gate the analysis actually used. The
  // vertical is the user's ONE global My CV choice (contact_details.role_families)
  // — same source the pipeline uses — with the per-profile field as legacy fallback.
  const { data: prefRow } = await supabase
    .from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle();
  const myCvVerticals = (
    (prefRow?.contact_details as { role_families?: string[] | null } | null)?.role_families ?? []
  ).filter(Boolean);
  // User-level visa status (080) — same contact_details home as role_families.
  const rawVisaStatus = (prefRow?.contact_details as { visa_status?: string } | null)?.visa_status;
  const userVisaStatus = isUserVisaStatus(rawVisaStatus) ? rawVisaStatus : null;
  // User-level work-type preference (Profile → Details "Work types") — hides
  // jobs whose EXTRACTED types don't intersect the selection; unclassified
  // jobs always show. Mirrors the worker's fetch-time filter, applied here so
  // pre-existing / bucket-served rows obey it too.
  const userWorkTypes = normalizeWorkTypes(
    (prefRow?.contact_details as { credentials?: { availability?: string[] } } | null)
      ?.credentials?.availability,
  );
  const th = resolveThresholds(
    myCvVerticals.length > 0
      ? myCvVerticals
      : (profile as { target_verticals?: string[] | null }).target_verticals,
  );

  const p = profile as {
    id: string; name: string; is_active: boolean; is_manual: boolean;
    keywords: string[]; schedule_cron: string;
    home_address: string | null;
  };

  interface AllCountRow {
    id: string; seen_at: string | null; applied_at: string | null;
    dismissed_at: string | null; profile_id: string; starred_at: string | null;
    jd_quality: string | null; manual_jd_text: string | null;
    role_match: string | null; has_email: boolean | null;
    employment_types?: string[] | null;
  }

  const isDismissedView = sp.stage === "dismissed" || sp.status === "dismissed";

  const JOBS_BASE_COLS = "id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, starred_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email, distance_km, distance_method, setting_category, setting_confidence, setting_evidence";
  const JOBS_M080_COLS = ", salary_min, salary_max, employment_types, work_rights_requirement, extracted_emails, salary_period, closing_date, shift_patterns, is_agency";

  const buildJobsQuery = (cols: string) => {
    let query = supabase
      .from("jobs")
      .select(cols)
      .eq("profile_id", id)
      .eq("is_expired", false)
      .eq("is_dead_link", false);
    if (isDismissedView) query = query.not("dismissed_at", "is", null);
    else                 query = query.is("dismissed_at", null);
    if (sp.location) query = query.ilike("location", `%${sp.location}%`);
    if (sp.posted_within && sp.posted_within !== "any") {
      const days = parseInt(sp.posted_within, 10);
      if (!isNaN(days)) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        query = query.gte("posted_at", d.toISOString());
      }
    }
    return query.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);
  };

  // Migration-080 columns with pre-migration fallback: retry on the base
  // column set if the DB doesn't have them yet (board keeps working either way).
  const fetchJobsWithFallback = async () => {
    let res = await buildJobsQuery(JOBS_BASE_COLS + JOBS_M080_COLS);
    if (res.error && /column|42703|PGRST/i.test(res.error.message)) {
      res = await buildJobsQuery(JOBS_BASE_COLS);
    }
    return res;
  };
  const query = fetchJobsWithFallback();

  // ── BATCH 1 — four parallel queries (all need only profile `id`) ─────────
  const [
    { data: jobs },
    { data: countRows },
    { data: activeRunData },
    { data: completedRuns },
  ] = await Promise.all([
    query,
    supabase
      .from("jobs")
      .select("id, seen_at, applied_at, dismissed_at, starred_at, profile_id, jd_quality, manual_jd_text, role_match, has_email, employment_types")
      .eq("profile_id", id)
      .eq("is_expired", false)
      .eq("is_dead_link", false),
    supabase.from("run_logs").select("id").eq("profile_id", id).eq("status", "running").maybeSingle(),
    // Recent completed runs — the ?view=new "latest fetch" floor is derived
    // from these (jobs discovered since the newest run that found anything).
    supabase.from("run_logs")
      .select("started_at")
      .eq("profile_id", id)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(25),
  ]);

  const isRunning     = !!activeRunData;
  const jobListRaw    = (jobs ?? []) as unknown as Array<{ id: string; profile_id: string; applied_at: string | null; [k: string]: unknown }>;
  // Work-type preference filter (board-read mirror of the worker's fetch
  // filter). Applied/starred jobs stay visible regardless — the user acted
  // on them; hiding them would orphan tracked applications.
  const jobList       = jobListRaw.filter((j) =>
    j.applied_at || j.starred_at ||
    passesWorkTypes(j as { employment_types?: string[] | null }, userWorkTypes),
  );
  const jobIds        = jobList.map((j) => j.id);
  // Same work-type predicate as the board list so funnel counts agree.
  const allRows       = ((countRows ?? []) as AllCountRow[]).filter((r) =>
    r.applied_at || r.starred_at || passesWorkTypes(r, userWorkTypes),
  );
  const jobIdsForCounts = allRows.map((r) => r.id);

  // ── BATCH 2 — four parallel queries (need job IDs from BATCH 1) ───────────
  const [
    { data: recentRuns },
    { data: recentLetters },
    runsRes,
    lettersRes,
  ] = await Promise.all([
    jobIds.length > 0
      ? supabase.from("analysis_runs")
          .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate, automation")
          .in("job_id", jobIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as AnalysisRunRef[] }),
    jobIds.length > 0
      ? supabase.from("cover_letters")
          .select("id, job_id, status, completed_at, created_at")
          .in("job_id", jobIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as CoverLetterRef[] }),
    jobIdsForCounts.length > 0
      ? supabase.from("analysis_runs")
          .select("job_id, tailored_cv_storage_path, tailored_pdf_storage_path, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate")
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts)
      : Promise.resolve({ data: [] }),
    jobIdsForCounts.length > 0
      ? supabase.from("cover_letters")
          .select("job_id")
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts)
      : Promise.resolve({ data: [] }),
  ]);

  const runByJob    = indexLatestByJob((recentRuns    ?? []) as AnalysisRunRef[]);
  const letterByJob = indexLatestByJob((recentLetters ?? []) as CoverLetterRef[]);

  // ── Derive progress + pipeline state + ATS band ──────────────────────────
  const boardJobs: BoardJob[] = jobList.map((j) => {
    const jobShape = j as unknown as BoardJob;
    return {
      ...deriveBoardJob(j, runByJob.get(j.id), letterByJob.get(j.id), th),
      // Eligibility badge (080): user's My CV visa status × the JD's stated
      // work-rights requirement. Null status → no badge (legacy behaviour).
      eligibility:        userVisaStatus ? computeEligibility(jobShape, userVisaStatus) : null,
      hours_cap_conflict: userVisaStatus ? hoursCapConflict(jobShape, userVisaStatus) : false,
    };
  });

  // ── ?view=new — latest fetched batch ──────────────────────────────────────
  // "New jobs" = jobs first discovered (created_at) since the start of the most
  // recent completed run that actually found something. Stable until the next
  // batch lands — unlike seen_at, which MarkSeenOnLoad consumes on first view.
  // Runs that discovered nothing are skipped (they'd blank the view), and with
  // no completed runs yet (first fetch) the whole board is the first batch.
  const isNewView = sp.view === "new";
  let visibleBoardJobs = boardJobs;
  if (isNewView) {
    const runStarts = ((completedRuns ?? []) as Array<{ started_at: string }>)
      .map((r) => new Date(r.started_at).getTime())
      .filter((t) => !isNaN(t)); // newest-first (query is ordered desc)
    const createdMs = (j: BoardJob) => {
      const t = new Date((j as { created_at?: string | null }).created_at ?? "").getTime();
      return isNaN(t) ? 0 : t;
    };
    const floor = runStarts.find((t) => boardJobs.some((j) => createdMs(j) >= t));
    if (floor !== undefined) {
      visibleBoardJobs = boardJobs.filter((j) => createdMs(j) >= floor);
    }
  }

  // (allRows, runsRes, lettersRes fetched in BATCH 1 and BATCH 2 above)

  const analysedSet    = new Set((runsRes.data ?? []).map((r) => r.job_id));
  const cvReadySet     = new Set((runsRes.data ?? []).filter((r) => r.tailored_cv_storage_path || r.tailored_pdf_storage_path).map((r) => r.job_id));
  const letterReadySet = new Set((lettersRes.data ?? []).map((l) => l.job_id));
  const belowThresholdSet = new Set(
    (runsRes.data ?? [])
      .filter((r) => {
        const g = recomputeGates(
          (r as { initial_ats_score?: number | null }).initial_ats_score,
          (r as { tailored_match_score?: number | null }).tailored_match_score,
          th.initial, th.final,
        );
        return g.passedInitial === false || g.passedFinal === false;
      })
      .map((r) => r.job_id),
  );

  const tabTotalCount   = allRows.filter((j) => !j.dismissed_at).length;
  const tabAppliedCount = allRows.filter((j) => j.applied_at && !j.dismissed_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;
  const newCount        = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;

  const funnelCounts: FunnelCounts = {
    discovered:     tabTotalCount,
    analysed:       allRows.filter((j) => !j.dismissed_at && analysedSet.has(j.id)).length,
    cvReady:        allRows.filter((j) => !j.dismissed_at && cvReadySet.has(j.id)).length,
    letterReady:    allRows.filter((j) => !j.dismissed_at && letterReadySet.has(j.id)).length,
    applied:        tabAppliedCount,
    dismissed:      tabDismissedCount,
    favourite:      allRows.filter((j) => j.starred_at && !j.dismissed_at).length,
    newCount,
    needsJd:        allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    roleMismatch:   allRows.filter((j) => !j.dismissed_at && j.role_match === "mismatch").length,
    belowThreshold: allRows.filter((j) => !j.dismissed_at && belowThresholdSet.has(j.id)).length,
    hasEmail:       allRows.filter((j) => !j.dismissed_at && j.has_email === true).length,
    thinJd:         allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    richJd:         allRows.filter((j) => !j.dismissed_at && (j.jd_quality === "rich" || (j.jd_quality === "thin" && !jobNeedsJd(j)))).length,
  };

  const exportParams = new URLSearchParams();
  if (sp.sort) exportParams.set("sort", sp.sort);
  if (sp.min_keywords) exportParams.set("min_keywords", sp.min_keywords);
  if (sp.min_visa) exportParams.set("min_visa", sp.min_visa);

  return (
    <div className="min-h-full">
      <MarkSeenOnLoad profileId={id} />

      {/* Header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-caption text-text-3 mb-2">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <Link href="/profiles" className="hover:text-text transition-colors">Job Searches</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text font-medium truncate max-w-[160px]">{p.name}</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-lead font-semibold text-text">{p.name}</h1>
              {newCount > 0 && (
                <Badge variant="blue" className="font-bold">{newCount} new</Badge>
              )}
              {tabAppliedCount > 0 && (
                <Badge variant="green">{tabAppliedCount} applied</Badge>
              )}
              <span className={`text-caption ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                {p.is_active ? "● Auto-scheduled" : "○ Manual"}
              </span>
            </div>
            {p.home_address && (
              <p className="text-label text-text-2 flex items-center gap-1.5 mt-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                {p.home_address}
              </p>
            )}
          </div>

          {/* Actions — wrap on mobile */}
          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0">
            <Link
              href={`/api/profiles/${id}/jobs/export?${exportParams.toString()}`}
              className="shrink-0 whitespace-nowrap"
            >
              <Button size="sm" className="px-2.5 py-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                Export CSV
              </Button>
            </Link>
            {isAdmin && (
              <Link href={`/profiles/${id}/runs`} className="shrink-0 whitespace-nowrap">
                <Button size="sm" className="px-2.5 py-1">Run history</Button>
              </Link>
            )}
            <Link href={`/profiles/${id}/edit`} className="shrink-0 whitespace-nowrap">
              <Button size="sm" className="px-2.5 py-1">Edit</Button>
            </Link>
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <LiveRunStatus profileId={id} initialIsRunning={isRunning} />
        {isAdmin && <LiveLogConsole profileId={id} />}

        {/* ?view=new banner — latest fetched batch, with an exit back to all */}
        {isNewView && (
          <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-md bg-[var(--brand)]/8 border border-[var(--brand)]/30 text-label anim-in">
            <span className="text-text">
              <span className="font-semibold text-[var(--brand)]">Latest fetch</span>
              {" — "}{visibleBoardJobs.length} job{visibleBoardJobs.length !== 1 ? "s" : ""} from the most recent run. Your usual sort and filters apply.
            </span>
            <Link href={`/profiles/${id}/jobs`} className="text-[var(--brand)] font-medium hover:underline shrink-0">
              Show all jobs →
            </Link>
          </div>
        )}

        {/* Client-side board — instant stage/triage/sort/keyword filtering */}
        <Suspense>
          <ProfileJobBoard
            jobs={visibleBoardJobs}
            counts={funnelCounts}
            homeAddress={p.home_address}
            thresholds={th}
            isManual={p.is_manual ?? false}
            excludeKeywords={(profile as { adzuna_exclude_keywords?: string | null }).adzuna_exclude_keywords ?? undefined}
          />
        </Suspense>

        {/* Footer */}
        <div className="flex items-center gap-3 text-caption text-text-3 pt-2 anim-in anim-delay-2">
          {isAdmin && (
            <>
              <Link href={`/profiles/${id}/runs`} className="hover:text-text transition-colors">
                Run history
              </Link>
              <span>·</span>
            </>
          )}
          <Link href={`/api/profiles/${id}/jobs/export`} className="hover:text-text transition-colors">
            Export all as CSV
          </Link>
          <span>·</span>
          <Link href={`/profiles/${id}/edit`} className="hover:text-text transition-colors">
            Edit profile
          </Link>
        </div>
      </div>
    </div>
  );
}
