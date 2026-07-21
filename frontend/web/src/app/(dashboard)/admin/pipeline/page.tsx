/**
 * /admin/pipeline — Pipeline health
 *
 * Answers:
 *   - How reliable is the analysis pipeline? (success/fail/cancel rates)
 *   - Where exactly do runs fail? (which step)
 *   - How long does the full pipeline take? (p50/p95)
 *   - How often do AI transient errors fire and how effective is the retry?
 *   - What's the ATS uplift distribution across all runs?
 */
import { requireAdmin, timeAgo, formatLatency, resolveRange, rangeStart, RANGE_LABELS } from "@/lib/admin/guard";
import { RangeFilter } from "@/features/admin/RangeFilter";
import { adminForceCancelRun } from "@/lib/admin/actions";
import Link from "next/link";

export const metadata = { title: "Pipeline Health — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function PctBar({ pct, color = "blue" }: { pct: number; color?: "green"|"red"|"amber"|"blue" }) {
  const cls = { green: "bg-emerald-500", red: "bg-red-500", amber: "bg-amber-400", blue: "bg-blue-500" }[color];
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
        <div className={`${cls} h-1.5 rounded-full`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-caption text-text-3 w-10 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}

interface PageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function AdminPipelinePage({ searchParams }: PageProps) {
  const sp    = await searchParams;
  const range = resolveRange(sp.range);
  const { admin } = await requireAdmin();

  const now    = new Date();
  const cutoff = rangeStart(range);
  const stuckCutoff = new Date(now.getTime() - 20 * 60_000); // 20 min ago

  // Core queries — always exist
  const [
    { data: recentRuns },
    { data: allUsers },
    { data: stuckRuns },
  ] = await Promise.all([
    admin.from("analysis_runs")
      .select("id, user_id, status, error_message, created_at, match_score, tailored_match_score, ats_lift, step_status")
      .gte("created_at", cutoff.toISOString())
      .order("created_at", { ascending: false }),
    admin.from("users").select("id, email"),
    // Stuck runs: status='running' and started over 20 min ago
    admin.from("analysis_runs")
      .select("id, user_id, status, created_at, started_at, step_status")
      .eq("status", "running")
      .lt("created_at", stuckCutoff.toISOString())
      .order("created_at", { ascending: true }),
  ]);

  // Optional observability tables — only exist after migration 055.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);
  const [recentTimings, aiErrors] = await Promise.all([
    safeQuery(admin.from("pipeline_timings")
      .select("run_id, step, duration_ms, status, created_at")
      .gte("created_at", cutoff.toISOString())),
    safeQuery(admin.from("ai_calls")
      .select("operation, provider, model, retry_count, status, error_type, latency_ms, created_at")
      .gte("created_at", cutoff.toISOString())),
  ]);

  type RunRow     = { id: string; user_id: string; status: string; error_message: string | null; created_at: string; match_score: number | null; tailored_match_score: number | null; ats_lift: number | null; step_status: Record<string, string> | null };
  type StuckRow   = { id: string; user_id: string; status: string; created_at: string; started_at: string | null; step_status: Record<string, string> | null };
  type TimingRow  = { run_id: string; step: string; duration_ms: number | null; status: string; created_at: string };
  type AiCallRow  = { operation: string; provider: string; model: string; retry_count: number; status: string; error_type: string | null; latency_ms: number; created_at: string };

  const runs      = (recentRuns ?? []) as RunRow[];
  const stuck     = (stuckRuns  ?? []) as StuckRow[];
  const timings   = recentTimings as TimingRow[];
  const aiCalls   = aiErrors      as AiCallRow[];
  const users     = (allUsers   ?? []) as { id: string; email: string }[];
  const emailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});

  // ── Run status breakdown ─────────────────────────────────────────────────
  const total     = runs.length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed    = runs.filter((r) => r.status === "failed").length;
  const cancelled = runs.filter((r) => r.status === "failed" && (r.error_message ?? "").toLowerCase().startsWith("cancelled")).length;
  const running   = runs.filter((r) => r.status === "running").length;
  const successPct = total > 0 ? (completed / total) * 100 : 0;
  const failPct    = total > 0 ? (failed / total) * 100 : 0;

  // ── Failure taxonomy from error_message ─────────────────────────────────
  const failedRuns = runs.filter((r) => r.status === "failed" && !(r.error_message ?? "").toLowerCase().startsWith("cancelled"));
  const errGroups: Record<string, number> = {};
  failedRuns.forEach((r) => {
    const msg = r.error_message ?? "Unknown";
    const key = msg.length > 60 ? msg.slice(0, 60) + "…" : msg;
    errGroups[key] = (errGroups[key] ?? 0) + 1;
  });
  const errRanked = Object.entries(errGroups).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // ── Step failure rate (from step_status on failed runs) ─────────────────
  const stepFails: Record<string, number> = {};
  failedRuns.forEach((r) => {
    if (!r.step_status) return;
    const failedStep = Object.entries(r.step_status).find(([, v]) => v === "failed");
    if (failedStep) stepFails[failedStep[0]] = (stepFails[failedStep[0]] ?? 0) + 1;
  });
  const stepRanked = Object.entries(stepFails).sort((a, b) => b[1] - a[1]);

  // ── Pipeline latency from pipeline_timings ────────────────────────────
  const totalStepTimings = timings.filter((t) => t.step === "total" && t.duration_ms != null);
  const allDurations     = totalStepTimings.map((t) => t.duration_ms!).sort((a, b) => a - b);
  const p50 = allDurations.length > 0 ? allDurations[Math.floor(allDurations.length * 0.5)] : null;
  const p95 = allDurations.length > 0 ? allDurations[Math.floor(allDurations.length * 0.95)] : null;

  // Per-step median latency
  const stepDurations: Record<string, number[]> = {};
  timings.filter((t) => t.duration_ms != null && t.step !== "total").forEach((t) => {
    (stepDurations[t.step] ??= []).push(t.duration_ms!);
  });
  const stepLatency = Object.entries(stepDurations)
    .map(([step, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      return { step, p50: sorted[Math.floor(sorted.length * 0.5)], count: sorted.length };
    })
    .sort((a, b) => b.p50 - a.p50);

  // ── AI call reliability ─────────────────────────────────────────────────
  const totalCalls   = aiCalls.length;
  const errorAiCalls = aiCalls.filter((c) => c.status === "error").length;
  const retryCalls   = aiCalls.filter((c) => c.retry_count > 0).length;
  const aiErrorRate  = totalCalls > 0 ? (errorAiCalls / totalCalls) * 100 : 0;

  const aiLatencies  = aiCalls.filter((c) => c.latency_ms > 0).map((c) => c.latency_ms).sort((a, b) => a - b);
  const aiP95        = aiLatencies.length > 0 ? aiLatencies[Math.floor(aiLatencies.length * 0.95)] : null;

  // ── ATS uplift distribution ──────────────────────────────────────────────
  const completedWithScores = runs.filter((r) => r.status === "completed" && r.tailored_match_score != null);
  const liftBuckets         = { negative: 0, "0-5": 0, "5-15": 0, "15-30": 0, "30+": 0 };
  completedWithScores.forEach((r) => {
    const lift = r.ats_lift ?? 0;
    if (lift < 0)        liftBuckets.negative++;
    else if (lift <= 5)  liftBuckets["0-5"]++;
    else if (lift <= 15) liftBuckets["5-15"]++;
    else if (lift <= 30) liftBuckets["15-30"]++;
    else                 liftBuckets["30+"]++;
  });
  const avgLift = completedWithScores.length > 0
    ? completedWithScores.reduce((s, r) => s + (r.ats_lift ?? 0), 0) / completedWithScores.length
    : null;
  const avgTailored = completedWithScores.length > 0
    ? completedWithScores.reduce((s, r) => s + (r.tailored_match_score ?? 0), 0) / completedWithScores.length
    : null;

  // ── Recent failures (last 10) ────────────────────────────────────────────
  const lastFailures = failedRuns.slice(0, 10);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-caption text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Pipeline health</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lead font-semibold text-text">Pipeline health</h1>
            {stuck.length > 0 && (
              <span className="px-2 py-0.5 bg-red-100 text-red-700 border border-red-200 rounded text-caption font-semibold animate-pulse">
                {stuck.length} STUCK
              </span>
            )}
          </div>
          <RangeFilter current={range} path="/admin/pipeline" />
        </div>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {/* Stuck runs — shown prominently when present */}
        {stuck.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-label font-semibold text-red-700">Stuck runs</h2>
              <span className="text-caption text-red-600">status=running for &gt;20 min — likely hung</span>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-md overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Run ID</th>
                    <th>User</th>
                    <th>Last step</th>
                    <th>Stuck for</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {stuck.map((r) => {
                    const stuckMins = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 60_000);
                    const lastStep  = r.step_status
                      ? Object.entries(r.step_status).filter(([, v]) => v === "running").map(([k]) => k)[0]
                        ?? Object.entries(r.step_status).filter(([, v]) => v === "completed").map(([k]) => k).pop()
                      : null;
                    return (
                      <tr key={r.id}>
                        <td className="font-mono text-caption text-text-3">{r.id.slice(0, 8)}…</td>
                        <td className="text-label text-text-2">{emailById[r.user_id] ?? r.user_id.slice(0, 10)}</td>
                        <td className="text-label text-text-3">{lastStep?.replace(/_/g, " ") ?? "—"}</td>
                        <td className={`tabular-nums font-semibold text-label ${stuckMins > 60 ? "text-red-700" : "text-amber-700"}`}>
                          {stuckMins}m
                        </td>
                        <td>
                          <form action={adminForceCancelRun.bind(null, r.id)}>
                            <button
                              type="submit"
                              className="text-caption text-red-600 hover:text-red-800 font-semibold border border-red-200 rounded px-2 py-0.5 hover:bg-red-50 transition-colors"
                            >
                              Force cancel
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Run status KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Total runs",  value: String(total),     color: "text-text" },
            { label: "Completed",   value: String(completed), color: "text-emerald-700" },
            { label: "Failed",      value: String(failed),    color: failed > 0 ? "text-red-700" : "text-text-3" },
            { label: "Cancelled",   value: String(cancelled), color: cancelled > 0 ? "text-amber-700" : "text-text-3" },
            { label: "Currently running", value: String(running), color: running > 0 ? "text-blue-700" : "text-text-3" },
          ].map((s) => (
            <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
              <p className="text-caption text-text-3 mb-0.5">{s.label}</p>
              <p className={`text-h2 font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Success / fail rate bars */}
        <section>
          <h2 className="text-label font-semibold text-text mb-3">Success rate</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-3">
            <div><p className="text-caption text-text-3 mb-1">Completed</p><PctBar pct={successPct} color="green" /></div>
            <div><p className="text-caption text-text-3 mb-1">Failed (non-cancelled)</p><PctBar pct={failPct} color="red" /></div>
          </div>
        </section>

        {/* Latency */}
        {(p50 !== null || aiP95 !== null) && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">Latency</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Pipeline p50",       value: p50  !== null ? formatLatency(p50)  : "—" },
                { label: "Pipeline p95",       value: p95  !== null ? formatLatency(p95)  : "—" },
                { label: "AI call p95 (30d)",  value: aiP95 !== null ? formatLatency(aiP95) : "—" },
                { label: "AI retry rate",      value: totalCalls > 0 ? `${((retryCalls / totalCalls) * 100).toFixed(1)}%` : "—" },
              ].map((s) => (
                <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
                  <p className="text-caption text-text-3 mb-0.5">{s.label}</p>
                  <p className="text-h3 font-bold text-text">{s.value}</p>
                </div>
              ))}
            </div>

            {stepLatency.length > 0 && (
              <div className="mt-3 bg-surface border border-border rounded-md px-4 py-4 space-y-2">
                <p className="text-caption font-semibold text-text-3 mb-2">Median duration per pipeline step</p>
                {stepLatency.map(({ step, p50: sp50 }) => (
                  <div key={step} className="flex items-center gap-3">
                    <span className="text-label text-text-2 w-44 truncate">{step.replace(/_/g, " ")}</span>
                    <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
                      <div className="bg-blue-400 h-1.5 rounded-full" style={{ width: `${Math.min(100, (sp50 / (p95 ?? sp50)) * 100)}%` }} />
                    </div>
                    <span className="text-caption font-mono text-text-3 w-16 text-right">{formatLatency(sp50)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* AI reliability */}
        <section>
          <h2 className="text-label font-semibold text-text mb-3">AI call reliability ({RANGE_LABELS[range]})</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { label: "Total AI calls",  value: String(totalCalls) },
              { label: "Error rate",      value: `${aiErrorRate.toFixed(1)}%`, color: aiErrorRate > 5 ? "text-red-700" : "text-emerald-700" },
              { label: "Calls with retry",value: `${retryCalls} (${totalCalls > 0 ? ((retryCalls / totalCalls) * 100).toFixed(1) : 0}%)` },
            ].map((s) => (
              <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-caption text-text-3 mb-0.5">{s.label}</p>
                <p className={`text-h3 font-bold ${(s as { color?: string }).color ?? "text-text"}`}>{s.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ATS uplift distribution */}
        {completedWithScores.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">ATS uplift distribution (completed runs)</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-caption text-text-3 mb-0.5">Avg lift</p>
                <p className="text-h3 font-bold text-emerald-700">{avgLift !== null ? `+${avgLift.toFixed(1)}` : "—"}</p>
              </div>
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-caption text-text-3 mb-0.5">Avg tailored score</p>
                <p className="text-h3 font-bold text-text">{avgTailored !== null ? avgTailored.toFixed(1) : "—"}</p>
              </div>
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-caption text-text-3 mb-0.5">Runs scored</p>
                <p className="text-h3 font-bold text-text">{completedWithScores.length}</p>
              </div>
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-caption text-text-3 mb-0.5">Negative lift</p>
                <p className={`text-h3 font-bold ${liftBuckets.negative > 0 ? "text-red-700" : "text-text-3"}`}>{liftBuckets.negative}</p>
              </div>
            </div>
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
              {(Object.entries(liftBuckets) as [string, number][]).map(([bucket, count]) => {
                const pct = completedWithScores.length > 0 ? (count / completedWithScores.length) * 100 : 0;
                return (
                  <div key={bucket} className="flex items-center gap-3">
                    <span className="text-label text-text-2 w-24">{bucket === "negative" ? "< 0" : bucket} pts</span>
                    <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
                      <div className={`h-1.5 rounded-full ${bucket === "negative" ? "bg-red-400" : "bg-emerald-500"}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-caption text-text-3 w-20 text-right">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Failure taxonomy */}
        {errRanked.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">Failure causes (30d)</h2>
            <div className="bg-surface border border-red-200 rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Error message</th><th className="w-16">Count</th></tr></thead>
                <tbody>
                  {errRanked.map(([msg, count]) => (
                    <tr key={msg}>
                      <td className="text-red-700 text-label font-mono">{msg}</td>
                      <td className="tabular-nums font-semibold text-red-700">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Step failures */}
        {stepRanked.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">Failures by pipeline step (30d)</h2>
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
              {stepRanked.map(([step, count]) => (
                <div key={step} className="flex items-center gap-3">
                  <span className="text-label text-text-2 w-44">{step.replace(/_/g, " ")}</span>
                  <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5">
                    <div className="bg-red-400 h-1.5 rounded-full"
                      style={{ width: `${Math.min(100, (count / (stepRanked[0][1])) * 100)}%` }} />
                  </div>
                  <span className="text-caption text-text-3 w-8 text-right">{count}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Recent failures */}
        {lastFailures.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">Recent failures</h2>
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Run</th><th>User</th><th>Error</th><th>When</th></tr></thead>
                <tbody>
                  {lastFailures.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono text-caption text-text-3">{r.id.slice(0, 8)}…</td>
                      <td className="text-text-2 text-label">{emailById[r.user_id] ?? r.user_id.slice(0, 10)}</td>
                      <td className="text-red-700 text-label max-w-sm truncate">{r.error_message ?? "—"}</td>
                      <td className="text-text-3 tabular-nums">{timeAgo(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
