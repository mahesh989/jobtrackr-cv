/**
 * /dashboard/admin — Operator Overview
 *
 * The morning dashboard. One screen that answers:
 *   "Is anything broken and is the business healthy?"
 *
 * Sections:
 *   1. Golden signals — error rate, p95 latency, today's AI cost, active users
 *   2. Users summary — total, active 7d, plan breakdown
 *   3. Pipeline health — last 24h run success rate + recent failures
 *   4. Recent user events — live activity feed
 *   5. Invite codes — manage (existing)
 */
import { requireAdmin, formatCost, timeAgo } from "@/lib/admin/guard";
import Link from "next/link";
import { generateInviteCode, revokeInviteCode } from "@/lib/actions";

export const metadata = { title: "Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function StatCard({ label, value, sub, href, color = "blue" }: {
  label: string; value: string; sub?: string;
  href?: string; color?: "blue"|"green"|"amber"|"red"|"purple"|"slate";
}) {
  const colors = {
    blue:   "border-blue-200 bg-blue-50",
    green:  "border-emerald-200 bg-emerald-50",
    amber:  "border-amber-200 bg-amber-50",
    red:    "border-red-200 bg-red-50",
    purple: "border-purple-200 bg-purple-50",
    slate:  "border-border bg-surface",
  };
  const textColors = {
    blue: "text-blue-700", green: "text-emerald-700", amber: "text-amber-700",
    red: "text-red-700", purple: "text-purple-700", slate: "text-text",
  };
  const inner = (
    <div className={`rounded-md border px-4 py-3 ${colors[color]}`}>
      <p className="text-[11px] font-medium text-text-3 mb-0.5">{label}</p>
      <p className={`text-[22px] font-bold ${textColors[color]}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-3 mt-0.5">{sub}</p>}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default async function AdminOverviewPage() {
  const { admin } = await requireAdmin();

  const now        = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const d7ago      = new Date(now.getTime() - 7 * 86400_000);
  const d30ago     = new Date(now.getTime() - 30 * 86400_000);
  const h24ago     = new Date(now.getTime() - 86400_000);

  // Core queries — always exist
  const [
    { data: allUsers },
    { data: activeProfiles },
    { data: last24hRuns },
    { data: recentFailures },
    { data: inviteRows },
    { data: profileRows },
    { data: subsRaw },
    { data: plansRaw },
    { data: firstCompletedRuns },
  ] = await Promise.all([
    admin.from("users").select("id, email, role, created_at").order("created_at", { ascending: false }),
    admin.from("search_profiles").select("user_id").eq("is_active", true),
    admin.from("analysis_runs")
      .select("id, status, user_id, created_at, error_message")
      .gte("created_at", h24ago.toISOString())
      .order("created_at", { ascending: false }),
    admin.from("analysis_runs")
      .select("id, status, user_id, error_message, created_at")
      .eq("status", "failed")
      .gte("created_at", d7ago.toISOString())
      .order("created_at", { ascending: false })
      .limit(8),
    admin.from("invite_codes")
      .select("code, created_by, used_by, used_at, is_active, created_at")
      .order("created_at", { ascending: false }),
    admin.from("search_profiles").select("id, user_id, name, is_active"),
    admin.from("subscriptions").select("user_id, plan_id, status"),
    admin.from("plans").select("id, price_cents, billing_interval"),
    // For TTV: earliest completed run per user (completed_at asc)
    admin.from("analysis_runs")
      .select("user_id, completed_at")
      .eq("status", "completed")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: true }),
  ]);

  // Optional observability tables — only exist after migration 055 is applied.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);
  const [todayCostRows, recentEvents] = await Promise.all([
    safeQuery(admin.from("ai_calls")
      .select("cost_millicents, latency_ms, status")
      .gte("created_at", todayStart.toISOString())),
    safeQuery(admin.from("user_events")
      .select("user_id, event_type, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(20)),
  ]);

  type UserRow      = { id: string; email: string; role: string; created_at: string };
  type RunRow       = { id: string; status: string; user_id: string; error_message: string | null; created_at: string };
  type EventRow     = { user_id: string; event_type: string; metadata: Record<string, unknown>; created_at: string };
  type InviteRow    = { code: string; created_by: string | null; used_by: string | null; used_at: string | null; is_active: boolean; created_at: string };
  type CostRow      = { cost_millicents: number; latency_ms: number; status: string };
  type FirstRunRow  = { user_id: string; completed_at: string };

  const users    = (allUsers       ?? []) as UserRow[];
  const runs24h  = (last24hRuns    ?? []) as RunRow[];
  const failures = (recentFailures ?? []) as RunRow[];
  const events   = recentEvents  as EventRow[];
  const invites  = (inviteRows   ?? []) as InviteRow[];
  const profiles = (profileRows  ?? []) as { id: string; user_id: string; name: string; is_active: boolean }[];
  const costRows = todayCostRows as CostRow[];

  type SubRow  = { user_id: string; plan_id: string; status: string };
  type PlanRow = { id: string; price_cents: number; billing_interval: string | null };
  const subs  = (subsRaw  ?? []) as SubRow[];
  const plans = (plansRaw ?? []) as PlanRow[];
  const planById = plans.reduce<Record<string, PlanRow>>((a, p) => { a[p.id] = p; return a; }, {});
  const activeSubs = subs.filter((s) => s.status === "active");
  const mrrCents = activeSubs.reduce((sum, s) => {
    const p = planById[s.plan_id];
    if (!p || !p.price_cents) return sum;
    const monthly = p.billing_interval === "week" ? Math.round(p.price_cents * 4.33) : p.price_cents;
    return sum + monthly;
  }, 0);

  const userEmailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});
  const activeUserIds = new Set((activeProfiles ?? []).map((r: { user_id: string }) => r.user_id));
  const users7d       = users.filter((u) => new Date(u.created_at) >= d7ago).length;
  const users30d      = users.filter((u) => new Date(u.created_at) >= d30ago).length;
  const completedRuns = runs24h.filter((r) => r.status === "completed").length;
  const failedRuns    = runs24h.filter((r) => r.status === "failed").length;
  const successRate   = runs24h.length > 0 ? Math.round((completedRuns / runs24h.length) * 100) : null;
  const todayCost     = costRows.reduce((s, r) => s + (r.cost_millicents ?? 0), 0);
  const errorCalls    = costRows.filter((r) => r.status === "error").length;
  const errorRate     = costRows.length > 0 ? ((errorCalls / costRows.length) * 100).toFixed(1) : null;
  const latencies     = costRows.filter((r) => r.latency_ms > 0).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p95Latency    = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;
  const profilesByUser = profiles.reduce<Record<string, typeof profiles>>((a, p) => { (a[p.user_id] ??= []).push(p); return a; }, {});

  // Time-to-first-value: median hours from signup → first completed analysis
  const firstRuns = (firstCompletedRuns ?? []) as FirstRunRow[];
  const firstRunByUser = firstRuns.reduce<Record<string, string>>((a, r) => {
    if (!a[r.user_id]) a[r.user_id] = r.completed_at;
    return a;
  }, {});
  const userById = users.reduce<Record<string, UserRow>>((a, u) => { a[u.id] = u; return a; }, {});
  const ttvHours = Object.entries(firstRunByUser)
    .map(([uid, completedAt]) => {
      const u = userById[uid];
      if (!u) return null;
      const h = (new Date(completedAt).getTime() - new Date(u.created_at).getTime()) / 3_600_000;
      return h >= 0 && h < 30 * 24 ? h : null;
    })
    .filter((h): h is number => h !== null);
  const medianTTV = ttvHours.length > 0
    ? [...ttvHours].sort((a, b) => a - b)[Math.floor(ttvHours.length / 2)]
    : null;
  const ttvLabel = medianTTV === null ? "—"
    : medianTTV < 1 ? `${Math.round(medianTTV * 60)}m`
    : `${medianTTV.toFixed(1)}h`;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] text-text-3 mb-0.5">Admin</p>
            <h1 className="text-[16px] font-semibold text-text">Overview</h1>
          </div>
          <span className="text-[11px] text-text-3">
            {now.toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" })} AEST
          </span>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-6xl">

        {/* Golden signals */}
        <section>
          <h2 className="text-[11px] font-semibold text-text-3 uppercase tracking-widest mb-3">Golden signals</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Today's AI cost" value={formatCost(todayCost)}
              sub={`${costRows.length} calls`} href="/dashboard/admin/ai-costs"
              color={todayCost > 5_000_000 ? "amber" : "blue"} />
            <StatCard label="AI error rate (today)"
              value={errorRate !== null ? `${errorRate}%` : "—"}
              sub={errorCalls > 0 ? `${errorCalls} errors` : "All clear"}
              href="/dashboard/admin/pipeline" color={errorCalls > 3 ? "red" : "green"} />
            <StatCard label="p95 latency (today)"
              value={p95Latency !== null ? `${(p95Latency / 1000).toFixed(1)}s` : "—"}
              sub="per AI call" href="/dashboard/admin/pipeline"
              color={p95Latency !== null && p95Latency > 20_000 ? "amber" : "slate"} />
            <StatCard label="24h run success"
              value={successRate !== null ? `${successRate}%` : "—"}
              sub={`${completedRuns}✓  ${failedRuns}✗  of ${runs24h.length}`}
              href="/dashboard/admin/pipeline"
              color={failedRuns > 2 ? "red" : successRate !== null && successRate >= 95 ? "green" : "amber"} />
          </div>
        </section>

        {/* Business signals */}
        <section>
          <h2 className="text-[11px] font-semibold text-text-3 uppercase tracking-widest mb-3">Business signals</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="MRR" href="/dashboard/admin/revenue"
              value={mrrCents > 0 ? `$${(mrrCents / 100).toFixed(0)}` : "$0"}
              sub={`${activeSubs.length} active subscribers`}
              color={mrrCents > 0 ? "green" : "slate"} />
            <StatCard label="Trialing"
              value={String(subs.filter((s) => s.status === "trialing").length)}
              sub="on free trial" href="/dashboard/admin/revenue" color="amber" />
            <StatCard label="Past due"
              value={String(subs.filter((s) => s.status === "past_due").length)}
              sub="payment failing" href="/dashboard/admin/revenue"
              color={subs.some((s) => s.status === "past_due") ? "red" : "slate"} />
            <StatCard label="Time to first value" href="/dashboard/admin/retention"
              value={ttvLabel}
              sub={ttvHours.length > 0 ? `median across ${ttvHours.length} users` : "no completed analyses yet"}
              color={medianTTV !== null && medianTTV < 2 ? "green" : medianTTV !== null && medianTTV > 24 ? "amber" : "slate"} />
          </div>
        </section>

        {/* Users */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold text-text-3 uppercase tracking-widest">Users</h2>
            <Link href="/dashboard/admin/users" className="text-[12px] text-blue-600 hover:underline">View all →</Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard label="Total"     value={String(users.length)}       sub={`+${users7d} this week`} color="slate" />
            <StatCard label="New (30d)" value={String(users30d)}           sub="signups"                color="slate" />
            <StatCard label="Active"    value={String(activeUserIds.size)} sub="have active profile"    color="slate" />
            <StatCard label="Admin/founder"
              value={String(users.filter((u) => ["founder","admin"].includes(u.role)).length)}
              color="purple" />
          </div>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Email</th><th>Role</th><th>Profiles</th><th>Joined</th></tr></thead>
              <tbody>
                {users.slice(0, 6).map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium text-text">
                      <Link href={`/dashboard/admin/users/${u.id}`} className="hover:underline">{u.email}</Link>
                    </td>
                    <td>
                      <span className={`badge text-[10px] ${u.role === "founder" ? "badge-amber" : u.role === "admin" ? "badge-purple" : "badge-gray"}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="text-text-2">{(profilesByUser[u.id] ?? []).length}</td>
                    <td className="text-text-3">{new Date(u.created_at).toLocaleDateString("en-AU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent failures */}
        {failures.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-semibold text-red-600 uppercase tracking-widest">Recent failures (7d)</h2>
              <Link href="/dashboard/admin/pipeline" className="text-[12px] text-blue-600 hover:underline">Pipeline →</Link>
            </div>
            <div className="bg-surface border border-red-200 rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Run</th><th>User</th><th>Error</th><th>When</th></tr></thead>
                <tbody>
                  {failures.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono text-[11px] text-text-3">{r.id.slice(0, 8)}…</td>
                      <td className="text-text-2">{userEmailById[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                      <td className="text-red-700 text-[12px] max-w-xs truncate">{r.error_message ?? "—"}</td>
                      <td className="text-text-3">{timeAgo(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Activity feed */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold text-text-3 uppercase tracking-widest">Recent activity</h2>
            <Link href="/dashboard/admin/activity" className="text-[12px] text-blue-600 hover:underline">Full feed →</Link>
          </div>
          {events.length === 0 ? (
            <p className="text-[12px] text-text-3 bg-surface border border-border rounded-md px-4 py-6 text-center">
              No activity events yet — they populate as users interact with the app.
            </p>
          ) : (
            <div className="bg-surface border border-border rounded-md divide-y divide-border">
              {events.map((e, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2">
                  <span className="text-[11px] text-text-3 tabular-nums shrink-0 w-20 mt-0.5">{timeAgo(e.created_at)}</span>
                  <span className="text-[12px] font-medium text-blue-700 shrink-0 truncate max-w-[160px]">{userEmailById[e.user_id] ?? e.user_id.slice(0, 8)}</span>
                  <span className="text-[12px] text-text">{e.event_type.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Invite codes */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-text">
              Invite codes <span className="text-text-2 font-normal">({invites.length})</span>
            </h2>
            <form action={generateInviteCode}>
              <button type="submit" className="gh-btn gh-btn-blue text-[12px] px-3 py-1">+ Generate</button>
            </form>
          </div>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Code</th><th>Status</th><th>Used by</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {invites.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-text-3 py-6">No codes yet</td></tr>
                )}
                {invites.map((inv) => (
                  <tr key={inv.code}>
                    <td className="font-mono text-[13px] text-text">{inv.code}</td>
                    <td>
                      <span className={`badge text-[10px] ${!inv.is_active ? "badge-gray" : inv.used_by ? "badge-gray" : "badge-green"}`}>
                        {!inv.is_active ? "revoked" : inv.used_by ? "used" : "available"}
                      </span>
                    </td>
                    <td className="text-text-2">{inv.used_by ? (userEmailById[inv.used_by] ?? inv.used_by.slice(0, 8) + "…") : "—"}</td>
                    <td className="text-text-3">{new Date(inv.created_at).toLocaleDateString("en-AU")}</td>
                    <td>
                      {inv.is_active && !inv.used_by && (
                        <form action={revokeInviteCode.bind(null, inv.code)}>
                          <button type="submit" className="text-[11px] text-red-600 hover:underline font-medium">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
