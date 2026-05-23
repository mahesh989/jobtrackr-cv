/**
 * /dashboard/analytics — per-source pipeline funnel.
 *
 * One row per source (adzuna, seek, greenhouse, …) showing the full pipeline:
 *   Scraped → Analysed → Passed gate → Letter → Applied
 * with the conversion % from the previous step in each cell.
 *
 * Data:
 *   - Scraped     — sum of run_logs.sources_saved jsonb across the user's runs.
 *   - Analysed    — jobs (grouped by jobs.source) with a completed analysis_run.
 *   - Passed gate — those jobs whose latest completed run passed the final ATS gate.
 *   - Letter      — jobs with a completed cover_letter.
 *   - Applied     — jobs with applied_at set.
 *
 * Server-rendered only — counts + div bars, no canvas. Source names link to
 * /dashboard?source=X to filter the job board down to that source.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BarChart3 } from "lucide-react";

interface SourceFunnel {
  source:     string;
  scraped:    number;
  analysed:   number;
  passedGate: number;
  letter:     number;
  applied:    number;
}

type StageKey = "scraped" | "analysed" | "passedGate" | "letter" | "applied";

const STAGES: Array<{ key: StageKey; label: string; prev: StageKey | null }> = [
  { key: "scraped",    label: "Scraped",     prev: null },
  { key: "analysed",   label: "Analysed",    prev: "scraped" },
  { key: "passedGate", label: "Passed gate", prev: "analysed" },
  { key: "letter",     label: "Letter",      prev: "passedGate" },
  { key: "applied",    label: "Applied",     prev: "letter" },
];

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 100);
}

export default async function AnalyticsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id")
    .order("created_at", { ascending: false });
  const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);

  if (ids.length === 0) return <EmptyState />;

  // ── 1. Scraped per source — run_logs.sources_saved (lifetime) ──────────────
  const { data: runLogData } = await supabase
    .from("run_logs")
    .select("sources_saved")
    .in("profile_id", ids);

  const scrapedBySource: Record<string, number> = {};
  for (const r of (runLogData ?? []) as Array<{ sources_saved: Record<string, number> | null }>) {
    if (!r.sources_saved) continue;
    for (const [src, n] of Object.entries(r.sources_saved)) {
      scrapedBySource[src] = (scrapedBySource[src] ?? 0) + (n ?? 0);
    }
  }

  // ── 2. Jobs grouped by source ──────────────────────────────────────────────
  const { data: jobRows } = await supabase
    .from("jobs")
    .select("id, source, applied_at")
    .in("profile_id", ids);

  const jobs = (jobRows ?? []) as Array<{ id: string; source: string; applied_at: string | null }>;
  const jobIds = jobs.map((j) => j.id);

  // ── 3. Latest completed analysis run per job (for analysed + passed gate) ──
  const { data: runRows } = jobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("job_id, passed_final_gate, created_at")
        .in("job_id", jobIds)
        .eq("status", "completed")
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as Array<{ job_id: string; passed_final_gate: boolean | null }> };

  const latestRunByJob = new Map<string, { passed_final_gate: boolean | null }>();
  for (const r of (runRows ?? []) as Array<{ job_id: string; passed_final_gate: boolean | null }>) {
    if (!latestRunByJob.has(r.job_id)) latestRunByJob.set(r.job_id, r);
  }

  // ── 4. Jobs with a completed cover letter ──────────────────────────────────
  const { data: letterRows } = jobIds.length > 0
    ? await supabase
        .from("cover_letters")
        .select("job_id")
        .in("job_id", jobIds)
        .eq("status", "completed")
        .eq("is_stale", false)
    : { data: [] as Array<{ job_id: string }> };
  const letterSet = new Set(((letterRows ?? []) as Array<{ job_id: string }>).map((l) => l.job_id));

  // ── Aggregate per source ───────────────────────────────────────────────────
  const agg: Record<string, SourceFunnel> = {};
  const ensure = (src: string): SourceFunnel =>
    (agg[src] ??= { source: src, scraped: 0, analysed: 0, passedGate: 0, letter: 0, applied: 0 });

  for (const [src, n] of Object.entries(scrapedBySource)) ensure(src).scraped = n;

  const jobsCountBySource: Record<string, number> = {};
  for (const j of jobs) {
    jobsCountBySource[j.source] = (jobsCountBySource[j.source] ?? 0) + 1;
    const row = ensure(j.source);
    const run = latestRunByJob.get(j.id);
    if (run) {
      row.analysed++;
      if (run.passed_final_gate) row.passedGate++;
    }
    if (letterSet.has(j.id)) row.letter++;
    if (j.applied_at) row.applied++;
  }

  // run_logs.sources_saved is the source of truth for Scraped, but runs from
  // before the sources_saved column existed have NULL — fall back to the live
  // job count so the funnel never grows from one step to the next.
  for (const src of Object.keys(agg)) {
    agg[src].scraped = Math.max(agg[src].scraped, jobsCountBySource[src] ?? 0);
  }

  const rows = Object.values(agg)
    .filter((r) => r.scraped > 0 || r.analysed > 0)
    .sort((a, b) => b.scraped - a.scraped);

  if (rows.length === 0) return <EmptyState />;

  const totals: SourceFunnel = {
    source:     "All sources",
    scraped:    rows.reduce((a, r) => a + r.scraped, 0),
    analysed:   rows.reduce((a, r) => a + r.analysed, 0),
    passedGate: rows.reduce((a, r) => a + r.passedGate, 0),
    letter:     rows.reduce((a, r) => a + r.letter, 0),
    applied:    rows.reduce((a, r) => a + r.applied, 0),
  };

  const overallConv = pct(totals.applied, totals.scraped);

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Analytics</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Source analytics</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          Per-source pipeline funnel · {rows.length} source{rows.length !== 1 ? "s" : ""}
          {overallConv !== null && <> · {overallConv}% scraped → applied overall</>}
        </p>
      </div>

      <div className="px-6 py-5 space-y-4">
        <p className="text-[12px] text-text-2 anim-in max-w-3xl">
          Each row tracks jobs from one source through the pipeline. The small percentage
          under a count is its conversion from the previous step. Click a source to view
          its jobs on the board.
        </p>

        <div className="bg-surface border border-border rounded-md overflow-x-auto anim-in anim-delay-1">
          <table className="w-full text-left border-collapse min-w-[680px]">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2.5 px-4 text-[11px] font-semibold text-text-3 uppercase tracking-wider">
                  Source
                </th>
                {STAGES.map((s) => (
                  <th
                    key={s.key}
                    className="py-2.5 px-3 text-[11px] font-semibold text-text-3 uppercase tracking-wider text-right"
                  >
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <FunnelRow key={row.source} row={row} />
              ))}
              <FunnelRow row={totals} isTotal />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FunnelRow({ row, isTotal = false }: { row: SourceFunnel; isTotal?: boolean }) {
  return (
    <tr
      className={
        isTotal
          ? "border-t-2 border-border bg-surface-2/40"
          : "border-b border-border last:border-b-0 hover:bg-surface-2/40 transition-colors"
      }
    >
      <td className="py-3 px-4 align-middle whitespace-nowrap">
        {isTotal ? (
          <span className="text-[13px] font-semibold text-text">{row.source}</span>
        ) : (
          <Link
            href={`/dashboard?source=${encodeURIComponent(row.source)}`}
            className="text-[13px] font-medium text-[var(--brand)] hover:underline capitalize"
          >
            {row.source}
          </Link>
        )}
      </td>
      {STAGES.map((s) => {
        const count = row[s.key];
        const conv  = s.prev ? pct(count, row[s.prev]) : null;
        const barPct = row.scraped > 0 ? Math.min(100, Math.round((count / row.scraped) * 100)) : 0;
        return (
          <td key={s.key} className="py-3 px-3 align-top">
            <div className="flex flex-col items-end">
              <span className={`text-[15px] tabular-nums ${isTotal ? "font-bold text-text" : "font-semibold text-text"}`}>
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
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Source analytics</h1>
      </div>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="text-center max-w-md anim-in">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-7 h-7 text-[var(--brand)]" />
          </div>
          <h2 className="text-[16px] font-semibold text-text mb-2">No source data yet</h2>
          <p className="text-[13px] text-text-2 leading-relaxed mb-6">
            Once your profiles have run and saved jobs, you&apos;ll see a per-source breakdown
            of the pipeline funnel here.
          </p>
          <Link href="/dashboard" className="gh-btn gh-btn-blue text-[13px] px-4 py-2">
            Go to the job board →
          </Link>
        </div>
      </div>
    </div>
  );
}
