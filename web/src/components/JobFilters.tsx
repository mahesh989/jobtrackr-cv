"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { ShieldCheck, X } from "lucide-react";

export function JobFilters({
  totalCount,
  newCount,
  appliedCount,
  dismissedCount,
}: {
  totalCount: number;
  newCount: number;
  appliedCount: number;
  dismissedCount?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  function update(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value); else params.delete(key);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function clearAll() {
    startTransition(() => router.replace(pathname));
  }

  const currentStatus  = sp.get("status") || "all";
  const postedWithin   = sp.get("posted_within") || "";
  const minKeywords    = sp.get("min_keywords") || "";
  const locationVal    = sp.get("location") || "";
  const visaOn         = sp.get("visa_toggle") === "1";
  const hasFilters     = sp.toString().length > 0;

  const STATUS_TABS = [
    { value: "all",       label: "Active",    count: totalCount },
    { value: "new",       label: "New",       count: newCount },
    { value: "applied",   label: "Applied",   count: appliedCount },
    { value: "dismissed", label: "Dismissed", count: dismissedCount },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status tabs — cv-magic style segmented control. All colours come
          from theme CSS variables so each theme repaints the active pill,
          counts, and hover state automatically. */}
      <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5">
        {STATUS_TABS.map((tab) => {
          const active = currentStatus === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => update("status", tab.value === "all" ? "" : tab.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all ${
                active
                  ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]"
                  : "text-text-2 hover:text-text"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span
                  className={
                    "text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center " +
                    (active && tab.value === "new"
                      ? "bg-[var(--brand)] text-[var(--brand-fg)]"
                      : active
                      ? "bg-text text-[var(--surface)]"
                      : "bg-[var(--border)] text-text-2")
                  }
                >
                  {tab.count > 99 ? "99+" : tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-5 w-px bg-[var(--border)]" />

      {/* Posted within */}
      <select
        value={postedWithin || "any"}
        onChange={(e) => update("posted_within", e.target.value === "any" ? "" : e.target.value)}
        className="field text-xs py-1 px-2.5 h-[30px] w-auto min-w-[120px]"
      >
        <option value="any">Any time</option>
        <option value="7">Last 7 days</option>
        <option value="14">Last 14 days</option>
        <option value="30">Last 30 days</option>
      </select>

      {/* Min keywords */}
      <select
        value={minKeywords || "0"}
        onChange={(e) => update("min_keywords", e.target.value === "0" ? "" : e.target.value)}
        className="field text-xs py-1 px-2.5 h-[30px] w-auto min-w-[130px]"
      >
        <option value="0">Any keyword match</option>
        <option value="1">≥ 1 keyword</option>
        <option value="2">≥ 2 keywords</option>
        <option value="3">≥ 3 keywords</option>
      </select>

      {/* Location */}
      <input
        type="text"
        defaultValue={locationVal}
        placeholder="Filter by location…"
        className="field text-xs py-1 px-2.5 h-[30px] w-[160px]"
        onBlur={(e) => update("location", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && update("location", e.currentTarget.value)}
      />

      {/* Visa toggle — purple pop uses the theme's --purple variable so
          Notion's lavender, Gilded Noir's lavender-bright, etc. all
          render correctly. */}
      <button
        onClick={() => update("visa_toggle", visaOn ? "" : "1")}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 h-[30px] rounded-md border text-xs font-medium transition-all ${
          visaOn
            ? "bg-purple-light border-purple/30 text-purple"
            : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
        }`}
      >
        <ShieldCheck className="w-3 h-3" />
        {visaOn ? "Visa on" : "Visa filter"}
      </button>

      {/* Clear */}
      {hasFilters && (
        <button
          onClick={clearAll}
          className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text transition-colors h-[30px] px-1"
        >
          <X className="w-3 h-3" />
          Clear
        </button>
      )}
    </div>
  );
}
