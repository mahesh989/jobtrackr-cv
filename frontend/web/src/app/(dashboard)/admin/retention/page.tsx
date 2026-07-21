/**
 * /admin/retention — User retention & engagement
 *
 * Real data: users, analysis_runs, cover_letters, user_events.
 * DAU/WAU/MAU and cohort grid are placeholder — not enough time-series data yet.
 */
import { requireAdmin, timeAgo } from "@/lib/admin/guard";
import Link from "next/link";

export const metadata = { title: "Retention — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function Kpi({ label, value, sub, color = "text-text" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="border border-border bg-surface rounded-md px-4 py-3">
      <p className="text-caption font-medium text-text-3 mb-0.5">{label}</p>
      <p className={`text-h1 font-bold ${color}`}>{value}</p>
      {sub && <p className="text-caption text-text-3 mt-0.5">{sub}</p>}
    </div>
  );
}

export default async function AdminRetentionPage() {
  const { admin } = await requireAdmin();

  const now    = new Date();
  const d7ago  = new Date(now.getTime() - 7  * 86400_000);
  const d30ago = new Date(now.getTime() - 30 * 86400_000);
  const d14ago = new Date(now.getTime() - 14 * 86400_000);

  const [
    { data: allUsersRaw },
    { data: analysisRunsRaw },
    { data: coverLettersRaw },
    { data: cvVersionsRaw },
    { data: voiceProfilesRaw },
    { data: emailIntegrationsRaw },
    { data: appliedJobsRaw },
  ] = await Promise.all([
    admin.from("users").select("id, email, created_at").order("created_at", { ascending: false }),
    admin.from("analysis_runs").select("user_id, status, created_at").gte("created_at", d30ago.toISOString()),
    admin.from("cover_letters").select("user_id, status, created_at").gte("created_at", d30ago.toISOString()).eq("status", "completed"),
    admin.from("cv_versions").select("user_id").eq("is_active", true),
    admin.from("voice_profiles").select("user_id"),
    admin.from("email_integrations").select("user_id"),
    admin.from("jobs").select("user_id: profile_id, applied_at").not("applied_at", "is", null).gte("applied_at", d30ago.toISOString()),
  ]);

  // Optional: user_events for engagement depth
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);
  const recentEvents = await safeQuery(
    admin.from("user_events").select("user_id, event_type, created_at")
      .gte("created_at", d30ago.toISOString())
      .order("created_at", { ascending: false })
  ) as { user_id: string; event_type: string; created_at: string }[];

  type UserRow = { id: string; email: string; created_at: string };
  const allUsers       = (allUsersRaw          ?? []) as UserRow[];
  const analysisRuns   = (analysisRunsRaw       ?? []) as { user_id: string; status: string; created_at: string }[];
  const letters        = (coverLettersRaw       ?? []) as { user_id: string; status: string; created_at: string }[];
  const cvVersions     = (cvVersionsRaw         ?? []) as { user_id: string }[];
  const voiceProfiles  = (voiceProfilesRaw      ?? []) as { user_id: string }[];
  const emailIntgs     = (emailIntegrationsRaw  ?? []) as { user_id: string }[];
  const appliedJobs    = (appliedJobsRaw        ?? []) as { user_id: string; applied_at: string }[];

  const totalUsers = allUsers.length;

  // ── Feature adoption funnel ──────────────────────────────────────────────
  // Tracks the % of all signed-up users who have completed each milestone.
  const usersWithCv        = new Set(cvVersions.map((r) => r.user_id));
  const usersWithVoice     = new Set(voiceProfiles.map((r) => r.user_id));
  const usersWithEmail     = new Set(emailIntgs.map((r) => r.user_id));
  const usersWithRun       = new Set(analysisRuns.map((r) => r.user_id));
  const usersWithLetter    = new Set(letters.map((r) => r.user_id));
  const usersWithApplied   = new Set(appliedJobs.map((r) => r.user_id));

  const funnel = [
    { label: "Signed up",             count: totalUsers,                  desc: "all registered accounts" },
    { label: "Uploaded CV",           count: usersWithCv.size,            desc: "have an active CV version" },
    { label: "Set writing voice",     count: usersWithVoice.size,         desc: "have a voice profile" },
    { label: "Connected email",       count: usersWithEmail.size,         desc: "Gmail or Outlook linked" },
    { label: "Run an analysis (30d)", count: usersWithRun.size,           desc: "at least 1 analysis run" },
    { label: "Got a cover letter (30d)", count: usersWithLetter.size,     desc: "at least 1 completed letter" },
    { label: "Marked applied (30d)",  count: usersWithApplied.size,       desc: "applied to at least 1 job" },
  ];

  // ── Active user tiers ────────────────────────────────────────────────────
  // Derived from analysis_runs + user_events (30d vs 7d window).
  const activeIds30d = new Set([
    ...analysisRuns.map((r) => r.user_id),
    ...recentEvents.map((r) => r.user_id),
  ]);
  const activeIds7d = new Set([
    ...analysisRuns.filter((r) => new Date(r.created_at) >= d7ago).map((r) => r.user_id),
    ...recentEvents.filter((r) => new Date(r.created_at) >= d7ago).map((r) => r.user_id),
  ]);
  const newUsersThisWeek = allUsers.filter((u) => new Date(u.created_at) >= d7ago).length;

  // ── At-risk users ────────────────────────────────────────────────────────
  // Active in 14–30d window, silent in the last 7d.
  const activeIds14to30 = new Set(
    [...analysisRuns, ...recentEvents]
      .filter((r) => {
        const t = new Date(r.created_at);
        return t >= d30ago && t < d14ago;
      })
      .map((r) => r.user_id)
  );
  const atRiskIds = [...activeIds14to30].filter((id) => !activeIds7d.has(id));
  const atRiskUsers = allUsers.filter((u) => atRiskIds.includes(u.id)).slice(0, 10);

  // ── Top engaged users (most events/runs in 30d) ──────────────────────────
  const runCountByUser = analysisRuns.reduce<Record<string, number>>((a, r) => {
    a[r.user_id] = (a[r.user_id] ?? 0) + 1; return a;
  }, {});
  const topUsers = allUsers
    .filter((u) => (runCountByUser[u.id] ?? 0) > 0)
    .sort((a, b) => (runCountByUser[b.id] ?? 0) - (runCountByUser[a.id] ?? 0))
    .slice(0, 8);

  // Signup trend: count by week for last 8 weeks
  const weekBuckets: Record<string, number> = {};
  for (let i = 7; i >= 0; i--) {
    weekBuckets[`W${8 - i}`] = 0;
  }
  let wIdx = 1;
  for (let i = 7; i >= 0; i--) {
    const wStart = new Date(now.getTime() - (i + 1) * 7 * 86400_000);
    const wEnd   = new Date(now.getTime() - i * 7 * 86400_000);
    weekBuckets[`W${wIdx++}`] = allUsers.filter((u) => {
      const t = new Date(u.created_at);
      return t >= wStart && t < wEnd;
    }).length;
  }
  const maxSignups = Math.max(...Object.values(weekBuckets), 1);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-caption text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Retention</span>
        </div>
        <h1 className="text-lead font-semibold text-text">Retention & engagement</h1>
        <p className="text-label text-text-3 mt-0.5">Adoption funnel and churn signals. DAU/WAU/MAU and cohort grid use placeholder values until more data accumulates.</p>
      </div>

      <div className="mx-6 mt-4 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-label text-amber-800">
        <span className="text-base leading-none mt-0.5">⚠</span>
        <span><span className="font-semibold">Partial data</span> — DAU/WAU/MAU and cohort grid are not yet wired. More time-series data needed.</span>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {/* Active users */}
        <section>
          <h2 className="text-caption font-semibold text-text-3 uppercase tracking-widest mb-3">Active users</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="New this week" value={String(newUsersThisWeek)} sub="signups" />
          </div>
        </section>

        {/* Real: active by window */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Kpi label="Active (30d)" value={String(activeIds30d.size)} sub="ran analysis or triggered event" color="text-emerald-700" />
          <Kpi label="Active (7d)"  value={String(activeIds7d.size)}  sub="ran analysis or triggered event" />
          <Kpi label="At risk"      value={String(atRiskIds.length)}  sub="active 14–30d ago, quiet since" color={atRiskIds.length > 3 ? "text-amber-700" : "text-text"} />
        </div>

        {/* Feature adoption funnel */}
        <section>
          <h2 className="text-label font-semibold text-text mb-3">Feature adoption funnel</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-3">
            {funnel.map(({ label, count, desc }, idx) => {
              const pct = totalUsers > 0 ? (count / totalUsers) * 100 : 0;
              const isFirst = idx === 0;
              return (
                <div key={label}>
                  <div className="flex items-center gap-3">
                    <span className="text-label text-text-2 w-52 truncate">{label}</span>
                    <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${isFirst ? "bg-blue-500" : pct >= 60 ? "bg-emerald-500" : pct >= 30 ? "bg-amber-400" : "bg-red-400"}`}
                        style={{ width: `${Math.max(pct > 0 ? 1 : 0, pct)}%` }}
                      />
                    </div>
                    <span className="text-caption font-mono text-text-2 w-24 text-right tabular-nums">
                      {count} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <p className="text-micro text-text-3 ml-[224px] mt-0.5">{desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Cohort retention — not yet wired */}
        <section>
          <h2 className="text-label font-semibold text-text mb-3">Cohort retention</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-8 text-center text-label text-text-3">
            Not yet wired — needs more months of user data.
          </div>
        </section>

        {/* Signup trend */}
        <section>
          <h2 className="text-label font-semibold text-text mb-3">Signup trend — last 8 weeks</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-1.5">
            {Object.entries(weekBuckets).map(([week, count]) => (
              <div key={week} className="flex items-center gap-3">
                <span className="text-caption text-text-3 w-8">{week}</span>
                <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full"
                    style={{ width: count > 0 ? `${Math.max(2, (count / maxSignups) * 100)}%` : "0%" }}
                  />
                </div>
                <span className="text-caption font-mono text-text-2 w-6 text-right">{count}</span>
              </div>
            ))}
          </div>
        </section>

        {/* At-risk users */}
        {atRiskUsers.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">
              At-risk users <span className="text-text-3 font-normal">(active 14–30d ago, silent since)</span>
            </h2>
            <div className="bg-surface border border-amber-200 rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>User</th><th>Analyses (30d)</th><th>Last run</th></tr></thead>
                <tbody>
                  {atRiskUsers.map((u) => {
                    const lastRun = analysisRuns.filter((r) => r.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
                    return (
                      <tr key={u.id}>
                        <td>
                          <Link href={`/admin/activity?user=${u.id}`} className="text-text font-medium hover:underline">
                            {u.email}
                          </Link>
                        </td>
                        <td className="tabular-nums text-text-2">{runCountByUser[u.id] ?? 0}</td>
                        <td className="text-text-3">{lastRun ? timeAgo(lastRun.created_at) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Most engaged users */}
        {topUsers.length > 0 && (
          <section>
            <h2 className="text-label font-semibold text-text mb-3">Most engaged (by analysis runs, 30d)</h2>
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>User</th><th>Analyses</th><th>Cover letters</th><th>Applied</th><th>Joined</th></tr></thead>
                <tbody>
                  {topUsers.map((u) => {
                    const letterCount  = letters.filter((l) => l.user_id === u.id).length;
                    const appliedCount = appliedJobs.filter((j) => j.user_id === u.id).length;
                    return (
                      <tr key={u.id}>
                        <td>
                          <Link href={`/admin/activity?user=${u.id}`} className="text-text font-medium hover:underline">{u.email}</Link>
                        </td>
                        <td className="tabular-nums text-emerald-700 font-semibold">{runCountByUser[u.id] ?? 0}</td>
                        <td className="tabular-nums text-text-2">{letterCount}</td>
                        <td className="tabular-nums text-text-2">{appliedCount}</td>
                        <td className="text-text-3">{new Date(u.created_at).toLocaleDateString("en-AU")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
