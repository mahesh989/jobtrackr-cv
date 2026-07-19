/**
 * /admin/audit — Admin audit log
 *
 * A tamper-evident record of every privileged action taken by a founder/admin.
 * The admin_audit_log table exists (migration 055) but nothing writes to it yet.
 */
import { requireAdmin, timeAgo, fmtDateTime } from "@/lib/admin/guard";
import Link from "next/link";

export const metadata = { title: "Audit Log — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ action?: string }>;
}

const ACTION_COLOR: Record<string, string> = {
  "invite.generate":    "bg-blue-100 text-blue-700",
  "invite.revoke":      "bg-red-100 text-red-700",
  "user.role_changed":  "bg-purple-100 text-purple-700",
  "subscription.comp":  "bg-emerald-100 text-emerald-700",
  "run.cancel":         "bg-amber-100 text-amber-700",
  "flag.toggle":        "bg-indigo-100 text-indigo-700",
};

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const filterAction = sp.action ?? null;

  const { admin } = await requireAdmin();

  const { data: usersRaw } = await admin.from("users").select("id, email");
  const users  = (usersRaw ?? []) as { id: string; email: string }[];
  const emailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});

  // admin_audit_log exists after migration 055 but nothing writes to it yet.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);

  const realRows = await safeQuery(
    admin.from("admin_audit_log")
      .select("id, admin_id, action, target_type, target_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(200)
  ) as { id: string; admin_id: string; action: string; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>; created_at: string }[];

  type DisplayRow = {
    id: string; admin: string; action: string;
    targetType: string; targetId: string;
    metadata: Record<string, unknown>; ts: string;
  };

  const rows: DisplayRow[] = realRows.map((r) => ({
    id: r.id, admin: emailById[r.admin_id] ?? r.admin_id.slice(0, 12),
    action: r.action,
    targetType: r.target_type ?? "", targetId: r.target_id ?? "",
    metadata: r.metadata ?? {}, ts: r.created_at,
  }));

  const allActions = [...new Set(rows.map((r) => r.action))].sort();
  const filtered   = filterAction ? rows.filter((r) => r.action === filterAction) : rows;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Audit log</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Audit log</h1>
            <p className="text-[12px] text-text-3 mt-0.5">Every privileged admin action, in order.</p>
          </div>
          <span className="text-[12px] text-text-3">{filtered.length} entries</span>
        </div>
      </div>

      <div className="px-6 py-5 max-w-6xl">

        {/* Action filter chips */}
        <div className="flex flex-wrap gap-2 mb-5">
          <Link
            href="/admin/audit"
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${!filterAction ? "bg-text text-bg border-text" : "border-border text-text-2 hover:bg-[var(--sidebar-active-bg)]"}`}
          >
            All actions
          </Link>
          {allActions.map((a) => (
            <Link
              key={a}
              href={`/admin/audit?action=${a}`}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${filterAction === a ? "bg-text text-bg border-text" : "border-border text-text-2 hover:bg-[var(--sidebar-active-bg)]"}`}
            >
              {a.replace(/\./g, " ")}
            </Link>
          ))}
        </div>

        {/* Log table */}
        <div className="bg-surface border border-border rounded-md overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Admin</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="text-center text-text-3 py-8">No audit events yet.</td></tr>
              )}
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td className="text-text-3 tabular-nums whitespace-nowrap text-[11px]" title={fmtDateTime(row.ts)}>
                    {timeAgo(row.ts)}
                  </td>
                  <td className="font-medium text-text text-[12px]">{row.admin}</td>
                  <td>
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${ACTION_COLOR[row.action] ?? "bg-slate-100 text-slate-700"}`}>
                      {row.action.replace(/\./g, " ")}
                    </span>
                  </td>
                  <td className="text-text-2 text-[12px]">
                    {row.targetType && <span className="text-text-3 mr-1">{row.targetType}</span>}
                    <span className="font-mono text-[11px]">{row.targetId || "—"}</span>
                  </td>
                  <td className="text-text-3 text-[11px] font-mono max-w-xs truncate">
                    {Object.keys(row.metadata).length > 0 ? JSON.stringify(row.metadata) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Guidance box */}
        <div className="mt-6 bg-surface border border-border rounded-md p-4">
          <p className="text-[12px] font-semibold text-text mb-2">What gets logged here</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {[
              { action: "invite.generate",   desc: "New invite code created" },
              { action: "invite.revoke",     desc: "Invite code revoked" },
              { action: "user.role_changed", desc: "User role promoted/demoted" },
              { action: "subscription.comp", desc: "Comp subscription granted" },
              { action: "run.cancel",        desc: "Stuck run force-cancelled" },
              { action: "flag.toggle",       desc: "Feature flag toggled (future)" },
            ].map((item) => (
              <div key={item.action} className="flex items-center gap-2">
                <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${ACTION_COLOR[item.action] ?? "bg-slate-100 text-slate-700"}`}>
                  {item.action.replace(/\./g, " ")}
                </span>
                <span className="text-[11px] text-text-2">{item.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
