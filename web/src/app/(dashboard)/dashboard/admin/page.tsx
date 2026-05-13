import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import Link from "next/link";
import { generateInviteCode, revokeInviteCode } from "@/lib/actions";

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: allUsers }    = await admin.from("users").select("id, email, role, created_at").order("created_at", { ascending: false });
  const { data: profileRows } = await admin.from("search_profiles").select("id, user_id, name, is_active, schedule_cron");

  type UserRow    = { id: string; email: string; role: string; created_at: string };
  type ProfileRow = { id: string; user_id: string; name: string; is_active: boolean; schedule_cron: string };
  const users    = (allUsers    ?? []) as UserRow[];
  const profiles = (profileRows ?? []) as ProfileRow[];

  const profilesByUser = profiles.reduce<Record<string, ProfileRow[]>>((acc, p) => {
    (acc[p.user_id] ??= []).push(p);
    return acc;
  }, {});

  const profileIds = profiles.map((p) => p.id);
  const { data: latestRunRows } = profileIds.length > 0
    ? await admin.from("run_logs").select("profile_id, status, started_at, jobs_saved").in("profile_id", profileIds).order("started_at", { ascending: false }).limit(profileIds.length * 3)
    : { data: [] };

  type RunRow = { profile_id: string; status: string; started_at: string; jobs_saved: number };
  const latestRun = ((latestRunRows ?? []) as RunRow[]).reduce<Record<string, RunRow>>((acc, r) => {
    if (!acc[r.profile_id]) acc[r.profile_id] = r;
    return acc;
  }, {});

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const { data: costRows } = profileIds.length > 0
    ? await admin.from("run_logs").select("profile_id, ai_cost_cents").in("profile_id", profileIds).gte("started_at", monthStart.toISOString())
    : { data: [] };
  type CostRow = { profile_id: string; ai_cost_cents: number };
  const costByProfile = ((costRows ?? []) as CostRow[]).reduce<Record<string, number>>((acc, r) => {
    acc[r.profile_id] = (acc[r.profile_id] ?? 0) + (r.ai_cost_cents ?? 0);
    return acc;
  }, {});
  const costByUser = profiles.reduce<Record<string, number>>((acc, p) => {
    acc[p.user_id] = (acc[p.user_id] ?? 0) + (costByProfile[p.id] ?? 0);
    return acc;
  }, {});

  const { data: inviteRows } = await admin.from("invite_codes").select("code, created_by, used_by, used_at, is_active, created_at").order("created_at", { ascending: false });
  type InviteRow = { code: string; created_by: string | null; used_by: string | null; used_at: string | null; is_active: boolean; created_at: string };
  const invites = (inviteRows ?? []) as InviteRow[];
  const userEmailById = users.reduce<Record<string, string>>((acc, u) => { acc[u.id] = u.email; return acc; }, {});

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-[#9198A1] mb-1">
              <Link href="/dashboard" className="hover:text-[#1F2328] transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-[#656D76]">Admin</span>
            </div>
            <h1 className="text-[16px] font-semibold text-[#1F2328]">Admin</h1>
          </div>
          <Link href="/dashboard/admin/metrics" className="gh-btn text-[12px] px-2.5 py-1">
            Beta metrics →
          </Link>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">

        {/* Users table */}
        <section className="anim-in">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-[#1F2328]">Users <span className="text-[#656D76] font-normal">({users.length})</span></h2>
          </div>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Profiles</th>
                  <th>AI cost (mo)</th>
                  <th>Last run</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const ups = profilesByUser[u.id] ?? [];
                  const cost = costByUser[u.id] ?? 0;
                  const allRuns = ups.flatMap((p) => latestRun[p.id] ? [latestRun[p.id]] : []);
                  const newestRun = allRuns.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
                  return (
                    <tr key={u.id}>
                      <td className="font-medium text-[#1F2328]">{u.email}</td>
                      <td>
                        <span className={`badge text-[10px] ${
                          u.role === "founder" ? "badge-amber"
                          : u.role === "admin" ? "badge-purple"
                          : "badge-gray"
                        }`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="text-[#656D76]">{ups.length} ({ups.filter((p) => p.is_active).length} active)</td>
                      <td className="text-[#656D76]">{cost > 0 ? `$${(cost / 100000).toFixed(4)}` : "—"}</td>
                      <td>
                        {newestRun ? (
                          <span className={`text-[12px] font-medium ${
                            newestRun.status === "completed" ? "text-[#1A7F37]"
                            : newestRun.status === "failed" ? "text-[#CF222E]"
                            : "text-[#9A6700]"
                          }`}>
                            {newestRun.status} · {new Date(newestRun.started_at).toLocaleDateString("en-AU")}
                          </span>
                        ) : (
                          <span className="text-[#9198A1]">—</span>
                        )}
                      </td>
                      <td className="text-[#9198A1]">{new Date(u.created_at).toLocaleDateString("en-AU")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Invite codes */}
        <section className="anim-in anim-delay-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-[#1F2328]">
              Invite codes <span className="text-[#656D76] font-normal">({invites.length})</span>
            </h2>
            <form action={generateInviteCode}>
              <button type="submit" className="gh-btn gh-btn-blue text-[12px] px-3 py-1">
                + Generate code
              </button>
            </form>
          </div>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Status</th>
                  <th>Used by</th>
                  <th>Used at</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-[#9198A1] py-8">
                      No invite codes yet — generate one above
                    </td>
                  </tr>
                )}
                {invites.map((inv) => (
                  <tr key={inv.code}>
                    <td className="font-mono text-[13px] text-[#1F2328]">{inv.code}</td>
                    <td>
                      <span className={`badge text-[10px] ${
                        !inv.is_active ? "badge-gray"
                        : inv.used_by  ? "badge-gray"
                        :                "badge-green"
                      }`}>
                        {!inv.is_active ? "revoked" : inv.used_by ? "used" : "available"}
                      </span>
                    </td>
                    <td className="text-[#656D76]">
                      {inv.used_by ? (userEmailById[inv.used_by] ?? inv.used_by.slice(0, 8) + "…") : "—"}
                    </td>
                    <td className="text-[#9198A1]">{inv.used_at ? new Date(inv.used_at).toLocaleDateString("en-AU") : "—"}</td>
                    <td className="text-[#9198A1]">{new Date(inv.created_at).toLocaleDateString("en-AU")}</td>
                    <td>
                      {inv.is_active && !inv.used_by && (
                        <form action={revokeInviteCode.bind(null, inv.code)}>
                          <button type="submit" className="text-[11px] text-[#CF222E] hover:underline font-medium">
                            Revoke
                          </button>
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
