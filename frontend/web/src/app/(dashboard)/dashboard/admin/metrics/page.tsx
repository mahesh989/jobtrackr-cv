import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import Link from "next/link";

const HEALTHCARE_SOURCES = new Set([
  "pageup", "elmo", "jobadder", "mercury_roubler", "scout_talent",
  "direct_hospitals", "nsw_health", "vic_health", "qld_health", "sa_health", "wa_health",
]);

function MetricRow({
  index, label, target, value, pass, manual,
}: {
  index: number; label: string; target: string; value: string; pass: boolean | null; manual?: boolean;
}) {
  const status = manual
    ? <span className="badge badge-gray text-[10px]">Manual</span>
    : pass === true  ? <span className="badge badge-green text-[10px]">Pass</span>
    : pass === false ? <span className="badge badge-red text-[10px]">Fail</span>
    : <span className="badge badge-gray text-[10px]">N/A</span>;

  return (
    <tr>
      <td className="text-text-3 w-8">{index}</td>
      <td className="text-text">{label}</td>
      <td className="text-text-2 font-mono whitespace-nowrap">{target}</td>
      <td className="font-mono text-text">{value}</td>
      <td>{status}</td>
    </tr>
  );
}

export default async function MetricsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const admin = createAdminClient();
  // This is an async Server Component — it renders once per request on the
  // server, not repeatedly on the client, so Date.now()'s "unstable across
  // re-renders" concern doesn't apply here. The linter doesn't distinguish
  // server vs. client components for this rule.
  // eslint-disable-next-line react-hooks/purity -- server-rendered once per request, not a re-rendering client component
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const { data: dedupData }  = await admin.from("jobs").select("dedup_status").gte("created_at", thirtyDaysAgo);
  const dedupRows = (dedupData ?? []) as { dedup_status: string }[];
  const dupCount  = dedupRows.filter((r) => r.dedup_status === "duplicate").length;
  const dupRate   = dedupRows.length > 0 ? (dupCount / dedupRows.length) * 100 : null;

  const { data: expiryData } = await admin.from("jobs").select("is_expired, is_dead_link").gte("created_at", thirtyDaysAgo);
  const expiryRows = (expiryData ?? []) as { is_expired: boolean; is_dead_link: boolean }[];
  const badCount   = expiryRows.filter((r) => r.is_expired || r.is_dead_link).length;
  const badRate    = expiryRows.length > 0 ? (badCount / expiryRows.length) * 100 : null;

  const { data: runData } = await admin.from("run_logs").select("status").gte("started_at", thirtyDaysAgo);
  const runRows       = (runData ?? []) as { status: string }[];
  const completedRuns = runRows.filter((r) => r.status === "completed").length;
  const runReliability = runRows.length > 0 ? (completedRuns / runRows.length) * 100 : null;

  const { data: activeUserData } = await admin.from("search_profiles").select("user_id").eq("is_active", true);
  const activeUsers = new Set((activeUserData ?? []).map((r: { user_id: string }) => r.user_id));
  const { data: aiCostData } = await admin.from("run_logs").select("ai_cost_cents").gte("started_at", monthStart.toISOString());
  const totalAiCents = ((aiCostData ?? []) as { ai_cost_cents: number }[]).reduce((s, r) => s + (r.ai_cost_cents ?? 0), 0);
  const infraFixedCents = 50_00;
  const totalCostCents = totalAiCents / 1000 + infraFixedCents;
  const costPerUser = activeUsers.size > 0 ? totalCostCents / activeUsers.size / 100 : null;

  const { data: recentRunData } = await admin.from("run_logs").select("sources_run").gte("started_at", thirtyDaysAgo).eq("status", "completed").order("started_at", { ascending: false }).limit(50);
  const recentRuns = (recentRunData ?? []) as { sources_run: string[] }[];
  const healthcareSourceCounts = recentRuns.map((r) =>
    (r.sources_run ?? []).filter((s) => HEALTHCARE_SOURCES.has(s)).length
  );
  const avgHealthcareSources = healthcareSourceCounts.length > 0
    ? healthcareSourceCounts.reduce((a, b) => a + b, 0) / healthcareSourceCounts.length
    : null;

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <Link href="/dashboard/admin" className="hover:text-text transition-colors">Admin</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Beta metrics</span>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-[16px] font-semibold text-text">Acceptance metrics</h1>
          <span className="text-[11px] text-text-3">
            Last computed: {new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}
          </span>
        </div>
      </div>

      <div className="px-6 py-5 space-y-5">
        <p className="text-[12px] text-text-2 anim-in">
          All 8 metrics must pass simultaneously for 30 consecutive days before beta invites are issued.
        </p>

        <div className="bg-surface border border-border rounded-md overflow-x-auto anim-in anim-delay-1">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>Metric</th>
                <th>Target</th>
                <th>Current (30d)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <MetricRow
                index={1}
                label="Duplicate rate"
                target="< 1%"
                value={dupRate !== null ? `${dupRate.toFixed(1)}%` : "N/A"}
                pass={dupRate !== null ? dupRate < 1 : null}
              />
              <MetricRow
                index={2}
                label="Expired / dead-link listings"
                target="0%"
                value={badRate !== null ? `${badRate.toFixed(1)}%` : "N/A"}
                pass={badRate !== null ? badRate === 0 : null}
              />
              <MetricRow
                index={3}
                label="Scheduled run reliability"
                target="≥ 99%"
                value={runReliability !== null ? `${runReliability.toFixed(1)}% (${runRows.length} runs)` : "N/A"}
                pass={runReliability !== null ? runReliability >= 99 : null}
              />
              <MetricRow
                index={4}
                label="AI relevance accuracy (user-rated)"
                target="≥ 80%"
                value="manual tracking"
                pass={null}
                manual
              />
              <MetricRow
                index={5}
                label="Visa probability plausibility (user-rated)"
                target="≥ 80%"
                value="manual tracking"
                pass={null}
                manual
              />
              <MetricRow
                index={6}
                label="Time saved per user per week"
                target="≥ 3 hours"
                value="manual tracking"
                pass={null}
                manual
              />
              <MetricRow
                index={7}
                label="Infra cost per active user / month"
                target="< $1.00"
                value={costPerUser !== null ? `$${costPerUser.toFixed(3)} (${activeUsers.size} active)` : "N/A"}
                pass={costPerUser !== null ? costPerUser < 1 : null}
              />
              <MetricRow
                index={8}
                label="Healthcare ATS coverage (non-empty sources per run)"
                target="≥ 5 sources"
                value={avgHealthcareSources !== null ? `${avgHealthcareSources.toFixed(1)} avg (${recentRuns.length} runs)` : "N/A — no completed runs yet"}
                pass={avgHealthcareSources !== null ? avgHealthcareSources >= 5 : null}
              />
            </tbody>
          </table>
        </div>

        {/* Manual guidance */}
        <div className="bg-[#FFF8C5] border border-[#9A6700]/20 rounded-md p-4 anim-in anim-delay-2">
          <p className="text-[12px] font-semibold text-[#9A6700] mb-2">Manual metrics guidance</p>
          <ul className="text-[12px] text-text space-y-1.5 list-disc list-inside leading-relaxed">
            <li><span className="font-semibold">#4 Relevance accuracy</span> — Rate a sample of 20 jobs per run. Track in a spreadsheet until rating UI is built.</li>
            <li><span className="font-semibold">#5 Visa plausibility</span> — Does the visa_likelihood score match the actual job description?</li>
            <li><span className="font-semibold">#6 Time saved</span> — Estimate time saved vs. manual searching. Track weekly.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
