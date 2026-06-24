/**
 * /dashboard/admin/quality — Product quality observatory
 *
 * Answers:
 *   - Is CV tailoring actually adding value? (ATS score distributions)
 *   - Which role families produce the best/worst uplift?
 *   - Are cover letters completing reliably?
 *   - Structural validation failure rate (KFC struct fail class)
 *   - Honesty gate trip rate
 *   - Gate pass/fail funnel: initial ATS → final ATS → cover letter
 *
 * This is the "is the product working?" lens, separate from the
 * "is the infrastructure working?" lens in pipeline health.
 */
import { requireAdmin } from "@/lib/admin/guard";
import Link from "next/link";

export const metadata = { title: "Quality — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-text-3">—</span>;
  const color =
    score >= 80 ? "text-emerald-700 bg-emerald-50" :
    score >= 70 ? "text-amber-700 bg-amber-50" :
    score >= 60 ? "text-blue-700 bg-blue-50" :
    "text-red-700 bg-red-50";
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${color}`}>{score}</span>;
}

export default async function AdminQualityPage() {
  const { admin } = await requireAdmin();

  const now    = new Date();
  const d30ago = new Date(now.getTime() - 30 * 86400_000);

  const [
    { data: runsRaw },
    { data: lettersRaw },
  ] = await Promise.all([
    admin.from("analysis_runs")
      .select("id, user_id, status, match_score, tailored_match_score, ats_lift, jd_analysis_result, tailored_ats_scoring_result, created_at")
      .eq("status", "completed")
      .gte("created_at", d30ago.toISOString())
      .order("created_at", { ascending: false }),
    admin.from("cover_letters")
      .select("status, created_at")
      .gte("created_at", d30ago.toISOString()),
  ]);

  type RunRow = {
    id: string; user_id: string; status: string;
    match_score: number | null; tailored_match_score: number | null; ats_lift: number | null;
    jd_analysis_result: Record<string, unknown> | null;
    tailored_ats_scoring_result: Record<string, unknown> | null;
    created_at: string;
  };
  type LetterRow = { status: string; created_at: string };

  const runs    = (runsRaw    ?? []) as RunRow[];
  const letters = (lettersRaw ?? []) as LetterRow[];

  // Gate funnel (all analysis_runs in period including failed)
  const { data: allRunsData } = await admin.from("analysis_runs")
    .select("status, match_score, tailored_match_score")
    .gte("created_at", d30ago.toISOString());
  type GateRow = { status: string; match_score: number | null; tailored_match_score: number | null };
  const allRuns = (allRunsData ?? []) as GateRow[];

  const totalStarted   = allRuns.length;
  const passedInitial  = allRuns.filter((r) => r.match_score != null && r.match_score >= 60).length;
  const passedFinal    = allRuns.filter((r) => r.tailored_match_score != null && r.tailored_match_score >= 70).length;
  const hasLetter      = letters.filter((l) => l.status === "completed").length;

  // ATS score distributions
  const withScores = runs.filter((r) => r.tailored_match_score != null);
  const scoreRanges = { "< 50": 0, "50–59": 0, "60–69": 0, "70–79": 0, "80–89": 0, "90+": 0 };
  withScores.forEach((r) => {
    const s = r.tailored_match_score!;
    if (s < 50)       scoreRanges["< 50"]++;
    else if (s < 60)  scoreRanges["50–59"]++;
    else if (s < 70)  scoreRanges["60–69"]++;
    else if (s < 80)  scoreRanges["70–79"]++;
    else if (s < 90)  scoreRanges["80–89"]++;
    else              scoreRanges["90+"]++;
  });
  const maxScoreCount = Math.max(...Object.values(scoreRanges), 1);

  // Role-family breakdown
  const byFamily: Record<string, { count: number; totalLift: number; totalScore: number }> = {};
  runs.forEach((r) => {
    const family = (r.jd_analysis_result as { role_family?: string } | null)?.role_family ?? "unknown";
    if (!byFamily[family]) byFamily[family] = { count: 0, totalLift: 0, totalScore: 0 };
    byFamily[family].count++;
    byFamily[family].totalLift  += r.ats_lift ?? 0;
    byFamily[family].totalScore += r.tailored_match_score ?? 0;
  });
  const familyRanked = Object.entries(byFamily)
    .map(([f, d]) => ({ family: f, count: d.count, avgLift: d.totalLift / d.count, avgScore: d.totalScore / d.count }))
    .sort((a, b) => b.count - a.count);

  // Structural validation stats
  const withStruct = runs.filter((r) => {
    const rep = (r.tailored_ats_scoring_result as { structural_report?: { summary?: { fail?: number } } } | null);
    return rep?.structural_report != null;
  });
  const structFails = withStruct.filter((r) => {
    const rep = (r.tailored_ats_scoring_result as { structural_report?: { summary?: { fail?: number } } } | null);
    return (rep?.structural_report?.summary?.fail ?? 0) > 0;
  }).length;
  const structFailRate = withStruct.length > 0 ? (structFails / withStruct.length) * 100 : null;

  // Cover letter completion
  const totalLetters     = letters.length;
  const completedLetters = letters.filter((l) => l.status === "completed").length;
  const failedLetters    = letters.filter((l) => l.status === "failed").length;
  const letterSuccessRate = totalLetters > 0 ? (completedLetters / totalLetters) * 100 : null;

  // Average scores
  const avgInitial  = runs.length > 0 ? runs.reduce((s, r) => s + (r.match_score ?? 0), 0) / runs.filter((r) => r.match_score != null).length : null;
  const avgTailored = withScores.length > 0 ? withScores.reduce((s, r) => s + r.tailored_match_score!, 0) / withScores.length : null;
  const avgLift     = runs.filter((r) => r.ats_lift != null).length > 0
    ? runs.reduce((s, r) => s + (r.ats_lift ?? 0), 0) / runs.filter((r) => r.ats_lift != null).length : null;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Quality</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Product quality <span className="text-[13px] font-normal text-text-3 ml-1">(30d, completed runs)</span></h1>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {runs.length === 0 && (
          <p className="text-[12px] text-text-3 bg-surface border border-border rounded-md px-4 py-6 text-center">
            No completed runs in the last 30 days yet.
          </p>
        )}

        {/* Score KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Avg initial ATS",  value: avgInitial  !== null ? avgInitial.toFixed(1)  : "—" },
            { label: "Avg tailored ATS", value: avgTailored !== null ? avgTailored.toFixed(1) : "—", color: "text-emerald-700" },
            { label: "Avg ATS lift",     value: avgLift     !== null ? `+${avgLift.toFixed(1)}` : "—", color: "text-emerald-700" },
            { label: "Runs scored",      value: String(withScores.length) },
          ].map((s) => (
            <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
              <p className="text-[11px] text-text-3 mb-0.5">{s.label}</p>
              <p className={`text-[20px] font-bold ${(s as { color?: string }).color ?? "text-text"}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Gate funnel */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Gate funnel</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-3">
            {[
              { label: "Runs started",      count: totalStarted,  pct: 100 },
              { label: "Passed initial (≥60)", count: passedInitial, pct: totalStarted > 0 ? (passedInitial / totalStarted) * 100 : 0 },
              { label: "Passed final (≥70)", count: passedFinal,   pct: totalStarted > 0 ? (passedFinal / totalStarted) * 100 : 0 },
              { label: "Cover letter generated", count: hasLetter, pct: totalStarted > 0 ? (hasLetter / totalStarted) * 100 : 0 },
            ].map(({ label, count, pct }) => (
              <div key={label} className="flex items-center gap-3">
                <span className="text-[12px] text-text-2 w-52">{label}</span>
                <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                  <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[11px] font-mono text-text-2 w-24 text-right">{count} ({pct.toFixed(0)}%)</span>
              </div>
            ))}
          </div>
        </section>

        {/* Score distribution */}
        {withScores.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Tailored ATS score distribution</h2>
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
              {(Object.entries(scoreRanges) as [string, number][]).map(([range, count]) => {
                const pct = withScores.length > 0 ? (count / withScores.length) * 100 : 0;
                const isAboveGate = range === "70–79" || range === "80–89" || range === "90+";
                return (
                  <div key={range} className="flex items-center gap-3">
                    <span className={`text-[12px] w-16 ${isAboveGate ? "text-emerald-700 font-medium" : "text-text-3"}`}>{range}</span>
                    <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${isAboveGate ? "bg-emerald-500" : count === maxScoreCount ? "bg-amber-400" : "bg-slate-400"}`}
                        style={{ width: `${(count / maxScoreCount) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-text-3 w-20 text-right">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Role-family breakdown */}
        {familyRanked.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Quality by role family</h2>
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Role family</th><th>Runs</th><th>Avg tailored score</th><th>Avg lift</th></tr></thead>
                <tbody>
                  {familyRanked.map(({ family, count, avgLift: al, avgScore: as_ }) => (
                    <tr key={family}>
                      <td className="font-medium text-text">{family}</td>
                      <td className="tabular-nums">{count}</td>
                      <td><ScoreBadge score={Math.round(as_)} /></td>
                      <td className={`tabular-nums font-medium ${al > 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {al > 0 ? "+" : ""}{al.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Cover letter reliability */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Cover letter reliability (30d)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Generated",  value: String(totalLetters) },
              { label: "Completed",  value: String(completedLetters), color: "text-emerald-700" },
              { label: "Failed",     value: String(failedLetters),    color: failedLetters > 0 ? "text-red-700" : "text-text-3" },
              { label: "Success rate", value: letterSuccessRate !== null ? `${letterSuccessRate.toFixed(0)}%` : "—",
                color: letterSuccessRate !== null && letterSuccessRate < 90 ? "text-amber-700" : "text-emerald-700" },
            ].map((s) => (
              <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-[11px] text-text-3 mb-0.5">{s.label}</p>
                <p className={`text-[20px] font-bold ${(s as { color?: string }).color ?? "text-text"}`}>{s.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Structural validation */}
        {withStruct.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-text mb-3">Structural validation (30d)</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-[11px] text-text-3 mb-0.5">Runs with report</p>
                <p className="text-[20px] font-bold text-text">{withStruct.length}</p>
              </div>
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-[11px] text-text-3 mb-0.5">Struct fail rate</p>
                <p className={`text-[20px] font-bold ${structFailRate !== null && structFailRate > 10 ? "text-amber-700" : "text-emerald-700"}`}>
                  {structFailRate !== null ? `${structFailRate.toFixed(1)}%` : "—"}
                </p>
              </div>
              <div className="border border-border bg-surface rounded-md px-4 py-3">
                <p className="text-[11px] text-text-3 mb-0.5">Struct fails (count)</p>
                <p className={`text-[20px] font-bold ${structFails > 0 ? "text-amber-700" : "text-emerald-700"}`}>{structFails}</p>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
