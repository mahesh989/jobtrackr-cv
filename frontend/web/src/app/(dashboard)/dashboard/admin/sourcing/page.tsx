/**
 * /dashboard/admin/sourcing — Job sourcing pipeline health
 *
 * Answers:
 *   - How many jobs are we fetching and saving per run? (by source)
 *   - Is each scraper working right now?
 *   - What's the JD quality ratio — full vs thin descriptions?
 *   - What's the dedup rate and is it stable?
 *   - Where does keyword filtering drop the most jobs?
 *
 * Real data:  run_logs (jobs_fetched, jobs_saved, jobs_deduped, sources_run,
 *             sources_saved), jobs table (jd_quality, dedup_status).
 * Dummy data: per-source last-seen status badges — replace with a real
 *             max(started_at) per source query from run_logs.
 *             See lib/admin/dummyData.ts for removal instructions.
 */
import { requireAdmin, timeAgo, resolveRange, rangeStart, RANGE_LABELS } from "@/lib/admin/guard";
import { AdminRangeFilter } from "@/components/admin/AdminRangeFilter";
import Link from "next/link";
import { DUMMY_SOURCE_STATUS } from "@/lib/admin/dummyData";

export const metadata = { title: "Sourcing Health — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function Kpi({ label, value, sub, color = "text-text" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="border border-border bg-surface rounded-md px-4 py-3">
      <p className="text-[11px] font-medium text-text-3 mb-0.5">{label}</p>
      <p className={`text-[22px] font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-3 mt-0.5">{sub}</p>}
    </div>
  );
}

function PctBar({ pct, color = "bg-blue-500" }: { pct: number; color?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5 min-w-[60px]">
        <div className={`${color} h-1.5 rounded-full`} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1 : 0, pct))}%` }} />
      </div>
      <span className="text-[11px] text-text-3 w-10 text-right tabular-nums">{pct.toFixed(1)}%</span>
    </div>
  );
}

interface PageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function AdminSourcingPage({ searchParams }: PageProps) {
  const sp    = await searchParams;
  const range = resolveRange(sp.range);
  const { admin } = await requireAdmin();

  const now    = new Date();
  const cutoff = rangeStart(range);
  const d7ago  = new Date(now.getTime() - 7  * 86400_000);

  const [
    { data: runLogsRaw },
    { data: jobsRaw },
    { data: appliedJobsRaw },
  ] = await Promise.all([
    admin.from("run_logs")
      .select("id, profile_id, status, started_at, jobs_fetched, jobs_saved, jobs_deduped, sources_run, sources_saved, source_methods")
      .gte("started_at", cutoff.toISOString())
      .order("started_at", { ascending: false }),
    admin.from("jobs")
      .select("id, jd_quality, dedup_status, source, location, created_at")
      .gte("created_at", cutoff.toISOString()),
    admin.from("jobs")
      .select("source, applied_at")
      .gte("created_at", cutoff.toISOString())
      .not("applied_at", "is", null),
  ]);

  type SourceMethods = {
    tier?: string;
    seek?:      { enabled?: boolean; listings?: string; jd?: string; merged?: number; fetched?: number; count?: number };
    adzuna?:    { enabled?: boolean; method?: string; enrichment?: string; merged?: number; fetched?: number };
    careerjet?: { enabled?: boolean; method?: string };
  };
  type RunLog = {
    id: string; profile_id: string; status: string; started_at: string;
    jobs_fetched: number; jobs_saved: number; jobs_deduped: number;
    sources_run: string[] | null;
    sources_saved: Record<string, number> | null;
    source_methods: SourceMethods | null;
  };
  type JobRow     = { id: string; jd_quality: string | null; dedup_status: string | null; source: string | null; location: string | null; created_at: string };
  type AppliedRow = { source: string | null; applied_at: string | null };

  const runLogs    = (runLogsRaw    ?? []) as RunLog[];
  const jobs       = (jobsRaw       ?? []) as JobRow[];
  const appliedJobs = (appliedJobsRaw ?? []) as AppliedRow[];

  const completedRuns = runLogs.filter((r) => r.status === "completed");
  const recentRuns7d  = runLogs.filter((r) => new Date(r.started_at) >= d7ago);

  // ── Aggregate run stats ──────────────────────────────────────────────────
  const totalFetched = completedRuns.reduce((s, r) => s + (r.jobs_fetched ?? 0), 0);
  const totalSaved   = completedRuns.reduce((s, r) => s + (r.jobs_saved   ?? 0), 0);
  const totalDeduped = completedRuns.reduce((s, r) => s + (r.jobs_deduped ?? 0), 0);

  const saveRate  = totalFetched > 0 ? (totalSaved   / totalFetched) * 100 : null;
  const dedupRate = totalFetched > 0 ? (totalDeduped / totalFetched) * 100 : null;

  const avgJobsPerRun = completedRuns.length > 0
    ? totalSaved / completedRuns.length
    : null;

  // ── Per-source breakdown from sources_saved ──────────────────────────────
  const perSource: Record<string, { saved: number; runs: number }> = {};
  completedRuns.forEach((r) => {
    const ss = r.sources_saved ?? {};
    Object.entries(ss).forEach(([src, count]) => {
      if (!perSource[src]) perSource[src] = { saved: 0, runs: 0 };
      perSource[src].saved += count as number;
      perSource[src].runs++;
    });
    // also count runs-per-source even when sources_saved is missing
    (r.sources_run ?? []).forEach((src) => {
      if (!perSource[src]) perSource[src] = { saved: 0, runs: 0 };
    });
  });
  const sourceRanked = Object.entries(perSource).sort((a, b) => b[1].saved - a[1].saved);
  const maxSourceSaved = Math.max(...sourceRanked.map(([, d]) => d.saved), 1);

  // ── JD quality breakdown ─────────────────────────────────────────────────
  const totalJobs = jobs.length;
  const fullJd    = jobs.filter((j) => j.jd_quality === "full").length;
  const thinJd    = jobs.filter((j) => j.jd_quality === "thin").length;
  const unknownJd = jobs.filter((j) => !j.jd_quality).length;
  const fullJdPct = totalJobs > 0 ? (fullJd / totalJobs) * 100 : null;

  // ── Source breakdown from jobs.source ───────────────────────────────────
  const jobsBySource: Record<string, { total: number; full: number; thin: number }> = {};
  jobs.forEach((j) => {
    const src = j.source ?? "unknown";
    if (!jobsBySource[src]) jobsBySource[src] = { total: 0, full: 0, thin: 0 };
    jobsBySource[src].total++;
    if (j.jd_quality === "full") jobsBySource[src].full++;
    if (j.jd_quality === "thin") jobsBySource[src].thin++;
  });
  const jobsBySourceRanked = Object.entries(jobsBySource).sort((a, b) => b[1].total - a[1].total);

  // ── Daily run count trend ────────────────────────────────────────────────
  const dayBuckets: Record<string, { runs: number; saved: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    dayBuckets[d.toISOString().slice(0, 10)] = { runs: 0, saved: 0 };
  }
  recentRuns7d.forEach((r) => {
    const day = r.started_at.slice(0, 10);
    if (day in dayBuckets) {
      dayBuckets[day].runs++;
      dayBuckets[day].saved += r.jobs_saved ?? 0;
    }
  });
  const maxDaySaved = Math.max(...Object.values(dayBuckets).map((d) => d.saved), 1);

  // ── Applied jobs by source ───────────────────────────────────────────────
  const appliedBySource: Record<string, number> = {};
  appliedJobs.forEach((j) => {
    const src = j.source ?? "unknown";
    appliedBySource[src] = (appliedBySource[src] ?? 0) + 1;
  });
  const appliedTotal = appliedJobs.length;

  // Source-to-applied funnel: saved → applied (via jobs table)
  const savedBySource = Object.fromEntries(
    Object.entries(jobsBySource).map(([src, d]) => [src, d.total])
  );
  const allSources = [...new Set([
    ...Object.keys(savedBySource),
    ...Object.keys(appliedBySource),
  ])].sort();

  // ── Top job locations ────────────────────────────────────────────────────
  const locationCount: Record<string, number> = {};
  jobs.forEach((j) => {
    const loc = (j.location ?? "").trim();
    if (!loc || loc.length < 2) return;
    // Normalize: take first comma-delimited segment if long
    const key = loc.includes(",") ? loc.split(",").map((s) => s.trim()).slice(-2).join(", ") : loc;
    locationCount[key] = (locationCount[key] ?? 0) + 1;
  });
  const topLocations = Object.entries(locationCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const maxLocationCount = topLocations[0]?.[1] ?? 1;

  // ── Source method aggregates (from source_methods JSONB) ────────────────
  const runsWithMethods = completedRuns.filter((r) => r.source_methods != null);
  const seekDirectFails   = runsWithMethods.filter((r) => r.source_methods?.seek?.listings === "skipped"   || r.source_methods?.seek?.listings === "apify_failed").length;
  const seekApifyFallback = runsWithMethods.filter((r) => r.source_methods?.seek?.listings === "apify_fallback").length;
  const adzunaActorFails  = runsWithMethods.filter((r) => r.source_methods?.adzuna?.enrichment === "actor_failed_teaser").length;
  const adzunaEnriched    = runsWithMethods.filter((r) => r.source_methods?.adzuna?.enrichment === "actor").length;

  // ── Recent run log ───────────────────────────────────────────────────────
  const recentRunsLog = runLogs.slice(0, 15);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Sourcing health</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Job sourcing health</h1>
            <p className="text-[12px] text-text-3 mt-0.5">Worker pipeline — fetching, dedup, JD quality, locations. Source availability badges use placeholder data.</p>
          </div>
          <AdminRangeFilter current={range} path="/dashboard/admin/sourcing" />
        </div>
      </div>

      {/* DUMMY_DATA banner */}
      <div className="mx-6 mt-4 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-[12px] text-amber-800">
        <span className="text-base leading-none mt-0.5">⚠</span>
        <span><span className="font-semibold">Partial dummy data</span> — Source availability badges (last-seen timestamps and status) use placeholder values.
        Replace with a real <code className="font-mono text-[11px]">SELECT source, max(started_at)</code> query from <code className="font-mono text-[11px]">run_logs</code>.
        See <code className="font-mono text-[11px]">lib/admin/dummyData.ts</code>.</span>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {/* Top KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Total saved (30d)"  value={totalSaved.toLocaleString()}  sub={`across ${completedRuns.length} runs`} color="text-emerald-700" />
          <Kpi label="Avg jobs / run"     value={avgJobsPerRun !== null ? avgJobsPerRun.toFixed(1) : "—"} sub="completed runs" />
          <Kpi label="Save rate"          value={saveRate !== null ? `${saveRate.toFixed(1)}%` : "—"} sub="fetched → saved" color={saveRate !== null && saveRate < 10 ? "text-amber-700" : "text-text"} />
          <Kpi label="Dedup rate"         value={dedupRate !== null ? `${dedupRate.toFixed(1)}%` : "—"} sub="cross-profile + same-URL" />
        </div>

        {/* Source availability — DUMMY_DATA */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-[12px] font-semibold text-text">Source availability</h2>
            <span className="text-[10px] bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded font-medium">DUMMY DATA</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {DUMMY_SOURCE_STATUS.map((s) => (
              <div key={s.source} className="border border-border bg-surface rounded-md px-4 py-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    s.status === "ok" ? "bg-emerald-500" : s.status === "degraded" ? "bg-amber-400" : "bg-red-500"
                  }`} />
                  <span className="text-[13px] font-semibold text-text capitalize">{s.source}</span>
                  <span className={`ml-auto text-[10px] font-medium ${
                    s.status === "ok" ? "text-emerald-700" : s.status === "degraded" ? "text-amber-700" : "text-red-700"
                  }`}>{s.status}</span>
                </div>
                <p className="text-[11px] text-text-3">Last seen: {timeAgo(s.lastSeen)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Per-source save counts */}
        {sourceRanked.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Jobs saved by source (30d)</h2>
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2.5">
              {sourceRanked.map(([src, d]) => (
                <div key={src} className="flex items-center gap-3">
                  <span className="text-[12px] text-text-2 w-28 capitalize truncate">{src}</span>
                  <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: `${Math.max(d.saved > 0 ? 1 : 0, (d.saved / maxSourceSaved) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-text-2 w-14 text-right tabular-nums">{d.saved.toLocaleString()}</span>
                  <span className="text-[10px] text-text-3 w-20 text-right">{d.runs} run{d.runs !== 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* JD quality */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">JD quality (30d)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Kpi label="Total jobs (30d)"  value={totalJobs.toLocaleString()} />
            <Kpi label="Full JD"           value={String(fullJd)}  sub={fullJdPct !== null ? `${fullJdPct.toFixed(1)}% of saved` : ""} color="text-emerald-700" />
            <Kpi label="Thin JD"           value={String(thinJd)}  sub="too short to analyse" color={thinJd > fullJd ? "text-amber-700" : "text-text"} />
            <Kpi label="Unknown quality"   value={String(unknownJd)} sub="not yet classified" />
          </div>

          {/* By source */}
          {jobsBySourceRanked.length > 0 && (
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Source</th><th>Total</th><th>Full JD</th><th>Thin JD</th><th>Full %</th></tr></thead>
                <tbody>
                  {jobsBySourceRanked.map(([src, d]) => {
                    const fp = d.total > 0 ? (d.full / d.total) * 100 : 0;
                    return (
                      <tr key={src}>
                        <td className="capitalize font-medium text-text">{src}</td>
                        <td className="tabular-nums">{d.total}</td>
                        <td className="tabular-nums text-emerald-700">{d.full}</td>
                        <td className="tabular-nums text-amber-700">{d.thin}</td>
                        <td><PctBar pct={fp} color={fp >= 60 ? "bg-emerald-500" : fp >= 30 ? "bg-amber-400" : "bg-red-400"} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Daily trend */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Daily jobs saved — last 7 days</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
            {Object.entries(dayBuckets).map(([day, d]) => (
              <div key={day} className="flex items-center gap-3">
                <span className="text-[11px] text-text-3 tabular-nums w-24">{day}</span>
                <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full"
                    style={{ width: d.saved > 0 ? `${Math.max(2, (d.saved / maxDaySaved) * 100)}%` : "0%" }}
                  />
                </div>
                <span className="text-[11px] font-mono text-text-2 w-14 text-right tabular-nums">{d.saved}</span>
                <span className="text-[10px] text-text-3 w-16 text-right">{d.runs} run{d.runs !== 1 ? "s" : ""}</span>
              </div>
            ))}
            {Object.values(dayBuckets).every((d) => d.saved === 0) && (
              <p className="text-[12px] text-text-3 text-center py-4">No completed runs in the last 7 days.</p>
            )}
          </div>
        </section>

        {/* Source-to-applied funnel */}
        {allSources.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Source → applied funnel ({RANGE_LABELS[range]})</h2>
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Jobs saved</th>
                    <th>Applied</th>
                    <th>Apply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {allSources.map((src) => {
                    const saved   = savedBySource[src]   ?? 0;
                    const applied = appliedBySource[src] ?? 0;
                    const rate    = saved > 0 ? (applied / saved) * 100 : 0;
                    return (
                      <tr key={src}>
                        <td className="font-medium capitalize text-text">{src}</td>
                        <td className="tabular-nums">{saved.toLocaleString()}</td>
                        <td className={`tabular-nums font-semibold ${applied > 0 ? "text-emerald-700" : "text-text-3"}`}>{applied}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5 min-w-[60px]">
                              <div
                                className={`h-1.5 rounded-full ${rate >= 5 ? "bg-emerald-500" : rate >= 1 ? "bg-blue-400" : "bg-slate-300"}`}
                                style={{ width: `${Math.min(100, rate * 10)}%` }}
                              />
                            </div>
                            <span className="text-[11px] text-text-3 w-12 text-right tabular-nums">{rate.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {appliedTotal > 0 && (
                    <tr className="border-t-2 border-border font-semibold">
                      <td className="text-text">Total</td>
                      <td className="tabular-nums">{totalSaved.toLocaleString()}</td>
                      <td className="tabular-nums text-emerald-700">{appliedTotal}</td>
                      <td className="tabular-nums text-[12px] text-text-3">
                        {totalSaved > 0 ? ((appliedTotal / totalSaved) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Top job locations */}
        {topLocations.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Top job locations ({RANGE_LABELS[range]})</h2>
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
              {topLocations.map(([loc, count]) => (
                <div key={loc} className="flex items-center gap-3">
                  <span className="text-[12px] text-text-2 w-52 truncate">{loc}</span>
                  <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: `${Math.max(2, (count / maxLocationCount) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-text-2 w-14 text-right tabular-nums">{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Source method health (from source_methods JSONB — populated after migration 065) */}
        {runsWithMethods.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Source method health ({RANGE_LABELS[range]})</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Runs tracked"           value={String(runsWithMethods.length)} sub="with source_methods" />
              <Kpi label="SEEK direct failures"   value={String(seekDirectFails)}   sub="listings skipped / actor failed" color={seekDirectFails > 0 ? "text-red-600" : "text-text"} />
              <Kpi label="SEEK Apify fallbacks"   value={String(seekApifyFallback)} sub="unlimited only"                  color={seekApifyFallback > 0 ? "text-amber-700" : "text-text"} />
              <Kpi label="Adzuna actor failures"  value={String(adzunaActorFails)}  sub={`${adzunaEnriched} enriched ok`} color={adzunaActorFails > 0 ? "text-amber-700" : "text-text"} />
            </div>
          </section>
        )}

        {/* Recent run log */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Recent worker runs</h2>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Run</th><th>Status</th><th>Tier</th><th>Source methods</th><th>Fetched</th><th>Saved</th><th>Started</th></tr></thead>
              <tbody>
                {recentRunsLog.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-text-3 py-6">No runs yet.</td></tr>
                )}
                {recentRunsLog.map((r) => {
                  const sm = r.source_methods;
                  const seekChip = sm?.seek?.listings === "direct"          ? { label: "SEEK direct",    cls: "text-emerald-700" }
                                 : sm?.seek?.listings === "apify_fallback"  ? { label: "SEEK→Apify",     cls: "text-amber-700" }
                                 : sm?.seek?.listings === "apify"           ? { label: "SEEK Apify",     cls: "text-blue-700" }
                                 : sm?.seek?.listings === "skipped"         ? { label: "SEEK skipped",   cls: "text-red-600" }
                                 : sm?.seek?.listings === "apify_failed"    ? { label: "SEEK apify fail",cls: "text-red-600" }
                                 : null;
                  const adzunaChip = sm?.adzuna?.enrichment === "actor"                    ? { label: "Adzuna full JD", cls: "text-emerald-700" }
                                   : sm?.adzuna?.enrichment === "actor_failed_teaser"      ? { label: "Adzuna↓teaser",  cls: "text-amber-700" }
                                   : sm?.adzuna?.enrichment === "none" || sm?.adzuna?.method === "api" ? { label: "Adzuna teaser", cls: "text-text-3" }
                                   : null;
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-[11px] text-text-3">{r.id.slice(0, 8)}…</td>
                      <td>
                        <span className={`badge text-[10px] ${r.status === "completed" ? "badge-green" : r.status === "failed" ? "badge-red" : r.status === "running" ? "badge-blue" : "badge-gray"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="text-[11px] text-text-3 tabular-nums">{sm?.tier ?? "—"}</td>
                      <td className="text-[10px] space-x-1">
                        {seekChip   && <span className={`font-medium ${seekChip.cls}`}>{seekChip.label}</span>}
                        {adzunaChip && <span className={`font-medium ${adzunaChip.cls}`}>{adzunaChip.label}</span>}
                        {!sm && <span className="text-text-3">—</span>}
                      </td>
                      <td className="tabular-nums text-text-2">{r.jobs_fetched ?? 0}</td>
                      <td className={`tabular-nums font-semibold ${(r.jobs_saved ?? 0) > 0 ? "text-emerald-700" : "text-text-3"}`}>{r.jobs_saved ?? 0}</td>
                      <td className="text-text-3">{timeAgo(r.started_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
