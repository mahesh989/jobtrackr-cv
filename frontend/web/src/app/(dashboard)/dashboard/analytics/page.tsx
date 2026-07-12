/**
 * /dashboard/analytics — pipeline funnel, broken down two ways.
 *
 * Each table is one row per source / profile through the pipeline:
 *   Scraped → Analysed → Tailored CV → Cover Letter → Applied
 * with the conversion % from the previous step shown in each cell.
 *
 * Data:
 *   - Scraped      — by source: sum of run_logs.sources_saved jsonb.
 *                    by profile: sum of run_logs.jobs_saved.
 *   - Analysed     — jobs with a completed, non-stale analysis_run.
 *   - Tailored CV  — those whose latest completed run produced a tailored CV
 *                    (tailored_cv_storage_path or tailored_pdf_storage_path).
 *   - Cover Letter — jobs with a completed cover_letter.
 *   - Applied      — jobs with applied_at set.
 *
 * Note: Cover Letter and Applied are user-triggered and ungated, so a stage
 * can exceed the one before it (conversion > 100%, or "—" when the prior
 * step is zero). That's real — these are stage counts, not a strict subset
 * chain. Server-rendered only — counts + div bars, no canvas.
 */

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/modules/auth/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BarChart3 } from "lucide-react";

interface Funnel {
  scraped:  number;
  analysed: number;
  tailored: number;
  letter:   number;
  applied:  number;
}

interface FunnelRowData extends Funnel {
  id:          string;
  label:       string;
  href:        string | null;
  capitalize?: boolean;
}

type StageKey = keyof Funnel;

const STAGES: Array<{ key: StageKey; label: string; prev: StageKey | null }> = [
  { key: "scraped",  label: "Scraped",      prev: null },
  { key: "analysed", label: "Analysed",     prev: "scraped" },
  { key: "tailored", label: "Tailored CV",  prev: "analysed" },
  { key: "letter",   label: "Cover Letter", prev: "tailored" },
  { key: "applied",  label: "Applied",      prev: "letter" },
];

const emptyFunnel = (): Funnel => ({ scraped: 0, analysed: 0, tailored: 0, letter: 0, applied: 0 });

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 100);
}

function sumStage(rows: Funnel[], key: StageKey): number {
  return rows.reduce((a, r) => a + r[key], 0);
}

export default async function AnalyticsPage() {
  const supabase = await createClient();
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  // Founder/admin lens only — pipeline funnels across sources and profiles
  // are an operator concern, not a paying-customer concern. Paying users
  // would land here only by URL-hopping; bounce them to their dashboard.
  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name")
    .order("created_at", { ascending: false });
  const profiles = (profileRows ?? []) as Array<{ id: string; name: string }>;
  const ids = profiles.map((p) => p.id);
  const profileNameById = new Map(profiles.map((p) => [p.id, p.name]));

  if (ids.length === 0) return <EmptyState />;

  // ── BATCH 1 — run_logs + jobs in parallel (both need only `ids`) ─────────
  const [
    { data: runLogData },
    { data: jobRows },
  ] = await Promise.all([
    supabase.from("run_logs").select("profile_id, jobs_saved, sources_saved").in("profile_id", ids),
    supabase.from("jobs").select("id, profile_id, source, applied_at").in("profile_id", ids),
  ]);

  const scrapedBySource: Record<string, number> = {};
  const scrapedByProfile: Record<string, number> = {};
  for (const r of (runLogData ?? []) as Array<{
    profile_id: string; jobs_saved: number | null; sources_saved: Record<string, number> | null;
  }>) {
    scrapedByProfile[r.profile_id] = (scrapedByProfile[r.profile_id] ?? 0) + (r.jobs_saved ?? 0);
    if (r.sources_saved) {
      for (const [src, n] of Object.entries(r.sources_saved)) {
        scrapedBySource[src] = (scrapedBySource[src] ?? 0) + (n ?? 0);
      }
    }
  }

  const jobs   = (jobRows ?? []) as Array<{ id: string; profile_id: string; source: string; applied_at: string | null }>;
  const jobIds = jobs.map((j) => j.id);

  // ── BATCH 2 — analysis runs + cover letters in parallel (need `jobIds`) ──
  const [
    { data: runData },
    { data: letterRows },
  ] = await Promise.all([
    jobIds.length > 0
      ? supabase.from("analysis_runs")
          .select("job_id, tailored_cv_storage_path, tailored_pdf_storage_path, created_at")
          .in("job_id", jobIds)
          .eq("status", "completed")
          .eq("is_stale", false)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as Array<{ job_id: string; tailored_cv_storage_path: string | null; tailored_pdf_storage_path: string | null }> }),
    jobIds.length > 0
      ? supabase.from("cover_letters")
          .select("job_id")
          .in("job_id", jobIds)
          .eq("status", "completed")
          .eq("is_stale", false)
      : Promise.resolve({ data: [] as Array<{ job_id: string }> }),
  ]);

  const latestRunByJob = new Map<string, { tailored_cv_storage_path: string | null; tailored_pdf_storage_path: string | null }>();
  for (const r of (runData ?? []) as Array<{ job_id: string; tailored_cv_storage_path: string | null; tailored_pdf_storage_path: string | null }>) {
    if (!latestRunByJob.has(r.job_id)) latestRunByJob.set(r.job_id, r);
  }
  const letterSet = new Set(((letterRows ?? []) as Array<{ job_id: string }>).map((l) => l.job_id));

  // ── Aggregate per job into source + profile buckets ─────────────────────────
  const bySource: Record<string, Funnel> = {};
  const byProfile: Record<string, Funnel> = {};
  const jobsCountBySource: Record<string, number> = {};
  const jobsCountByProfile: Record<string, number> = {};

  for (const src of Object.keys(scrapedBySource)) (bySource[src] ??= emptyFunnel()).scraped = scrapedBySource[src];
  for (const pid of Object.keys(scrapedByProfile)) (byProfile[pid] ??= emptyFunnel()).scraped = scrapedByProfile[pid];

  for (const j of jobs) {
    const run      = latestRunByJob.get(j.id);
    const analysed = !!run;
    const tailored = !!(run?.tailored_cv_storage_path || run?.tailored_pdf_storage_path);
    const letter   = letterSet.has(j.id);
    const applied  = !!j.applied_at;

    jobsCountBySource[j.source]   = (jobsCountBySource[j.source]   ?? 0) + 1;
    jobsCountByProfile[j.profile_id] = (jobsCountByProfile[j.profile_id] ?? 0) + 1;

    for (const bucket of [bySource[j.source] ??= emptyFunnel(), byProfile[j.profile_id] ??= emptyFunnel()]) {
      if (analysed) bucket.analysed++;
      if (tailored) bucket.tailored++;
      if (letter)   bucket.letter++;
      if (applied)  bucket.applied++;
    }
  }

  // run_logs is the source of truth for Scraped, but pre-feature runs lack the
  // sources_saved column — fall back to the live job count so the funnel never
  // grows from one step to the next.
  for (const [src, f] of Object.entries(bySource))  f.scraped = Math.max(f.scraped, jobsCountBySource[src] ?? 0);
  for (const [pid, f] of Object.entries(byProfile)) f.scraped = Math.max(f.scraped, jobsCountByProfile[pid] ?? 0);

  const sourceRows: FunnelRowData[] = Object.entries(bySource)
    .filter(([, f]) => f.scraped > 0 || f.analysed > 0)
    .sort(([, a], [, b]) => b.scraped - a.scraped)
    .map(([src, f]) => ({
      id: src,
      label: src,
      href: `/dashboard?source=${encodeURIComponent(src)}`,
      capitalize: true,
      ...f,
    }));

  const profileFunnelRows: FunnelRowData[] = ids
    .filter((pid) => byProfile[pid] && (byProfile[pid].scraped > 0 || byProfile[pid].analysed > 0))
    .map((pid) => ({
      id: pid,
      label: profileNameById.get(pid) ?? pid,
      href: `/dashboard/profiles/${pid}/jobs`,
      ...byProfile[pid],
    }))
    .sort((a, b) => b.scraped - a.scraped);

  if (sourceRows.length === 0 && profileFunnelRows.length === 0) return <EmptyState />;

  const totalScraped = sumStage(profileFunnelRows, "scraped");
  const totalApplied = sumStage(profileFunnelRows, "applied");
  const overallConv = pct(totalApplied, totalScraped);

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Analytics</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Pipeline analytics</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          Funnel by source and by profile
          {overallConv !== null && <> · {overallConv}% scraped → applied overall</>}
        </p>
      </div>

      <div className="px-6 py-5 space-y-7">
        <p className="text-[12px] text-text-2 anim-in max-w-3xl">
          Each row tracks jobs through the pipeline. The small percentage under a count is
          its conversion from the previous step. Cover Letter and Applied are manual,
          ungated steps, so a column can exceed the one before it.
        </p>

        <FunnelTable
          title="By source"
          rows={sourceRows}
          totalLabel="All sources"
        />

        <FunnelTable
          title="By profile"
          rows={profileFunnelRows}
          totalLabel="All profiles"
        />
      </div>
    </div>
  );
}

function FunnelTable({
  title,
  rows,
  totalLabel,
}: {
  title: string;
  rows: FunnelRowData[];
  totalLabel: string;
}) {
  if (rows.length === 0) return null;

  const totals: FunnelRowData = {
    id: "__total__",
    label: totalLabel,
    href: null,
    scraped:  sumStage(rows, "scraped"),
    analysed: sumStage(rows, "analysed"),
    tailored: sumStage(rows, "tailored"),
    letter:   sumStage(rows, "letter"),
    applied:  sumStage(rows, "applied"),
  };

  return (
    <section className="anim-in anim-delay-1 space-y-2">
      <h2 className="text-[13px] font-semibold text-text">{title}</h2>
      <div className="bg-surface border border-border rounded-md overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[720px]">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2.5 px-4 text-[11px] font-semibold text-text-3 uppercase tracking-wider">
                {title.replace("By ", "")}
              </th>
              {STAGES.map((s) => (
                <th
                  key={s.key}
                  className="py-2.5 px-3 text-[11px] font-semibold text-text-3 uppercase tracking-wider text-right whitespace-nowrap"
                >
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <FunnelRow key={row.id} row={row} />
            ))}
            <FunnelRow row={totals} isTotal />
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FunnelRow({ row, isTotal = false }: { row: FunnelRowData; isTotal?: boolean }) {
  return (
    <tr
      className={
        isTotal
          ? "border-t-2 border-border bg-surface-2/40"
          : "border-b border-border last:border-b-0 hover:bg-surface-2/40 transition-colors"
      }
    >
      <td className="py-3 px-4 align-middle whitespace-nowrap">
        {isTotal || !row.href ? (
          <span className="text-[13px] font-semibold text-text">{row.label}</span>
        ) : (
          <Link
            href={row.href}
            className={`text-[13px] font-medium text-[var(--brand)] hover:underline ${row.capitalize ? "capitalize" : ""}`}
          >
            {row.label}
          </Link>
        )}
      </td>
      {STAGES.map((s) => {
        const count  = row[s.key];
        const conv   = s.prev ? pct(count, row[s.prev]) : null;
        const barPct = row.scraped > 0 ? Math.min(100, Math.round((count / row.scraped) * 100)) : 0;
        return (
          <td key={s.key} className="py-3 px-3 align-top">
            <div className="flex flex-col items-end">
              <span className={`text-[15px] tabular-nums ${isTotal ? "font-bold" : "font-semibold"} text-text`}>
                {count}
              </span>
              {s.prev && (
                <span className="text-[11px] text-text-3 tabular-nums mt-0.5">
                  {conv === null ? "—" : `${conv}%`}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-[var(--brand)]/15 overflow-hidden">
              <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${barPct}%` }} />
            </div>
          </td>
        );
      })}
    </tr>
  );
}

function EmptyState() {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Pipeline analytics</h1>
      </div>
      <div className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="text-center max-w-md anim-in">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-7 h-7 text-[var(--brand)]" />
          </div>
          <h2 className="text-[16px] font-semibold text-text mb-2">No pipeline data yet</h2>
          <p className="text-[13px] text-text-2 leading-relaxed mb-6">
            Once your profiles have run and saved jobs, you&apos;ll see the pipeline funnel
            broken down by source and profile here.
          </p>
          <Link href="/dashboard" className="gh-btn gh-btn-blue text-[13px] px-4 py-2">
            Go to the job board →
          </Link>
        </div>
      </div>
    </div>
  );
}
