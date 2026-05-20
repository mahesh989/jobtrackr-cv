/**
 * Main dashboard — two-part layout:
 *
 *   1. Profile management   — KPI strip + profiles table (existing).
 *   2. Unified jobs board   — JobTable across ALL profiles owned by the
 *      user, with the same chips/filters/sort/rail as a single-profile
 *      board. Each row shows a small "via <Profile name>" label.
 *
 * Three queries + JS stitching for the jobs board (matches the
 * per-profile pattern):
 *   - jobs IN (user's profile_ids)
 *   - analysis_runs IN (jobIds) — non-stale, ordered DESC
 *   - cover_letters IN (jobIds) — non-stale, ordered DESC
 *
 * URL params reused 1:1 from the per-profile board:
 *   status, sort, dir, location, posted_within, min_keywords,
 *   visa_toggle, chips
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { CopyProfileButton } from "@/components/CopyProfileButton";
import { JobStatusTabs } from "@/components/JobFilters";
import { JobFilterBar } from "@/components/JobFilterBar";
import { JobTable, type Job } from "@/components/jobs/JobTable";
import { JobProgressChips, type JobProgressChipCounts } from "@/components/jobs/JobProgressChips";
import { ContinueRail, type RailJob } from "@/components/jobs/ContinueRail";
import { JobBoardSettingsPanel } from "@/components/jobs/JobBoardSettings";
import {
  deriveProgress,
  indexLatestByJob,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "@/components/jobs/progressFlags";

interface SearchParams {
  sort?:          string;
  dir?:           string;
  status?:        string;
  min_keywords?:  string;
  min_visa?:      string;
  visa_toggle?:   string;
  source?:        string;
  location?:      string;
  posted_within?: string;
  chips?:         string;
}

type ChipKey = "analysed" | "hasCv" | "hasLetter";
const VALID_CHIPS: ChipKey[] = ["analysed", "hasCv", "hasLetter"];

function parseChips(raw: string | undefined): Set<ChipKey> {
  if (!raw) return new Set();
  const valid = new Set<ChipKey>(VALID_CHIPS);
  return new Set(
    raw.split(",").map((s) => s.trim()).filter((s): s is ChipKey => valid.has(s as ChipKey)),
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, keywords, location, schedule_cron")
    .order("created_at", { ascending: false });

  const profiles = (profileRows ?? []) as Array<{
    id: string; name: string; is_active: boolean;
    keywords: string[]; location: string; schedule_cron: string;
  }>;
  const ids = profiles.map((p) => p.id);

  if (ids.length === 0) {
    return <EmptyState />;
  }

  const profileNameById = new Map(profiles.map((p) => [p.id, p.name]));

  // ── Existing summary queries ─────────────────────────────────────────────
  const [
    { data: jobRows },
    { data: unseenRows },
    { data: appliedRows },
    { data: runRows },
  ] = await Promise.all([
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("seen_at", null).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids).not("applied_at", "is", null),
    supabase.from("run_logs")
      .select("profile_id, status, started_at, finished_at, jobs_saved, error_message")
      .in("profile_id", ids).order("started_at", { ascending: false }).limit(ids.length * 5),
  ]);

  function countBy(rows: { profile_id: string }[] | null) {
    return ((rows ?? []) as { profile_id: string }[]).reduce<Record<string, number>>(
      (acc, r) => { acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1; return acc; }, {}
    );
  }

  const totalCounts   = countBy(jobRows);
  const unseenCounts  = countBy(unseenRows);
  const appliedCounts = countBy(appliedRows);

  type RunRow = { profile_id: string; status: string; started_at: string; finished_at: string | null; jobs_saved: number; error_message: string | null };
  const latestRun = ((runRows ?? []) as RunRow[]).reduce<Record<string, RunRow>>((acc, r) => {
    if (!acc[r.profile_id]) acc[r.profile_id] = r;
    return acc;
  }, {});

  const totalJobs    = Object.values(totalCounts).reduce((a, b) => a + b, 0);
  const totalNew     = Object.values(unseenCounts).reduce((a, b) => a + b, 0);
  const totalApplied = Object.values(appliedCounts).reduce((a, b) => a + b, 0);
  const activeCount  = profiles.filter((p) => p.is_active).length;

  function scheduleLabel(cron: string) {
    if (!cron) return "Manual";
    if (cron.includes("*/1") || cron === "0 21 * * *") return "Daily";
    const m = cron.match(/\*\/(\d+)/);
    if (m && parseInt(m[1]) > 1) return `Every ${m[1]} days`;
    if (cron.includes("* * 1")) return "Weekly Mon";
    if (cron.includes("* * 3")) return "Weekly Wed";
    if (cron.includes("* * 5")) return "Weekly Fri";
    return "Scheduled";
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 2)  return "just now";
    if (hours < 1) return `${mins}m ago`;
    if (days < 1)  return `${hours}h ago`;
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  // ── Unified jobs board: data fetch ───────────────────────────────────────
  let q = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address")
    .in("profile_id", ids)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  if (sp.status === "new")            q = q.is("seen_at", null).is("dismissed_at", null);
  else if (sp.status === "applied")   q = q.not("applied_at", "is", null).is("dismissed_at", null);
  else if (sp.status === "dismissed") q = q.not("dismissed_at", "is", null);
  else                                q = q.is("dismissed_at", null);

  if (sp.location) q = q.ilike("location", `%${sp.location}%`);

  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      q = q.gte("posted_at", d.toISOString());
    }
  }

  const sortCol = sp.sort ?? "posted_at";
  const sortDir = sp.dir === "asc";
  const allowed = ["title", "company", "location", "posted_at", "created_at", "visa_likelihood"];
  q = allowed.includes(sortCol)
    ? q.order(sortCol, { ascending: sortDir, nullsFirst: false })
    : q.order("posted_at", { ascending: false, nullsFirst: false });

  q = q.limit(200);
  const { data: jobs } = await q;
  let jobList = (jobs ?? []) as Array<{
    id: string; profile_id: string; applied_at: string | null; [k: string]: unknown;
  }>;

  if (sp.min_keywords) {
    const minK = parseInt(sp.min_keywords, 10);
    if (!isNaN(minK)) {
      jobList = jobList.filter((j) => ((j.keywords_matched as string[] | null)?.length ?? 0) >= minK);
    }
  }

  const jobIds = jobList.map((j) => j.id);

  const { data: recentRuns } = jobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as AnalysisRunRef[] };

  const { data: recentLetters } = jobIds.length > 0
    ? await supabase
        .from("cover_letters")
        .select("id, job_id, status, completed_at, created_at")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as CoverLetterRef[] };

  const runByJob    = indexLatestByJob((recentRuns    ?? []) as AnalysisRunRef[]);
  const letterByJob = indexLatestByJob((recentLetters ?? []) as CoverLetterRef[]);

  let typedJobs: Job[] = jobList.map((j) => {
    const progress = deriveProgress(
      { applied_at: j.applied_at },
      runByJob.get(j.id),
      letterByJob.get(j.id),
    );
    return {
      ...(j as unknown as Job),
      profile_name: profileNameById.get(j.profile_id) ?? null,
      progress,
    };
  });

  const chipCounts: JobProgressChipCounts = {
    analysed:  typedJobs.filter((x) => x.progress.has_analysis).length,
    hasCv:     typedJobs.filter((x) => x.progress.has_tailored_cv).length,
    hasLetter: typedJobs.filter((x) => x.progress.has_cover_letter).length,
  };

  const railJobs: RailJob[] = [...typedJobs]
    .filter((x) => x.progress.last_progress_at !== null && !x.dismissed_at)
    .sort((a, b) =>
      (b.progress.last_progress_at ?? "").localeCompare(a.progress.last_progress_at ?? ""),
    )
    .slice(0, 3)
    .map((x) => ({
      id:         x.id,
      profile_id: x.profile_id,
      title:      x.title,
      company:    x.company,
      progress:   x.progress,
    }));

  const selectedChips = parseChips(sp.chips);
  if (selectedChips.size > 0) {
    typedJobs = typedJobs.filter((x) => {
      if (selectedChips.has("analysed")  && !x.progress.has_analysis)     return false;
      if (selectedChips.has("hasCv")     && !x.progress.has_tailored_cv)  return false;
      if (selectedChips.has("hasLetter") && !x.progress.has_cover_letter) return false;
      return true;
    });
  }

  if (sortCol === "recently_progressed") {
    typedJobs = [...typedJobs].sort((a, b) => {
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  } else if (sortCol === "most_progressed") {
    typedJobs = [...typedJobs].sort((a, b) => {
      const ds = b.progress.progress_score - a.progress.progress_score;
      if (ds !== 0) return sortDir ? -ds : ds;
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }

  // Status-tab counts — aggregated across profiles
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at")
    .in("profile_id", ids)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  const allRows         = countRows ?? [];
  const tabTotalCount   = allRows.filter((j) => !j.dismissed_at).length;
  const tabNewCount     = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;
  const tabAppliedCount = allRows.filter((j) => j.applied_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;

  const currentTab = sp.status ?? "all";

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Dashboard</h1>
            <p className="text-[12px] text-text-2 mt-0.5">
              {profiles.length} profile{profiles.length !== 1 ? "s" : ""} · {activeCount} auto-scheduled
            </p>
          </div>
          <div className="flex items-center gap-2">
            <JobBoardSettingsPanel />
            <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue text-[13px]">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              New profile
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* ── KPI bar ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 anim-in">
          <div className="kpi-card">
            <div className="kpi-value">{totalJobs.toLocaleString()}</div>
            <div className="kpi-label">Total jobs</div>
          </div>
          <div className={`kpi-card ${totalNew > 0 ? "border-[var(--brand)] ring-1 ring-[var(--brand)]/20" : ""}`}>
            <div className={`kpi-value ${totalNew > 0 ? "text-[var(--brand)]" : ""}`}>{totalNew}</div>
            <div className="kpi-label">New · unseen</div>
          </div>
          <div className={`kpi-card ${totalApplied > 0 ? "border-[#1A7F37]/40" : ""}`}>
            <div className={`kpi-value ${totalApplied > 0 ? "text-[#1A7F37]" : ""}`}>{totalApplied}</div>
            <div className="kpi-label">Applied</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{activeCount}</div>
            <div className="kpi-label">Auto-scheduled</div>
          </div>
        </div>

        {/* ── Profile table ── */}
        <details className="anim-in anim-delay-1 group" open>
          <summary className="flex items-center gap-2 cursor-pointer text-[12px] font-semibold text-text-2 uppercase tracking-wider mb-2 select-none">
            <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
            My profiles ({profiles.length})
          </summary>
          <div className="bg-surface border border-border rounded-md overflow-hidden mt-2">
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-surface-2 border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
              <div className="col-span-3">Profile</div>
              <div className="col-span-2">Keywords</div>
              <div className="col-span-1 text-center">New</div>
              <div className="col-span-1 text-center">Total</div>
              <div className="col-span-1 text-center">Applied</div>
              <div className="col-span-2">Last run</div>
              <div className="col-span-2"></div>
            </div>

            {profiles.map((p, i) => {
              const run      = latestRun[p.id];
              const newJobs  = unseenCounts[p.id] ?? 0;
              const total    = totalCounts[p.id] ?? 0;
              const applied  = appliedCounts[p.id] ?? 0;
              const isRunning = run?.status === "running";
              const failed    = run?.status === "failed";

              return (
                <div
                  key={p.id}
                  className={`grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors anim-in anim-delay-${Math.min(i + 2, 6)} ${
                    isRunning ? "border-l-2 border-l-[var(--brand)]" : ""
                  }`}
                >
                  <div className="col-span-3 flex items-center gap-2 min-w-0">
                    {isRunning && (
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75"/>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--brand)]"/>
                      </span>
                    )}
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/profiles/${p.id}/jobs`}
                        className="text-[13px] font-semibold text-text hover:text-[var(--brand)] truncate block transition-colors"
                      >
                        {p.name}
                      </Link>
                      <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                        {p.is_active ? `● ${scheduleLabel(p.schedule_cron)}` : "○ Manual"}
                      </span>
                    </div>
                  </div>

                  <div className="col-span-2 flex items-center">
                    <span className="text-[12px] text-text-2 truncate">
                      {p.keywords.slice(0, 3).join(", ")}
                      {p.keywords.length > 3 && <span className="text-text-3"> +{p.keywords.length - 3}</span>}
                    </span>
                  </div>

                  <div className="col-span-1 flex items-center justify-center">
                    {newJobs > 0 ? (
                      <span className="badge badge-blue font-bold">{newJobs}</span>
                    ) : (
                      <span className="text-[12px] text-text-3">—</span>
                    )}
                  </div>

                  <div className="col-span-1 flex items-center justify-center">
                    <span className="text-[13px] font-medium text-text">{total}</span>
                  </div>

                  <div className="col-span-1 flex items-center justify-center">
                    {applied > 0 ? (
                      <span className="badge badge-green">{applied}</span>
                    ) : (
                      <span className="text-[12px] text-text-3">—</span>
                    )}
                  </div>

                  <div className="col-span-2 flex items-center">
                    {!run ? (
                      <span className="text-[12px] text-text-3">Never</span>
                    ) : isRunning ? (
                      <span className="text-[12px] text-[var(--brand)] font-medium flex items-center gap-1.5">
                        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        Running…
                      </span>
                    ) : failed ? (
                      <span className="text-[12px] text-[#CF222E]">✗ Failed</span>
                    ) : (
                      <div>
                        <span className="text-[12px] text-text-2">{timeAgo(run.started_at)}</span>
                        {run.jobs_saved > 0 && (
                          <span className="text-[11px] text-[#1A7F37] ml-1.5">+{run.jobs_saved}</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="col-span-2 flex items-center justify-end gap-1.5">
                    <RunNowButton profileId={p.id} compact initialIsRunning={isRunning} />
                    <Link
                      href={`/dashboard/profiles/${p.id}/jobs`}
                      className={`gh-btn text-[12px] px-2.5 py-1 ${newJobs > 0 ? "border-[var(--brand)]/40 text-[var(--brand)]" : ""}`}
                    >
                      {newJobs > 0 ? `${newJobs} new →` : "Jobs →"}
                    </Link>
                    <CopyProfileButton profileId={p.id} compact />
                    <DeleteProfileButton profileId={p.id} profileName={p.name} compact />
                  </div>
                </div>
              );
            })}
          </div>
        </details>

        {/* ── Unified jobs board ── */}
        <div className="anim-in anim-delay-2 space-y-4 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-text">All jobs across profiles</h2>
              <span className="text-[11px] text-text-3">{typedJobs.length} of {tabTotalCount}</span>
            </div>
          </div>

          {/* Status tabs (aggregated counts) */}
          <Suspense>
            <JobStatusTabs
              totalCount={tabTotalCount}
              newCount={tabNewCount}
              appliedCount={tabAppliedCount}
              dismissedCount={tabDismissedCount}
            />
          </Suspense>

          {/* Filter bar (posted-within, location, visa, sort) */}
          <Suspense>
            <JobFilterBar total={typedJobs.length} />
          </Suspense>

          {/* Progress chips */}
          <Suspense>
            <JobProgressChips counts={chipCounts} />
          </Suspense>

          {/* Continue rail */}
          <ContinueRail jobs={railJobs} currentTab={currentTab} />

          {/* Job table */}
          <JobTable
            jobs={typedJobs}
            showVisa={sp.visa_toggle === "1"}
            currentTab={currentTab}
          />
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3 text-[12px] text-text-3 anim-in anim-delay-3">
          <Link href="/dashboard/profiles/new" className="hover:text-text transition-colors">+ New profile</Link>
          <span>·</span>
          <a href="/api/user/export" className="hover:text-text transition-colors">Export all data</a>
          <span>·</span>
          <Link href="/privacy" className="hover:text-text transition-colors">Privacy policy</Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="text-center max-w-sm anim-in">
        <div className="w-16 h-16 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center mx-auto mb-5">
          <svg className="w-8 h-8 text-[var(--brand)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497z"/>
          </svg>
        </div>

        <h2 className="text-[18px] font-semibold text-text mb-2">Set up your first search profile</h2>
        <p className="text-[13px] text-text-2 leading-relaxed mb-6">
          A search profile tells JobTrackr what jobs to look for. Once created, it automatically scans 21+ Australian sources — government portals, ATS systems, healthcare boards — and AI-scores every result.
        </p>

        <div className="bg-surface border border-border rounded-md p-4 text-left mb-6 space-y-3">
          {[
            { n: "1", title: "Define keywords", desc: "e.g. \"Data Analyst, SQL, Power BI\"" },
            { n: "2", title: "Set a schedule",   desc: "Daily, every 2 days, or weekly" },
            { n: "3", title: "Review & track",   desc: "AI-scored feed, mark applied, export CSV" },
          ].map((s) => (
            <div key={s.n} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-[var(--brand)] text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                {s.n}
              </span>
              <div>
                <p className="text-[13px] font-medium text-text">{s.title}</p>
                <p className="text-[12px] text-text-2">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue w-full justify-center py-2 text-[13px]">
          Create your first profile
        </Link>
      </div>
    </div>
  );
}
