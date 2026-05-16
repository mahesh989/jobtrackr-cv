"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { ShieldCheck, X } from "lucide-react";

const SORT_OPTIONS = [
  { value: "posted_at",  label: "Date posted" },
  { value: "created_at", label: "Date added" },
  { value: "company",    label: "Company" },
  { value: "title",      label: "Title" },
] as const;

export function JobFilterBar({
  total,
}: {
  total: number;
}) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();

  function update(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value); else params.delete(key);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function clearAll() {
    startTransition(() => router.replace(pathname));
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

  const postedWithin = sp.get("posted_within") || "";
  const minKeywords  = sp.get("min_keywords")  || "";
  const locationVal  = sp.get("location")      || "";
  const visaOn       = sp.get("visa_toggle")   === "1";
  const hasFilters   = sp.toString().length > 0;
  const currentSort  = sp.get("sort") || "posted_at";
  const currentDir   = sp.get("dir")  || "desc";

  /* Shared style for all filter controls — explicit auto width so the
     global .field { width: 100% } can never win. Inline styles always
     beat CSS class rules regardless of layer ordering. */
  const controlStyle: React.CSSProperties = {
    width: "auto",
    flexShrink: 0,
    height: "30px",
    fontSize: "12px",
    paddingTop: "0",
    paddingBottom: "0",
    paddingLeft: "8px",
    paddingRight: "8px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
  };

  return (
    /* Single flex row — no wrapping so everything stays on one line.
       overflow-x-auto lets it scroll on very narrow viewports.         */
    <div className="flex items-center gap-2 overflow-x-auto">

      {/* ── Secondary filters ──────────────────────────────────── */}

      {/* Posted within */}
      <select
        value={postedWithin || "any"}
        onChange={(e) => update("posted_within", e.target.value === "any" ? "" : e.target.value)}
        style={controlStyle}
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
        style={controlStyle}
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
        placeholder="Location…"
        style={{ ...controlStyle, width: "120px" }}
        onBlur={(e) => update("location", e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && update("location", e.currentTarget.value)}
      />

      {/* Visa toggle */}
      <button
        onClick={() => update("visa_toggle", visaOn ? "" : "1")}
        style={{ flexShrink: 0, height: "30px" }}
        className={`inline-flex items-center gap-1.5 px-2.5 rounded-md border text-xs font-medium transition-all whitespace-nowrap ${
          visaOn
            ? "bg-purple-light border-purple/30 text-purple"
            : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
        }`}
      >
        <ShieldCheck className="w-3 h-3 shrink-0" />
        {visaOn ? "Visa on" : "Visa"}
      </button>

      {/* Clear */}
      {hasFilters && (
        <button
          onClick={clearAll}
          style={{ flexShrink: 0, height: "30px" }}
          className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text transition-colors px-1 whitespace-nowrap"
        >
          <X className="w-3 h-3 shrink-0" />
          Clear
        </button>
      )}

      {/* ── Spacer pushes sort bar to the right ────────────────── */}
      <div className="flex-1 min-w-3" />

      {/* ── Sort bar ───────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-xs text-text-2 whitespace-nowrap">
          {total.toLocaleString()} result{total !== 1 ? "s" : ""}
        </span>
        <span className="text-[11px] font-medium text-text-3 ml-1">Sort</span>

        {SORT_OPTIONS.map((opt) => {
          const active = currentSort === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border whitespace-nowrap ${
                active
                  ? "bg-text text-[var(--surface)] border-text"
                  : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
              }`}
            >
              {opt.label}
              {active && (
                <span className="opacity-60 text-[10px]">
                  {currentDir === "desc" ? "↓" : "↑"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
