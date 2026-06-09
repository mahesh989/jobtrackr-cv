/**
 * /dashboard/admin/users — User management + activity drill-down
 *
 * Table of all users with:
 *   - Email, role, plan, joined date, last active
 *   - Profile count, total runs, total cover letters, total applications sent
 *   - MTD AI cost attributed to this user
 *   - Link to view their jobs / runs
 *
 * Clicking a row expands it inline to show:
 *   - All their profiles + last run status
 *   - Recent analysis runs (last 5)
 *   - Recent user_events (last 10 actions)
 */
import { requireAdmin, formatCost, timeAgo } from "@/lib/admin/guard";
import Link from "next/link";

export const metadata = { title: "Users — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

export default async function AdminUsersPage() {
  const { admin } = await requireAdmin();

  const now        = new Date();
  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const d30ago     = new Date(now.getTime() - 30 * 86400_000);

  // Core queries — always exist
  const [
    { data: allUsers },
    { data: allProfiles },
    { data: allRunLogs },
    { data: allAnalysisRuns },
    { data: allLetters },
    { data: allSubs },
  ] = await Promise.all([
    admin.from("users").select("id, email, role, created_at").order("created_at", { ascending: false }),
    admin.from("search_profiles").select("id, user_id, name, is_active, schedule_cron"),
    admin.from("run_logs").select("profile_id, status, started_at, jobs_saved")
      .gte("started_at", d30ago.toISOString())
      .order("started_at", { ascending: false }),
    admin.from("analysis_runs").select("id, user_id, status, created_at, tailored_match_score")
      .gte("created_at", d30ago.toISOString())
      .order("created_at", { ascending: false }),
    admin.from("cover_letters").select("user_id, status, created_at")
      .gte("created_at", d30ago.toISOString()),
    admin.from("subscriptions").select("user_id, plan_id, status, current_period_end, trial_end"),
  ]);

  // Optional observability tables — only exist after migration 055 is applied.
  // Gracefully fall back to empty arrays so the page renders even before the migration.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);
  const [allAiCosts, recentEvents] = await Promise.all([
    safeQuery(admin.from("ai_calls").select("user_id, cost_millicents, created_at")
      .gte("created_at", monthStart.toISOString())),
    safeQuery(admin.from("user_events").select("user_id, event_type, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(200)),
  ]);

  type UserRow     = { id: string; email: string; role: string; created_at: string };
  type ProfileRow  = { id: string; user_id: string; name: string; is_active: boolean; schedule_cron: string | null };
  type RunLogRow   = { profile_id: string; status: string; started_at: string; jobs_saved: number };
  type ARunRow     = { id: string; user_id: string; status: string; created_at: string; tailored_match_score: number | null };
  type LetterRow   = { user_id: string; status: string; created_at: string };
  type SubRow      = { user_id: string; plan_id: string; status: string; current_period_end: string | null; trial_end: string | null };
  type AiCostRow   = { user_id: string; cost_millicents: number; created_at: string };
  type EventRow    = { user_id: string; event_type: string; metadata: Record<string, unknown>; created_at: string };

  const users    = (allUsers       ?? []) as UserRow[];
  const profiles = (allProfiles    ?? []) as ProfileRow[];
  const runLogs  = (allRunLogs     ?? []) as RunLogRow[];
  const aRuns    = (allAnalysisRuns ?? []) as ARunRow[];
  const letters  = (allLetters     ?? []) as LetterRow[];
  const subs     = (allSubs        ?? []) as SubRow[];
  const aiCosts  = allAiCosts  as AiCostRow[];
  const events   = recentEvents as EventRow[];

  // Index everything by user_id or profile_id
  const profilesByUser = profiles.reduce<Record<string, ProfileRow[]>>((a, p) => { (a[p.user_id] ??= []).push(p); return a; }, {});
  const runLogsByProfile = runLogs.reduce<Record<string, RunLogRow[]>>((a, r) => { (a[r.profile_id] ??= []).push(r); return a; }, {});
  const aRunsByUser      = aRuns.reduce<Record<string, ARunRow[]>>((a, r) => { (a[r.user_id] ??= []).push(r); return a; }, {});
  const lettersByUser    = letters.reduce<Record<string, LetterRow[]>>((a, r) => { (a[r.user_id] ??= []).push(r); return a; }, {});
  const subByUser        = subs.reduce<Record<string, SubRow>>((a, s) => { a[s.user_id] = s; return a; }, {});
  const costByUser       = aiCosts.reduce<Record<string, number>>((a, c) => {
    a[c.user_id] = (a[c.user_id] ?? 0) + (c.cost_millicents ?? 0); return a;
  }, {});
  const eventsByUser     = events.reduce<Record<string, EventRow[]>>((a, e) => { (a[e.user_id] ??= []).push(e); return a; }, {});

  // Last active = most recent analysis_run OR user_event
  function lastActive(userId: string): string | null {
    const lastRun = (aRunsByUser[userId] ?? [])[0]?.created_at ?? null;
    const lastEvt = (eventsByUser[userId] ?? [])[0]?.created_at ?? null;
    if (!lastRun && !lastEvt) return null;
    if (!lastRun) return lastEvt;
    if (!lastEvt) return lastRun;
    return lastRun > lastEvt ? lastRun : lastEvt;
  }

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Users</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Users
          <span className="text-[13px] font-normal text-text-3 ml-2">({users.length} total)</span>
        </h1>
      </div>

      <div className="px-6 py-5 max-w-7xl">
        <div className="bg-surface border border-border rounded-md overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Plan</th>
                <th>Profiles</th>
                <th>Analyses (30d)</th>
                <th>Letters (30d)</th>
                <th>AI cost (mo)</th>
                <th>Last active</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const userProfiles = profilesByUser[u.id] ?? [];
                const userRuns     = aRunsByUser[u.id] ?? [];
                const userLetters  = lettersByUser[u.id] ?? [];
                const sub          = subByUser[u.id];
                const cost         = costByUser[u.id] ?? 0;
                const la           = lastActive(u.id);

                // compute last run status across all profiles
                const profileIds = userProfiles.map((p) => p.id);
                const latestRunLog = profileIds
                  .flatMap((pid) => runLogsByProfile[pid] ?? [])
                  .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];

                return (
                  <tr key={u.id} className="group">
                    <td className="font-medium text-text">
                      <Link href={`/dashboard/admin/activity?user=${u.id}`} className="hover:underline">
                        {u.email}
                      </Link>
                      {latestRunLog && (
                        <span className={`ml-2 text-[10px] font-medium ${
                          latestRunLog.status === "completed" ? "text-emerald-600"
                          : latestRunLog.status === "failed" ? "text-red-600"
                          : "text-amber-600"
                        }`}>
                          {latestRunLog.status === "running" ? "⟳ running" : latestRunLog.status}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge text-[10px] ${
                        u.role === "founder" ? "badge-amber"
                        : u.role === "admin" ? "badge-purple"
                        : "badge-gray"
                      }`}>{u.role}</span>
                    </td>
                    <td>
                      {sub ? (
                        <span className={`badge text-[10px] ${
                          sub.status === "active"   ? "badge-green"
                          : sub.status === "trialing" ? "badge-amber"
                          : "badge-gray"
                        }`}>{sub.plan_id}</span>
                      ) : (
                        <span className="text-text-3 text-[11px]">—</span>
                      )}
                    </td>
                    <td className="text-text-2 tabular-nums">{userProfiles.length}</td>
                    <td className="text-text-2 tabular-nums">{userRuns.length}</td>
                    <td className="text-text-2 tabular-nums">{userLetters.filter((l) => l.status === "completed").length}</td>
                    <td className="text-text-2 tabular-nums font-mono">{cost > 0 ? formatCost(cost) : "—"}</td>
                    <td className="text-text-3 tabular-nums">{la ? timeAgo(la) : "—"}</td>
                    <td className="text-text-3 tabular-nums">{new Date(u.created_at).toLocaleDateString("en-AU")}</td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={9} className="text-center text-text-3 py-8">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
