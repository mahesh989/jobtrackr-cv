/**
 * /dashboard/admin/ai-costs — AI Cost & Usage Dashboard
 *
 * Answers:
 *   - How much are we spending on AI today / this month / projected month-end?
 *   - Which users/operations cost the most?
 *   - What's the cost per analysis run and per cover letter?
 *   - How often are transient errors firing and costing retries?
 *
 * Data source: ai_calls table (populated after migration 055 + TRACK_AI_USAGE=true).
 * Shows a "no data yet" state gracefully if the table is empty.
 */
import { requireAdmin, formatCost, formatTokens, resolveRange, rangeStart, RANGE_LABELS } from "@/lib/admin/guard";
import { AdminRangeFilter } from "@/features/admin/AdminRangeFilter";
import Link from "next/link";

export const metadata = { title: "AI Costs — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

function CostBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-1.5 min-w-[80px]">
        <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-mono text-text-2 shrink-0">{formatCost(value)}</span>
    </div>
  );
}

interface PageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function AdminAiCostsPage({ searchParams }: PageProps) {
  const sp      = await searchParams;
  const range   = resolveRange(sp.range);
  const { admin } = await requireAdmin();

  const now        = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const cutoff     = rangeStart(range);
  const d7ago      = new Date(now.getTime() - 7 * 86400_000);

  const { data: allUsers } = await admin.from("users").select("id, email");

  // ai_calls only exists after migration 055 is applied — gracefully fall back to empty arrays.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);
  const [rangeCalls, todayCalls] = await Promise.all([
    safeQuery(admin.from("ai_calls")
      .select("user_id, operation, provider, model, input_tokens, output_tokens, cached_tokens, cost_millicents, latency_ms, retry_count, status, created_at")
      .gte("created_at", cutoff.toISOString())
      .order("created_at", { ascending: false })),
    safeQuery(admin.from("ai_calls")
      .select("user_id, operation, cost_millicents, latency_ms, status")
      .gte("created_at", todayStart.toISOString())),
  ]);

  type CallRow = {
    user_id: string | null; operation: string; provider: string; model: string;
    input_tokens: number; output_tokens: number; cached_tokens: number;
    cost_millicents: number; latency_ms: number; retry_count: number;
    status: string; created_at: string;
  };

  const calls     = rangeCalls as CallRow[];
  const todayRows = todayCalls as { user_id: string | null; operation: string; cost_millicents: number; latency_ms: number; status: string }[];
  const users     = (allUsers  ?? []) as { id: string; email: string }[];
  const emailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});

  const noData = calls.length === 0;

  // Aggregates
  const rangeTotal    = calls.reduce((s, c) => s + c.cost_millicents, 0);
  const todayTotal    = todayRows.reduce((s, c) => s + c.cost_millicents, 0);
  const monthTokensIn = calls.reduce((s, c) => s + c.input_tokens, 0);
  const monthTokensOut= calls.reduce((s, c) => s + c.output_tokens, 0);
  const cachedTokens  = calls.reduce((s, c) => s + c.cached_tokens, 0);
  const errorCalls    = calls.filter((c) => c.status === "error").length;
  const retryCalls    = calls.filter((c) => c.retry_count > 0).length;

  // Cost by provider
  const byProvider = calls.reduce<Record<string, { cost: number; calls: number; tokens: number }>>((a, c) => {
    const p = c.provider ?? "unknown";
    a[p] ??= { cost: 0, calls: 0, tokens: 0 };
    a[p].cost   += c.cost_millicents;
    a[p].calls  += 1;
    a[p].tokens += c.input_tokens + c.output_tokens;
    return a;
  }, {});
  const providerRanked = Object.entries(byProvider).sort((a, b) => b[1].cost - a[1].cost);
  const maxProviderCost = providerRanked[0]?.[1].cost ?? 1;

  const PROVIDER_COLOR: Record<string, string> = {
    openai:    "bg-emerald-500",
    anthropic: "bg-orange-400",
    deepseek:  "bg-blue-500",
  };

  // Cost by operation
  const byOperation = calls.reduce<Record<string, number>>((a, c) => {
    a[c.operation] = (a[c.operation] ?? 0) + c.cost_millicents; return a;
  }, {});
  const opRanked = Object.entries(byOperation).sort((a, b) => b[1] - a[1]);
  const maxOpCost = opRanked[0]?.[1] ?? 1;

  // Cost by user
  const byUser = calls.reduce<Record<string, number>>((a, c) => {
    if (c.user_id) a[c.user_id] = (a[c.user_id] ?? 0) + c.cost_millicents; return a;
  }, {});
  const userRanked = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
  const maxUserCost = userRanked[0]?.[1] ?? 1;

  // Cost by model
  const byModel = calls.reduce<Record<string, { cost: number; calls: number }>>((a, c) => {
    const k = `${c.provider}/${c.model}`;
    a[k] = { cost: (a[k]?.cost ?? 0) + c.cost_millicents, calls: (a[k]?.calls ?? 0) + 1 };
    return a;
  }, {});
  const modelRanked = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);

  // Day-by-day (last 7 days)
  const dayBuckets: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    dayBuckets[d.toISOString().slice(0, 10)] = 0;
  }
  calls.filter((c) => new Date(c.created_at) >= d7ago).forEach((c) => {
    const day = c.created_at.slice(0, 10);
    if (day in dayBuckets) dayBuckets[day] = (dayBuckets[day] ?? 0) + c.cost_millicents;
  });
  const maxDay = Math.max(...Object.values(dayBuckets), 1);

  // Projected month-end (linear extrapolation from days elapsed — only meaningful for 30d range)
  const daysInMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed  = now.getDate();
  const projectedMo  = daysElapsed > 0 ? Math.round(rangeTotal * daysInMonth / daysElapsed) : 0;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">AI costs</span>
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-[16px] font-semibold text-text">AI cost & usage</h1>
            <p className="text-[12px] text-text-3 mt-0.5">
              Data from <code className="font-mono text-[11px]">ai_calls</code> table.{" "}
              {noData && <span className="text-amber-700 font-medium">No data yet — apply migration 055 and set TRACK_AI_USAGE=true on cv-backend.</span>}
            </p>
          </div>
          <AdminRangeFilter current={range} path="/dashboard/admin/ai-costs" />
        </div>
      </div>

      <div className="px-6 py-5 space-y-6 max-w-5xl">

        {/* Top-line KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Today",                value: formatCost(todayTotal),   sub: `${todayRows.length} calls` },
            { label: RANGE_LABELS[range],    value: formatCost(rangeTotal),   sub: `${calls.length} calls` },
            { label: "Projected month-end",  value: range === "30d" ? formatCost(projectedMo) : "—", sub: range === "30d" ? `day ${daysElapsed}/${daysInMonth}` : "select 30d range" },
            { label: "Cached tokens",        value: formatTokens(cachedTokens), sub: "saved from cache reads" },
          ].map((s) => (
            <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
              <p className="text-[11px] font-medium text-text-3 mb-0.5">{s.label}</p>
              <p className="text-[20px] font-bold text-text">{s.value}</p>
              <p className="text-[11px] text-text-3">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Token breakdown */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Input tokens (mo)",  value: formatTokens(monthTokensIn)  },
            { label: "Output tokens (mo)", value: formatTokens(monthTokensOut) },
            { label: "Error calls (mo)",   value: String(errorCalls),  color: errorCalls > 0 ? "text-red-600" : undefined },
            { label: "Retry calls (mo)",   value: String(retryCalls),  color: retryCalls > 0 ? "text-amber-600" : undefined },
          ].map((s) => (
            <div key={s.label} className="border border-border bg-surface rounded-md px-4 py-3">
              <p className="text-[11px] font-medium text-text-3 mb-0.5">{s.label}</p>
              <p className={`text-[20px] font-bold ${s.color ?? "text-text"}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Provider breakdown */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Cost by provider ({RANGE_LABELS[range]})</h2>
          {providerRanked.length === 0 ? (
            <p className="text-[12px] text-text-3 bg-surface border border-border rounded-md px-4 py-4">No data yet</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              {(["openai", "anthropic", "deepseek"] as const).map((prov) => {
                const d = byProvider[prov];
                return (
                  <div key={prov} className="border border-border bg-surface rounded-md px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${PROVIDER_COLOR[prov] ?? "bg-slate-400"}`} />
                      <p className="text-[11px] font-semibold text-text capitalize">{prov}</p>
                    </div>
                    <p className="text-[20px] font-bold text-text">{d ? formatCost(d.cost) : "$0"}</p>
                    <p className="text-[11px] text-text-3">{d ? `${d.calls.toLocaleString()} calls · ${formatTokens(d.tokens)} tokens` : "no usage"}</p>
                  </div>
                );
              })}
            </div>
          )}
          {providerRanked.length > 0 && (
            <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2.5">
              {providerRanked.map(([prov, d]) => (
                <div key={prov} className="flex items-center gap-3">
                  <span className="text-[12px] text-text-2 w-24 capitalize">{prov}</span>
                  <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                    <div
                      className={`${PROVIDER_COLOR[prov] ?? "bg-slate-400"} h-2 rounded-full`}
                      style={{ width: `${Math.max(2, (d.cost / maxProviderCost) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-text-2 w-20 text-right">{formatCost(d.cost)}</span>
                  <span className="text-[10px] text-text-3 w-24 text-right">{((d.cost / (rangeTotal || 1)) * 100).toFixed(1)}% of total</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Daily sparkline (text) */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Daily cost — last 7 days</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2">
            {Object.entries(dayBuckets).map(([day, cost]) => (
              <div key={day} className="flex items-center gap-3">
                <span className="text-[11px] text-text-3 tabular-nums w-24">{day}</span>
                <div className="flex-1 bg-[var(--sidebar-active-bg)] rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.max(2, (cost / maxDay) * 100)}%` }}
                  />
                </div>
                <span className="text-[11px] font-mono text-text-2 shrink-0 w-20 text-right">{formatCost(cost)}</span>
              </div>
            ))}
            {noData && <p className="text-[12px] text-text-3 text-center py-4">No data yet</p>}
          </div>
        </section>

        {/* Cost by operation */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Cost by operation ({RANGE_LABELS[range]})</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2.5">
            {opRanked.length === 0 && <p className="text-[12px] text-text-3">No data yet</p>}
            {opRanked.map(([op, cost]) => (
              <div key={op} className="flex items-center gap-3">
                <span className="text-[12px] text-text-2 w-44 truncate">{op}</span>
                <div className="flex-1"><CostBar value={cost} max={maxOpCost} /></div>
              </div>
            ))}
          </div>
        </section>

        {/* Cost by user */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Cost by user ({RANGE_LABELS[range]})</h2>
          <div className="bg-surface border border-border rounded-md px-4 py-4 space-y-2.5">
            {userRanked.length === 0 && <p className="text-[12px] text-text-3">No data yet</p>}
            {userRanked.map(([uid, cost]) => (
              <div key={uid} className="flex items-center gap-3">
                <span className="text-[12px] text-text-2 w-48 truncate">{emailById[uid] ?? uid.slice(0, 12)}</span>
                <div className="flex-1"><CostBar value={cost} max={maxUserCost} /></div>
              </div>
            ))}
          </div>
        </section>

        {/* Cost by model */}
        <section>
          <h2 className="text-[12px] font-semibold text-text mb-3">Cost by model ({RANGE_LABELS[range]})</h2>
          <div className="bg-surface border border-border rounded-md overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Model</th><th>Calls</th><th>Cost</th><th>Cost / call</th></tr></thead>
              <tbody>
                {modelRanked.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-text-3 py-6">No data yet</td></tr>
                )}
                {modelRanked.map(([model, { cost, calls: c }]) => (
                  <tr key={model}>
                    <td className="font-mono text-[12px] text-text">{model}</td>
                    <td className="tabular-nums">{c.toLocaleString()}</td>
                    <td className="tabular-nums font-mono">{formatCost(cost)}</td>
                    <td className="tabular-nums font-mono text-text-3">{c > 0 ? formatCost(Math.round(cost / c)) : "—"}</td>
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
