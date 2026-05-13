"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

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
      {/* Status tabs */}
      <div className="flex items-center gap-1 bg-[#F6F8FA] border border-[#D0D7DE] rounded-md p-0.5">
        {STATUS_TABS.map((tab) => {
          const active = currentStatus === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => update("status", tab.value === "all" ? "" : tab.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-[12px] font-medium transition-all ${
                active
                  ? "bg-white text-[#1F2328] shadow-sm border border-[#D0D7DE]"
                  : "text-[#656D76] hover:text-[#1F2328]"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center ${
                  active && tab.value === "new"
                    ? "bg-[#0969DA] text-white"
                    : active
                    ? "bg-[#1F2328] text-white"
                    : "bg-[#D0D7DE] text-[#656D76]"
                }`}>
                  {tab.count > 99 ? "99+" : tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-5 w-px bg-[#D0D7DE]" />

      {/* Posted within */}
      <select
        value={postedWithin || "any"}
        onChange={(e) => update("posted_within", e.target.value === "any" ? "" : e.target.value)}
        className="field text-[12px] py-1 px-2.5 h-[30px] w-auto min-w-[120px]"
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
        className="field text-[12px] py-1 px-2.5 h-[30px] w-auto min-w-[130px]"
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
        className="field text-[12px] py-1 px-2.5 h-[30px] w-[160px]"
        onBlur={(e) => update("location", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && update("location", e.currentTarget.value)}
      />

      {/* Visa toggle */}
      <button
        onClick={() => update("visa_toggle", visaOn ? "" : "1")}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 h-[30px] rounded-md border text-[12px] font-medium transition-all ${
          visaOn
            ? "bg-[#FBEFFF] border-[#8250DF]/30 text-[#8250DF]"
            : "bg-white border-[#D0D7DE] text-[#656D76] hover:text-[#1F2328]"
        }`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
        </svg>
        {visaOn ? "Visa on" : "Visa filter"}
      </button>

      {/* Clear */}
      {hasFilters && (
        <button
          onClick={clearAll}
          className="inline-flex items-center gap-1 text-[11px] text-[#9198A1] hover:text-[#1F2328] transition-colors h-[30px] px-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
          Clear
        </button>
      )}
    </div>
  );
}
