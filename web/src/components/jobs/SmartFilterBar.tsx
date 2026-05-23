"use client";

/**
 * Smart Filter Bar — replaces JobFilterBar.
 *
 * Unified row: location input + time dropdown + sort dropdown.
 * Active filters show as dismissible pills below.
 * Visa toggle is an inline pill-style button.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { X, ShieldCheck, ArrowUpDown } from "lucide-react";

const SORT_OPTIONS = [
  { value: "posted_at",           label: "Date posted" },
  { value: "created_at",          label: "Date added" },
  { value: "rich_jd_first",       label: "Rich JD first" },
  { value: "recently_progressed", label: "Recently progressed" },
  { value: "most_progressed",     label: "Most progressed" },
] as const;

const TIME_OPTIONS = [
  { value: "",   label: "Any time" },
  { value: "7",  label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
] as const;

const KEYWORD_OPTIONS = [
  { value: "",  label: "Any keywords" },
  { value: "1", label: "≥ 1 keyword" },
  { value: "2", label: "≥ 2 keywords" },
  { value: "3", label: "≥ 3 keywords" },
] as const;

export function SmartFilterBar({ total }: { total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const postedWithin = sp.get("posted_within") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const locationVal = sp.get("location") || "";
  const visaOn = sp.get("visa_toggle") === "1";
  const currentSort = sp.get("sort") || "posted_at";
  const currentDir = sp.get("dir") || "desc";

  function update(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function setSort(sort: string) {
    const params = new URLSearchParams(sp.toString());
    if (sort === currentSort) {
      params.set("dir", currentDir === "desc" ? "asc" : "desc");
    } else {
      params.set("sort", sort);
      params.set("dir", "desc");
    }
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function removeFilter(key: string) {
    update(key, "");
  }

  /* Collect active filter pills */
  const pills: { key: string; label: string }[] = [];
  if (locationVal) pills.push({ key: "location", label: `📍 ${locationVal}` });
  if (postedWithin) {
    const tl = TIME_OPTIONS.find((t) => t.value === postedWithin);
    pills.push({ key: "posted_within", label: `🕐 ${tl?.label ?? postedWithin}` });
  }
  if (minKeywords) {
    const kl = KEYWORD_OPTIONS.find((k) => k.value === minKeywords);
    pills.push({ key: "min_keywords", label: `🔑 ${kl?.label ?? minKeywords}` });
  }
  if (visaOn) pills.push({ key: "visa_toggle", label: "🛡 Visa" });

  const sortLabel = SORT_OPTIONS.find((s) => s.value === currentSort)?.label ?? "Date posted";

  /* Shared control style */
  const ctrlCls =
    "shrink-0 border border-[var(--border)] bg-[var(--surface)] text-text " +
    "rounded-md text-xs py-1 px-2.5 h-[30px] " +
    "focus:outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/10 " +
    "transition-colors placeholder:text-[var(--text-3)]";

  return (
    <div className="space-y-1.5">
      {/* ── Main controls row ──────────────────────────── */}
      <div className="flex items-center gap-2">
        {/* Location */}
        <input
          type="text"
          defaultValue={locationVal}
          placeholder="Filter by location…"
          className={`${ctrlCls} w-[160px]`}
          onBlur={(e) => update("location", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && update("location", e.currentTarget.value)}
        />

        {/* Time range */}
        <select
          value={postedWithin || ""}
          onChange={(e) => update("posted_within", e.target.value)}
          className={`${ctrlCls} min-w-[100px]`}
        >
          {TIME_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {/* Keywords */}
        <select
          value={minKeywords || ""}
          onChange={(e) => update("min_keywords", e.target.value)}
          className={`${ctrlCls} min-w-[110px]`}
        >
          {KEYWORD_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>

        {/* Visa toggle */}
        <button
          onClick={() => update("visa_toggle", visaOn ? "" : "1")}
          className={`shrink-0 inline-flex items-center gap-1 px-2 h-[30px] rounded-md border text-xs font-medium transition-all ${
            visaOn
              ? "bg-purple-light border-purple/30 text-purple"
              : "bg-[var(--surface)] border-[var(--border)] text-text-3 hover:text-text-2"
          }`}
        >
          <ShieldCheck className="w-3 h-3 shrink-0" />
          Visa
        </button>

        {/* Spacer */}
        <div className="flex-1 min-w-2" />

        {/* Result count */}
        <span className="text-[11px] text-text-3 whitespace-nowrap shrink-0">
          {total} job{total !== 1 ? "s" : ""}
        </span>

        {/* Sort dropdown */}
        <div className="relative shrink-0">
          <select
            value={currentSort}
            onChange={(e) => setSort(e.target.value)}
            className={`${ctrlCls} pl-7 pr-2 appearance-none cursor-pointer min-w-[140px]`}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ArrowUpDown
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-3 pointer-events-none"
          />
        </div>

        {/* Sort direction toggle */}
        <button
          onClick={() => update("dir", currentDir === "desc" ? "asc" : "desc")}
          className="shrink-0 inline-flex items-center justify-center w-[30px] h-[30px] rounded-md border border-[var(--border)] bg-[var(--surface)] text-text-2 hover:text-text text-xs transition-colors"
          title={currentDir === "desc" ? "Descending" : "Ascending"}
        >
          {currentDir === "desc" ? "↓" : "↑"}
        </button>
      </div>

      {/* ── Active filter pills ────────────────────────── */}
      {pills.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {pills.map((p) => (
            <span
              key={p.key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[11px] text-text-2"
            >
              {p.label}
              <button
                onClick={() => removeFilter(p.key)}
                className="hover:text-text transition-colors"
                title={`Remove ${p.label} filter`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <button
            onClick={() => {
              pills.forEach((p) => removeFilter(p.key));
            }}
            className="text-[10px] text-text-3 hover:text-text-2 transition-colors ml-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
