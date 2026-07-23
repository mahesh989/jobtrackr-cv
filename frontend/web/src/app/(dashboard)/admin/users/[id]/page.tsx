/**
 * /admin/users/[id] — Full user profile drill-down
 *
 * Everything about one user:
 *   - Account details (email, role, joined, invite used)
 *   - Subscription & billing
 *   - CV library with signed download URLs (research use)
 *   - Voice profile (text preview)
 *   - Email integration status
 *   - Search profiles + last run status
 *   - Analysis runs history + avg match score
 *   - Applied jobs breakdown by source
 *   - Last login IP / device (from user_events)
 */
import { requireAdmin, fmtDateTime } from "@/lib/admin/guard";

function formatCost(millicents: number): string {
  const dollars = millicents / 100_000;
  if (dollars === 0) return "$0";
  if (dollars < 0.001) return `$${dollars.toFixed(6)}`;
  if (dollars < 0.10)  return `$${dollars.toFixed(4)}`;
  if (dollars < 10)    return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}
function timeAgo(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60)          return "just now";
  if (secs < 3600)        return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)       return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7)   return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
import { adminGrantUnlimitedAccess } from "@/lib/admin/actions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-caption font-semibold text-text-3 uppercase tracking-widest mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Kv({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-caption text-text-3 w-36 shrink-0">{label}</span>
      <span className={`text-label text-text ${mono ? "font-mono" : ""}`}>{value ?? "—"}</span>
    </div>
  );
}

export default async function AdminUserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { admin } = await requireAdmin();

  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);

  // Core queries
  const [
    { data: userRaw },
    { data: inviteCodes },
    { data: cvVersions },
    { data: searchProfiles },
    { data: subscription },
    { data: plans },
  ] = await Promise.all([
    admin.from("users").select("id, email, role, created_at, invite_code_used").eq("id", id).single(),
    admin.from("invite_codes").select("code, created_by, used_at"),
    admin.from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false }),
    admin.from("search_profiles")
      .select("id, name, is_active, schedule_cron, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false }),
    admin.from("subscriptions")
      .select("plan_id, status, trial_end, current_period_end, created_at")
      .eq("user_id", id)
      .single(),
    admin.from("plans").select("id, name, price_cents, billing_interval"),
  ]);

  if (!userRaw) notFound();

  type User        = { id: string; email: string; role: string; created_at: string; invite_code_used: string | null };
  type CvVersion   = { id: string; label: string; pdf_storage_path: string; is_active: boolean; created_at: string };
  type Profile     = { id: string; name: string; is_active: boolean; schedule_cron: string | null; created_at: string };
  type Sub         = { plan_id: string; status: string; trial_end: string | null; current_period_end: string | null; created_at: string };
  type Plan        = { id: string; name: string | null; price_cents: number; billing_interval: string | null };
  type InviteCode  = { code: string; created_by: string | null; used_at: string | null };

  const user        = userRaw as User;
  const cvs         = (cvVersions  ?? []) as CvVersion[];
  const profiles    = (searchProfiles ?? []) as Profile[];
  const sub         = (subscription ?? null) as Sub | null;
  const planList    = (plans ?? []) as Plan[];
  const allInvites  = (inviteCodes ?? []) as InviteCode[];

  // Plan lookup
  const planById    = planList.reduce<Record<string, Plan>>((a, p) => { a[p.id] = p; return a; }, {});
  const plan        = sub ? planById[sub.plan_id] : null;

  // Invite tree: who invited this user?
  const inviteUsed  = allInvites.find((c) => c.code === user.invite_code_used);

  // Optional tables
  const [voiceProfiles, emailIntegrations, analysisRuns, loginEvents, aiCosts] = await Promise.all([
    safeQuery(admin.from("voice_profiles")
      .select("voice_sample_raw, voice_sample_source, voice_sample_trust_score, created_at")
      .eq("user_id", id)),
    safeQuery(admin.from("email_integrations")
      .select("provider, from_address, created_at")
      .eq("user_id", id)),
    safeQuery(admin.from("analysis_runs")
      .select("id, status, match_score, tailored_match_score, ats_lift, created_at, completed_at, error_message")
      .eq("user_id", id)
      .order("created_at", { ascending: false })
      .limit(25)),
    safeQuery(admin.from("user_events")
      .select("event_type, ip, country, city, device, created_at")
      .eq("user_id", id)
      .eq("event_type", "login")
      .order("created_at", { ascending: false })
      .limit(5)),
    safeQuery(admin.from("ai_calls")
      .select("cost_millicents, created_at")
      .eq("user_id", id)),
  ]);

  type VoiceRow  = { voice_sample_raw: string; voice_sample_source: string; voice_sample_trust_score: number; created_at: string };
  type EmailInt  = { provider: string; from_address: string; created_at: string };
  type RunRow    = { id: string; status: string; match_score: number | null; tailored_match_score: number | null; ats_lift: number | null; created_at: string; completed_at: string | null; error_message: string | null };
  type LoginRow  = { event_type: string; ip: string | null; country: string | null; city: string | null; device: string | null; created_at: string };
  type CostRow   = { cost_millicents: number; created_at: string };

  const voice      = (voiceProfiles   as VoiceRow[])[0]  ?? null;
  const emailInt   = (emailIntegrations as EmailInt[])[0] ?? null;
  const runs       = analysisRuns as RunRow[];
  const logins     = loginEvents  as LoginRow[];
  const costs      = aiCosts      as CostRow[];
  const lastLogin  = logins[0]    ?? null;

  // Applied jobs by source (query only profiles we have)
  const profileIds = profiles.map((p) => p.id);
  const appliedBySource: Record<string, number> = {};
  if (profileIds.length > 0) {
    const { data: appliedJobs } = await admin
      .from("jobs")
      .select("source, applied_at")
      .in("profile_id", profileIds)
      .not("applied_at", "is", null);
    (appliedJobs ?? []).forEach((j: { source: string; applied_at: string | null }) => {
      appliedBySource[j.source] = (appliedBySource[j.source] ?? 0) + 1;
    });
  }
  const appliedTotal = Object.values(appliedBySource).reduce((s, n) => s + n, 0);

  // Signed CV download URLs (1 h TTL)
  const signedUrls: Record<string, string> = {};
  await Promise.all(
    cvs.map(async (cv) => {
      const { data } = await admin.storage.from("cvs").createSignedUrl(cv.pdf_storage_path, 3600);
      if (data?.signedUrl) signedUrls[cv.id] = data.signedUrl;
    })
  );

  // Stats
  const completedRuns   = runs.filter((r) => r.status === "completed");
  const avgScore        = completedRuns.length > 0
    ? completedRuns.reduce((s, r) => s + (r.tailored_match_score ?? 0), 0) / completedRuns.length
    : null;
  const totalCost       = costs.reduce((s, c) => s + c.cost_millicents, 0);

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-caption text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span>
          <Link href="/admin/users" className="hover:text-text">Users</Link>
          <span>/</span>
          <span className="text-text-2 truncate max-w-[200px]">{user.email}</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lead font-semibold text-text">{user.email}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={user.role === "founder" ? "amber" : user.role === "admin" ? "purple" : "gray"} className="text-micro">
                {user.role}
              </Badge>
              {sub && (
                <Badge variant={sub.status === "active" ? "green" : sub.status === "trialing" ? "amber" : "gray"} className="text-micro">
                  {sub.status}
                </Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-label text-text-3">Joined {new Date(user.created_at).toLocaleDateString("en-AU")}</p>
            {totalCost > 0 && <p className="text-caption text-text-3 mt-0.5">Lifetime AI cost: {formatCost(totalCost)}</p>}
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-7 max-w-4xl">

        {/* Account */}
        <Section title="Account">
          <div className="bg-surface border border-border rounded-md px-4 py-2">
            <Kv label="User ID"      value={user.id}    mono />
            <Kv label="Email"        value={user.email} />
            <Kv label="Role"         value={user.role}  />
            <Kv label="Joined"       value={fmtDateTime(user.created_at)} />
            <Kv label="Invite used"  value={
              user.invite_code_used
                ? <span className="font-mono">{user.invite_code_used}{inviteUsed?.created_by ? ` (created by ${inviteUsed.created_by.slice(0, 8)}…)` : ""}</span>
                : "Direct signup"
            } />
          </div>
        </Section>

        {/* Subscription */}
        <Section title="Subscription">
          {sub ? (
            <div className="bg-surface border border-border rounded-md px-4 py-2">
              <Kv label="Plan"           value={plan?.name ?? sub.plan_id} />
              <Kv label="Status"         value={sub.status} />
              <Kv label="Price"          value={plan ? `$${(plan.price_cents / 100).toFixed(2)} / ${plan.billing_interval ?? "month"}` : "—"} />
              <Kv label="Trial ends"     value={sub.trial_end     ? fmtDateTime(sub.trial_end)             : "—"} />
              <Kv label="Period ends"    value={sub.current_period_end ? fmtDateTime(sub.current_period_end) : "—"} />
              <Kv label="Subscribed"     value={fmtDateTime(sub.created_at)} />
            </div>
          ) : (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No subscription record.</p>
          )}
          {/* Grant unlimited — fixes expired comp, trialing, or wrong-plan subs */}
          {user.role !== "founder" && user.role !== "admin" && (
            <form
              action={async () => {
                "use server";
                await adminGrantUnlimitedAccess(id);
              }}
              className="mt-2"
            >
              <button
                type="submit"
                className="text-caption px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-text-2 transition-colors"
              >
                Grant unlimited access (10 yr)
              </button>
            </form>
          )}
        </Section>

        {/* Last login + telemetry */}
        <Section title="Last login">
          {lastLogin ? (
            <div className="bg-surface border border-border rounded-md px-4 py-2">
              <Kv label="When"    value={fmtDateTime(lastLogin.created_at)} />
              <Kv label="IP"      value={lastLogin.ip}      mono />
              <Kv label="Country" value={lastLogin.country} />
              <Kv label="City"    value={lastLogin.city}    />
              <Kv label="Device"  value={lastLogin.device}  />
            </div>
          ) : (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">
              No login events yet — wire <code className="font-mono text-caption">user_events</code> inserts on auth in the web layer (see migration 055).
            </p>
          )}
          {logins.length > 1 && (
            <div className="mt-2 bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>When</th><th>IP</th><th>Country</th><th>Device</th></tr></thead>
                <tbody>
                  {logins.map((l, i) => (
                    <tr key={i}>
                      <td className="text-text-3 text-caption">{timeAgo(l.created_at)}</td>
                      <td className="font-mono text-caption">{l.ip ?? "—"}</td>
                      <td className="text-label">{l.country ?? "—"}{l.city ? `, ${l.city}` : ""}</td>
                      <td className="text-label">{l.device ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* CV library */}
        <Section title={`CV library (${cvs.length})`}>
          {cvs.length === 0 ? (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No CVs uploaded.</p>
          ) : (
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Label</th><th>Active</th><th>Uploaded</th><th>Download</th></tr></thead>
                <tbody>
                  {cvs.map((cv) => (
                    <tr key={cv.id}>
                      <td className="font-medium text-text">{cv.label}</td>
                      <td>{cv.is_active ? <Badge variant="green" className="text-micro">Active</Badge> : <span className="text-text-3 text-caption">—</span>}</td>
                      <td className="text-text-3 text-caption">{timeAgo(cv.created_at)}</td>
                      <td>
                        {signedUrls[cv.id] ? (
                          <a href={signedUrls[cv.id]} target="_blank" rel="noopener noreferrer"
                            className="text-caption text-blue-600 hover:underline font-medium">
                            PDF ↗
                          </a>
                        ) : <span className="text-text-3 text-caption">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Voice profile */}
        <Section title="Writing voice">
          {voice ? (
            <div className="bg-surface border border-border rounded-md px-4 py-3">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-caption text-text-3">Source: {voice.voice_sample_source}</span>
                <span className="text-caption text-text-3">Trust: {(voice.voice_sample_trust_score * 100).toFixed(0)}%</span>
                <span className="text-caption text-text-3">Set {timeAgo(voice.created_at)}</span>
              </div>
              <p className="text-label text-text leading-relaxed line-clamp-4">
                {voice.voice_sample_raw.slice(0, 400)}{voice.voice_sample_raw.length > 400 ? "…" : ""}
              </p>
            </div>
          ) : (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No writing voice set.</p>
          )}
        </Section>

        {/* Email integration */}
        <Section title="Email account">
          {emailInt ? (
            <div className="bg-surface border border-border rounded-md px-4 py-2">
              <Kv label="Provider"    value={emailInt.provider} />
              <Kv label="From address" value={emailInt.from_address} />
              <Kv label="Connected"   value={fmtDateTime(emailInt.created_at)} />
            </div>
          ) : (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No email account connected.</p>
          )}
        </Section>

        {/* Search profiles */}
        <Section title={`Job search profiles (${profiles.length})`}>
          {profiles.length === 0 ? (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No profiles.</p>
          ) : (
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Profile</th><th>Active</th><th>Schedule</th><th>Created</th></tr></thead>
                <tbody>
                  {profiles.map((p) => (
                    <tr key={p.id}>
                      <td className="font-medium text-text">{p.name}</td>
                      <td>{p.is_active ? <Badge variant="green" className="text-micro">Active</Badge> : <span className="text-text-3 text-caption">Paused</span>}</td>
                      <td className="font-mono text-caption text-text-3">{p.schedule_cron ?? "manual"}</td>
                      <td className="text-text-3 text-caption">{timeAgo(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Applied jobs by source */}
        {appliedTotal > 0 && (
          <Section title={`Applied jobs (${appliedTotal} total)`}>
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Source</th><th>Applied</th></tr></thead>
                <tbody>
                  {Object.entries(appliedBySource)
                    .sort((a, b) => b[1] - a[1])
                    .map(([src, count]) => (
                      <tr key={src}>
                        <td className="font-medium capitalize text-text">{src}</td>
                        <td className="tabular-nums font-semibold text-text">{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Analysis runs */}
        <Section title={`Analysis runs (${runs.length} shown)`}>
          <div className="flex items-center gap-4 mb-3">
            {completedRuns.length > 0 && (
              <>
                <span className="text-label text-text-3">{completedRuns.length} completed</span>
                {avgScore !== null && (
                  <span className="text-label text-text-3">Avg tailored score: <strong className="text-text">{avgScore.toFixed(1)}</strong></span>
                )}
              </>
            )}
            {totalCost > 0 && (
              <span className="text-label text-text-3">Total AI cost: <strong className="text-text">{formatCost(totalCost)}</strong></span>
            )}
          </div>
          {runs.length === 0 ? (
            <p className="text-label text-text-3 bg-surface border border-border rounded-md px-4 py-3">No analyses yet.</p>
          ) : (
            <div className="bg-surface border border-border rounded-md overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Run</th><th>Status</th><th>Match</th><th>Tailored</th><th>Lift</th><th>When</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono text-caption text-text-3">{r.id.slice(0, 8)}…</td>
                      <td>
                        <Badge variant={r.status === "completed" ? "green" : r.status === "failed" ? "red" : r.status === "running" ? "blue" : "gray"} className="text-micro">
                          {r.status}
                        </Badge>
                      </td>
                      <td className="tabular-nums text-label">{r.match_score ?? "—"}</td>
                      <td className="tabular-nums font-semibold text-label">{r.tailored_match_score ?? "—"}</td>
                      <td className={`tabular-nums text-label ${(r.ats_lift ?? 0) > 0 ? "text-emerald-700" : ""}`}>
                        {r.ats_lift != null ? `+${r.ats_lift}` : "—"}
                      </td>
                      <td className="text-text-3 text-caption" title={r.error_message ?? ""}>{timeAgo(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

      </div>
    </div>
  );
}
