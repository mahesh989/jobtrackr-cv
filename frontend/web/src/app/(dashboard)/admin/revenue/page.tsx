/**
 * /admin/revenue — Revenue & billing health
 *
 * Real data: subscriptions + plans tables (always exist after migration 051).
 * MRR trend and billing events are placeholder — replace when Stripe webhooks land.
 */
import { requireAdmin, timeAgo } from "@/lib/admin/guard";
import Link from "next/link";
import { Badge } from "@/components/ui";

export const metadata = { title: "Revenue — Admin — JobTrackr" };
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

const PLAN_VARIANT: Record<string, "amber" | "blue" | "green" | "purple" | "gray"> = {
  trial:     "amber",
  weekly:    "blue",
  monthly:   "green",
  unlimited: "purple",
  comp:      "gray",
};

export default async function AdminRevenuePage() {
  const { admin } = await requireAdmin();

  const [
    { data: subsRaw },
    { data: plansRaw },
    { data: usersRaw },
  ] = await Promise.all([
    admin.from("subscriptions").select("user_id, plan_id, status, current_period_start, current_period_end, trial_end, cancel_at_period_end, created_at"),
    admin.from("plans").select("id, display_name, price_cents, billing_interval").order("sort_order"),
    admin.from("users").select("id, email"),
  ]);

  type SubRow  = { user_id: string; plan_id: string; status: string; current_period_start: string | null; current_period_end: string | null; trial_end: string | null; cancel_at_period_end: boolean; created_at: string };
  type PlanRow = { id: string; display_name: string; price_cents: number; billing_interval: string | null };

  const subs   = (subsRaw  ?? []) as SubRow[];
  const plans  = (plansRaw ?? []) as PlanRow[];
  const users  = (usersRaw ?? []) as { id: string; email: string }[];
  const emailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});
  const planById  = plans.reduce<Record<string, PlanRow>>((a, p) => { a[p.id] = p; return a; }, {});

  const now = new Date();
  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const d30ago = new Date(now.getTime() - 30 * 86400_000);

  // ── MRR calculation ──────────────────────────────────────────────────────
  // active/trialing subscriptions contribute to MRR based on plan price + interval.
  // weekly price × 4.33 (avg weeks/month) = monthly equivalent.
  function planMonthlyCents(plan: PlanRow): number {
    if (!plan.price_cents) return 0;
    if (plan.billing_interval === "week")  return Math.round(plan.price_cents * 4.33);
    if (plan.billing_interval === "month") return plan.price_cents;
    return 0;
  }

  const activeSubs  = subs.filter((s) => s.status === "active");
  const trialSubs   = subs.filter((s) => s.status === "trialing");
  const compSubs    = subs.filter((s) => s.status === "comp");
  const pastDueSubs = subs.filter((s) => s.status === "past_due");

  const mrrCents = activeSubs.reduce((sum, s) => {
    const plan = planById[s.plan_id];
    return sum + (plan ? planMonthlyCents(plan) : 0);
  }, 0);
  const arrCents = mrrCents * 12;
  const avgRevPerUser = activeSubs.length > 0 ? mrrCents / activeSubs.length : 0;

  // Trial conversion: trials that started AND already converted this month
  const trialsThisMonth = subs.filter((s) => s.created_at && new Date(s.created_at) >= monthStart).length;
  const convertedThisMonth = activeSubs.filter((s) => s.created_at && new Date(s.created_at) >= monthStart).length;
  const conversionRate = trialsThisMonth > 0 ? Math.round((convertedThisMonth / trialsThisMonth) * 100) : null;

  // Plan breakdown: count + MRR contribution
  const byPlan: Record<string, { count: number; mrr: number }> = {};
  activeSubs.forEach((s) => {
    const plan = planById[s.plan_id];
    if (!byPlan[s.plan_id]) byPlan[s.plan_id] = { count: 0, mrr: 0 };
    byPlan[s.plan_id].count++;
    byPlan[s.plan_id].mrr += plan ? planMonthlyCents(plan) : 0;
  });

  // Expiring trials (next 3 days)
  const d3 = new Date(now.getTime() + 3 * 86400_000);
  const expiringTrials = trialSubs.filter((s) => s.trial_end && new Date(s.trial_end) <= d3);

  // Pending cancellations (cancel_at_period_end = true)
  const pendingCancel = activeSubs.filter((s) => s.cancel_at_period_end);

  // Recent subscriptions (last 30d)
  const recentSubs = subs
    .filter((s) => s.created_at && new Date(s.created_at) >= d30ago)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
  const fmtK = (cents: number) => cents >= 100_000 ? `$${(cents / 100_000).toFixed(1)}k` : fmt(cents);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Revenue</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Revenue & billing</h1>
        <p className="text-[12px] text-text-3 mt-0.5">Live from the <code className="font-mono text-[11px]">subscriptions</code> table. MRR trend and billing events are placeholder data.</p>
      </div>

      <div className="mx-6 mt-4 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-[12px] text-amber-800">
        <span className="text-base leading-none mt-0.5">⚠</span>
        <span><span className="font-semibold">Partial data</span> — MRR trend chart and billing events feed are not yet wired to Stripe webhooks.</span>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {/* Top KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="MRR"  value={fmtK(mrrCents)} sub={`${activeSubs.length} active subscribers`} color="text-emerald-700" />
          <Kpi label="ARR"  value={fmtK(arrCents)}  sub="MRR × 12" color="text-emerald-700" />
          <Kpi label="ARPU" value={avgRevPerUser > 0 ? fmt(avgRevPerUser) : "—"} sub="per paying user / mo" />
          <Kpi label="Trial → paid"
            value={conversionRate !== null ? `${conversionRate}%` : "—"}
            sub={`${convertedThisMonth} converted this month`}
            color={conversionRate !== null && conversionRate < 30 ? "text-amber-700" : "text-emerald-700"}
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Active"    value={String(activeSubs.length)}  color="text-emerald-700" />
          <Kpi label="Trialing"  value={String(trialSubs.length)}   color="text-amber-700" />
          <Kpi label="Past due"  value={String(pastDueSubs.length)} color={pastDueSubs.length > 0 ? "text-red-700" : "text-text-3"} />
          <Kpi label="Comp / grandfathered" value={String(compSubs.length)} />
        </div>

        {/* Alerts */}
        {(expiringTrials.length > 0 || pendingCancel.length > 0 || pastDueSubs.length > 0) && (
          <section className="space-y-2">
            {pastDueSubs.length > 0 && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-md px-4 py-2.5 text-[12px] text-red-800">
                <span className="font-semibold">🔴 {pastDueSubs.length} past-due</span> — payment collection failing.
              </div>
            )}
            {expiringTrials.length > 0 && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-md px-4 py-2.5 text-[12px] text-amber-800">
                <span className="font-semibold">⏱ {expiringTrials.length} trial{expiringTrials.length > 1 ? "s" : ""} expiring</span> in the next 3 days.
              </div>
            )}
            {pendingCancel.length > 0 && (
              <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-md px-4 py-2.5 text-[12px] text-orange-800">
                <span className="font-semibold">↩ {pendingCancel.length} cancellation{pendingCancel.length > 1 ? "s" : ""} pending</span> — will lapse at period end.
              </div>
            )}
          </section>
        )}

        {/* MRR trend — not yet wired */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">MRR trend — last 12 months</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-8 text-center text-[12px] text-text-3">
            Not yet wired — connect Stripe webhooks to populate.
          </div>
        </section>

        {/* Plan breakdown */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Active plan breakdown</h2>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Plan</th><th>Subscribers</th><th>Monthly price</th><th>MRR contribution</th><th>% of MRR</th></tr></thead>
              <tbody>
                {plans.filter((p) => byPlan[p.id]?.count).map((plan) => {
                  const d = byPlan[plan.id] ?? { count: 0, mrr: 0 };
                  const pct = mrrCents > 0 ? (d.mrr / mrrCents) * 100 : 0;
                  return (
                    <tr key={plan.id}>
                      <td>
                        <Badge variant={PLAN_VARIANT[plan.id] ?? "gray"} className="text-[10px]">{plan.display_name}</Badge>
                      </td>
                      <td className="tabular-nums">{d.count}</td>
                      <td className="font-mono text-text-2">{plan.price_cents > 0 ? fmt(plan.price_cents) : "Free"}</td>
                      <td className="font-mono text-emerald-700">{d.mrr > 0 ? fmtK(d.mrr) : "—"}</td>
                      <td className="tabular-nums text-text-3">{pct > 0 ? `${pct.toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                })}
                {Object.keys(byPlan).length === 0 && (
                  <tr><td colSpan={5} className="text-center text-text-3 py-6">No active paid subscriptions yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent subscriptions */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Recent subscription events (30d)</h2>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Period end</th><th>Since</th></tr></thead>
              <tbody>
                {recentSubs.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-text-3 py-6">No subscription changes in the last 30 days.</td></tr>
                )}
                {recentSubs.map((s) => (
                  <tr key={s.user_id}>
                    <td className="text-text font-medium truncate max-w-[200px]">
                      <Link href={`/admin/activity?user=${s.user_id}`} className="hover:underline">
                        {emailById[s.user_id] ?? s.user_id.slice(0, 12) + "…"}
                      </Link>
                    </td>
                    <td><Badge variant={PLAN_VARIANT[s.plan_id] ?? "gray"} className="text-[10px]">{planById[s.plan_id]?.display_name ?? s.plan_id}</Badge></td>
                    <td><Badge variant={s.status === "active" ? "green" : s.status === "trialing" ? "amber" : s.status === "canceled" ? "red" : "gray"} className="text-[10px]">{s.status}</Badge></td>
                    <td className="text-text-3 tabular-nums">{s.current_period_end ? new Date(s.current_period_end).toLocaleDateString("en-AU") : "—"}</td>
                    <td className="text-text-3">{timeAgo(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Billing events — not yet wired */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Billing events feed</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-8 text-center text-[12px] text-text-3">
            Not yet wired — connect Stripe webhooks to populate.
          </div>
        </section>
      </div>
    </div>
  );
}
