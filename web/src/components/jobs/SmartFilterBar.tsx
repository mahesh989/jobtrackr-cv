"use client";

/**
 * Smart Filter Bar — replaces JobFilterBar.
 *
 * Unified row: location input + time dropdown + sort dropdown.
 * Active filters show as dismissible pills below.
 * Visa toggle is an inline pill-style button.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition, useState } from "react";
import { X, ShieldCheck, ArrowUpDown, Loader2 } from "lucide-react";
import { shallowSetParams } from "./shallowNav";

const SORT_OPTIONS = [
  { value: "posted_at",           label: "Date posted" },
  { value: "created_at",          label: "Date added" },
  { value: "rich_jd_first",       label: "Rich JD first" },
  { value: "recently_progressed", label: "Recently progressed" },
  { value: "most_progressed",     label: "Most progressed" },
  { value: "distance",            label: "Distance (nearest)" },
] as const;

const DISTANCE_OPTIONS = [
  { value: "",    label: "Any distance" },
  { value: "5",   label: "Within 5 km" },
  { value: "10",  label: "Within 10 km" },
  { value: "25",  label: "Within 25 km" },
  { value: "50",  label: "Within 50 km" },
  { value: "100", label: "Within 100 km" },
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

const ATS_OPTIONS = [
  { value: "",              label: "Any ATS score" },
  { value: "above_final",   label: "Above final" },
  { value: "below_final",   label: "Below final" },
  { value: "below_initial", label: "Below initial" },
  { value: "no_ats",        label: "No ATS" },
] as const;

// View filters that can be applied instantly client-side on the dashboard
// (no server refetch). Everything else (location / time / source) narrows the
// fetched dataset and must hit the server.
const SHALLOW_KEYS = new Set(["ats", "sort", "dir", "min_keywords", "visa_toggle", "max_distance"]);

export function SmartFilterBar({
  total,
  showKeywords = true,
  showAtsFilter = false,
  shallow = false,
  homeAddress = null,
}: {
  total: number;
  /** Show the "min keywords matched" dropdown (per-profile board). */
  showKeywords?: boolean;
  /** Show the ATS-score band dropdown (main dashboard). */
  showAtsFilter?: boolean;
  /** Dashboard board: apply view filters instantly via the History API. */
  shallow?: boolean;
  /** When set, render the "Within X km" distance filter and show the
   *  origin indicator. Omit (or pass null) for profiles without a
   *  home_address — the distance controls are hidden entirely. */
  homeAddress?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const spStr = sp.toString();
  const [isPending, startTransition] = useTransition();

  // Commit params either shallow (client-only, instant) for view filters, or
  // via the router (server refetch) for dataset-narrowing filters.
  function commit(params: URLSearchParams, key: string) {
    if (shallow && SHALLOW_KEYS.has(key)) shallowSetParams(pathname, params);
    else startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  // Optimistic control values. A controlled <select value={urlParam}> only
  // updates after the server round-trip lands the new searchParams, so the
  // dropdown visibly lags by a second or two. We mirror the chosen value
  // locally (keyed to the params string it was chosen against) for instant
  // feedback; once the URL catches up, spStr no longer matches `base` and the
  // override is discarded so the URL value takes over again — no effect, no
  // cascading render.
  const [opt, setOpt] = useState<{ base: string; vals: Record<string, string> }>({ base: spStr, vals: {} });
  const optVals = opt.base === spStr ? opt.vals : {};
  const v = (key: string, fallback: string) => (key in optVals ? optVals[key] : fallback);

  const postedWithin = sp.get("posted_within") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const atsBand = sp.get("ats") || "";
  const locationVal = sp.get("location") || "";
  const visaOn = sp.get("visa_toggle") === "1";
  const maxDistance = sp.get("max_distance") || "";
  const currentSort = sp.get("sort") || "posted_at";
  const currentDir = sp.get("dir") || "desc";
  const showDistance = !!homeAddress && homeAddress.trim().length > 0;

  function update(key: string, value: string) {
    setOpt({ base: spStr, vals: { ...optVals, [key]: value } });
    const params = new URLSearchParams(spStr);
    if (value) params.set(key, value);
    else params.delete(key);
    // scroll:false — let ScrollToJobsOnFilter handle the smooth move to the
    // results table instead of Next's default jump-to-top.
    commit(params, key);
  }

  function setSort(sort: string) {
    const nextDir = sort === currentSort ? (currentDir === "desc" ? "asc" : "desc") : "desc";
    setOpt({ base: spStr, vals: { ...optVals, sort, dir: nextDir } });
    const params = new URLSearchParams(spStr);
    params.set("sort", sort);
    params.set("dir", nextDir);
    commit(params, "sort");
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
  if (showKeywords && minKeywords) {
    const kl = KEYWORD_OPTIONS.find((k) => k.value === minKeywords);
    pills.push({ key: "min_keywords", label: `🔑 ${kl?.label ?? minKeywords}` });
  }
  if (showAtsFilter && atsBand) {
    const al = ATS_OPTIONS.find((a) => a.value === atsBand);
    pills.push({ key: "ats", label: `📊 ${al?.label ?? atsBand}` });
  }
  if (visaOn) pills.push({ key: "visa_toggle", label: "🛡 Visa" });
  if (showDistance && maxDistance) {
    const dl = DISTANCE_OPTIONS.find((d) => d.value === maxDistance);
    pills.push({ key: "max_distance", label: `🚗 ${dl?.label ?? `Within ${maxDistance} km`}` });
  }

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
          value={v("posted_within", postedWithin)}
          onChange={(e) => update("posted_within", e.target.value)}
          className={`${ctrlCls} min-w-[100px]`}
        >
          {TIME_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {/* Keywords (per-profile board only) */}
        {showKeywords && (
          <select
            value={v("min_keywords", minKeywords)}
            onChange={(e) => update("min_keywords", e.target.value)}
            className={`${ctrlCls} min-w-[110px]`}
          >
            {KEYWORD_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        )}

        {/* ATS score band (main dashboard only) */}
        {showAtsFilter && (
          <select
            value={v("ats", atsBand)}
            onChange={(e) => update("ats", e.target.value)}
            className={`${ctrlCls} min-w-[120px]`}
          >
            {ATS_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        )}

        {/* Distance filter — only shown when the profile has a home address. */}
        {showDistance && (
          <select
            value={v("max_distance", maxDistance)}
            onChange={(e) => update("max_distance", e.target.value)}
            className={`${ctrlCls} min-w-[130px]`}
            title={`Distances from: ${homeAddress}`}
          >
            {DISTANCE_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        )}

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

        {/* Result count (shows a spinner while the filtered list is loading) */}
        <span className="inline-flex items-center gap-1 text-[11px] text-text-3 whitespace-nowrap shrink-0">
          {isPending && <Loader2 className="w-3 h-3 animate-spin" />}
          {isPending ? "Updating…" : `${total} job${total !== 1 ? "s" : ""}`}
        </span>

        {/* Sort dropdown */}
        <div className="relative shrink-0">
          <select
            value={v("sort", currentSort)}
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
        {(() => {
          const dirNow = v("dir", currentDir);
          return (
            <button
              onClick={() => update("dir", dirNow === "desc" ? "asc" : "desc")}
              className="shrink-0 inline-flex items-center justify-center w-[30px] h-[30px] rounded-md border border-[var(--border)] bg-[var(--surface)] text-text-2 hover:text-text text-xs transition-colors"
              title={dirNow === "desc" ? "Descending" : "Ascending"}
            >
              {dirNow === "desc" ? "↓" : "↑"}
            </button>
          );
        })()}
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

      {/* Origin indicator — only shown when distances are active so the user
          always knows where "X km" is measured from. */}
      {showDistance && (
        <p className="text-[10px] text-text-3 mt-0.5">
          Distances from <span className="text-text-2 font-medium">{homeAddress}</span>
        </p>
      )}
    </div>
  );
}
