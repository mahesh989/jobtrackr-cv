"use client";

/**
 * SmartToolbar — the job board's filter bar.
 *
 * Four rows, in decreasing order of how often they're touched:
 *
 *   views    named queries that set several params at once ("Ready to apply")
 *   tabs     the funnel — the one genuinely ordinal axis in the data, so it
 *            gets the one genuinely ordinal control
 *   filters  search + Distance / ATS / JD quality dropdowns + Sort
 *   tokens   zero height until something is active, then the current query
 *            read back as removable chips
 *
 * The rewrite replaced 16 always-visible controls with 5. Counts moved inside
 * the dropdowns — they belong where you are *choosing*, not where you are
 * *resting*, which is what every product that solved this problem does.
 *
 * Three defects were fixed along the way rather than carried over:
 *
 *   • "Recently analysed" was a chip with the same membership as "Analysed".
 *     It is a sort, and now lives in the Sort menu.
 *   • "Rich JD first" was a sort duplicating the "Full JD" filter. Dropped.
 *   • Chips silently overwrote `sort=`, so picking a sort and then a filter
 *     threw the sort away with no indication. Only the Sort menu and the
 *     saved views write `sort` now, and views say so in their tooltip.
 *
 * URL params: stage / triage / ats / jd / sort / dir / min_keywords /
 * max_distance / min_distance / employment / eligible are all resolved
 * client-side and committed via the History API, so they are instant.
 * `location` narrows the dataset and needs the real router.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { X, ChevronDown, Search, Star } from "lucide-react";
import type { FunnelCounts } from "./PipelineFunnel";
import type { AtsBand } from "../lib/jobFilters";
import { FILTER_LABELS } from "../lib/jobFilters";
import { BOARD_VIEWS, isViewActive, paramsForView, VIEW_PARAM_KEYS } from "../lib/boardViews";
import { shallowSetParams } from "../lib/shallowNav";
import { type AtsThresholds } from "@/lib/atsThresholds";

/** `rich_jd_first` is deliberately absent — it duplicated the Full JD filter. */
const SORT_OPTIONS = [
  { value: "posted_at",           label: "Date posted",        group: "main" },
  { value: "created_at",          label: "Date added",         group: "main" },
  { value: "ats_score",           label: "ATS score",          group: "main" },
  { value: "distance",            label: "Distance (nearest)", group: "main" },
  { value: "last_analysed",       label: "Recently analysed",  group: "activity" },
  { value: "recently_progressed", label: "Recently progressed", group: "activity" },
  { value: "most_progressed",     label: "Most progressed",    group: "activity" },
] as const;

/** "over50" is a sentinel — it filters to jobs *farther* than 50 km by setting
 *  min_distance=50 and clearing max_distance, not the usual within-X cap. */
const DISTANCE_OPTIONS = [
  { value: "",       label: "Any distance" },
  { value: "5",      label: "Within 5 km" },
  { value: "10",     label: "Within 10 km" },
  { value: "25",     label: "Within 25 km" },
  { value: "50",     label: "Within 50 km" },
  { value: "over50", label: "Over 50 km" },
] as const;

/**
 * The funnel. CV ready and Letter ready are intentionally NOT tabs — they are
 * intermediate artifacts rather than places you park, they were the two least
 * used chips, and dropping them is what lets the whole funnel fit one line.
 * Both remain reachable: "Ready to apply" (the saved view) is the query people
 * actually meant when they clicked Letter ready.
 */
interface FunnelTab {
  id:       string;
  label:    string;
  /** Which param this writes. `ats` is here because "Not analysed" is an ATS
   *  band that behaves like a funnel stage — it is where un-analysed jobs sit. */
  kind:     "stage" | "ats";
  value:    string;
  countKey?: keyof FunnelCounts;
  /** Visual break — Favourite and Archive aren't pipeline stages. */
  sep?:     boolean;
  icon?:    "star";
}

const FUNNEL_TABS: FunnelTab[] = [
  { id: "notAnalysed", label: "Not analysed", kind: "ats",   value: "no_ats" },
  { id: "analysed",    label: "Analysed",     kind: "stage", value: "analysed", countKey: "analysed" },
  { id: "applied",     label: "Applied",      kind: "stage", value: "applied",  countKey: "applied"  },
  { id: "favourite",   label: "Favourite",    kind: "stage", value: "favourite", countKey: "favourite", sep: true, icon: "star" },
  { id: "dismissed",   label: "Archive",      kind: "stage", value: "dismissed", countKey: "dismissed" },
];

const SHALLOW_KEYS = new Set([
  "stage", "triage", "ats", "jd", "sort", "dir",
  "min_keywords", "max_distance", "min_distance", "employment", "eligible",
]);

/* ── popover ────────────────────────────────────────────────────────────── */

function Popover({
  label, value, active, children, align = "left",
}: {
  label:    string;
  /** Rendered after the label when set — the LinkedIn trick: a filter's own
   *  button shows its value, so state is legible without reading the tokens. */
  value?:   string | null;
  active:   boolean;
  children: (close: () => void) => React.ReactNode;
  align?:   "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-label font-medium transition-colors whitespace-nowrap " +
          (active
            ? "border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)]"
            : "border-border bg-surface text-text-2 hover:bg-[var(--surface-2)]")
        }
      >
        {label}
        {value && <b className="font-semibold text-text">{value}</b>}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className={
            "absolute z-40 mt-1.5 min-w-[240px] rounded-[10px] border border-border bg-surface shadow-lg py-1 " +
            (align === "right" ? "right-0" : "left-0")
          }
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function PopHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-micro uppercase tracking-wider font-bold text-text-3">
      {children}
    </p>
  );
}

function PopRow({
  selected, onClick, kind, children, count,
}: {
  selected: boolean;
  onClick:  () => void;
  kind:     "radio" | "check";
  children: React.ReactNode;
  count?:   number;
}) {
  return (
    <button
      type="button"
      role={kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-label text-text hover:bg-[var(--surface-2)] transition-colors text-left"
    >
      <span
        className={
          (kind === "radio" ? "rounded-full " : "rounded-[3px] ") +
          "w-3.5 h-3.5 shrink-0 border flex items-center justify-center " +
          (selected ? "border-[var(--brand)] bg-[var(--brand)]" : "border-border")
        }
      >
        {selected && (kind === "radio"
          ? <span className="w-1.5 h-1.5 rounded-full bg-white" />
          : <span className="text-white text-[9px] leading-none font-bold">✓</span>)}
      </span>
      <span className="flex-1 min-w-0">{children}</span>
      {count != null && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}

/* ── toolbar ────────────────────────────────────────────────────────────── */

export function SmartToolbar({
  counts,
  atsCounts,
  viewCounts = {},
  distanceCounts = {},
  homeAddress = null,
  thresholds = { initial: 60, final: 70 },
}: {
  counts:    FunnelCounts;
  atsCounts: Record<AtsBand, number>;
  /** Per-saved-view result counts, computed by the board from the full job set. */
  viewCounts?:     Record<string, number>;
  /** Per-distance-option counts for the Distance dropdown. */
  distanceCounts?: Record<string, number>;
  homeAddress?:    string | null;
  thresholds?:     AtsThresholds;
}) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentStage  = sp.get("stage")    || "";
  const currentAtsRaw = sp.get("ats")      || "";
  const currentJdRaw  = sp.get("jd")       || "";
  const currentSort   = sp.get("sort")     || "posted_at";
  const currentLocation    = sp.get("location")     || "";
  const currentMaxDistance = sp.get("max_distance") || "";
  const currentMinDistance = sp.get("min_distance") || "";

  const atsSet = new Set(currentAtsRaw.split(",").filter(Boolean));
  const jdSet  = new Set(currentJdRaw.split(",").filter(Boolean));

  const distanceValue =
    !currentMaxDistance && Number(currentMinDistance) >= 50 ? "over50" : currentMaxDistance;
  const distanceLabel = DISTANCE_OPTIONS.find((o) => o.value === distanceValue)?.label ?? "Any distance";

  function commit(params: URLSearchParams, key: string) {
    if (SHALLOW_KEYS.has(key)) shallowSetParams(pathname, params);
    else startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  function setOne(key: string, value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value) next.set(key, value); else next.delete(key);
    commit(next, key);
  }

  /** Toggle one value inside a comma-separated multi-select param. */
  function toggleMulti(key: "ats" | "jd", value: string) {
    const cur = new Set((sp.get(key) || "").split(",").filter(Boolean));
    if (cur.has(value)) cur.delete(value); else cur.add(value);
    setOne(key, Array.from(cur).join(","));
  }

  function setDistance(value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value === "over50") {
      next.set("min_distance", "50");
      next.delete("max_distance");
    } else if (value) {
      next.set("max_distance", value);
      next.delete("min_distance");
    } else {
      next.delete("max_distance");
      next.delete("min_distance");
    }
    commit(next, "max_distance");
  }

  /** Funnel tabs write exactly one param and never touch `sort` — that was the
   *  old behaviour's worst surprise. */
  function selectTab(tab: FunnelTab | null) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.delete("stage");
    next.delete("triage");
    next.delete("ats");
    if (tab) {
      const isActive = tab.kind === "stage"
        ? currentStage === tab.value
        : atsSet.size === 1 && atsSet.has(tab.value);
      if (!isActive) next.set(tab.kind, tab.value);
    }
    commit(next, "stage");
  }

  function isTabActive(tab: FunnelTab): boolean {
    return tab.kind === "stage"
      ? currentStage === tab.value
      : atsSet.size === 1 && atsSet.has(tab.value);
  }

  const allTabActive = !currentStage && !sp.get("triage") && atsSet.size === 0;

  function applyView(viewId: string) {
    const view = BOARD_VIEWS.find((v) => v.id === viewId);
    if (!view) return;
    const active = isViewActive(view, sp);
    const next = active
      ? (() => {
          const p = new URLSearchParams(Array.from(sp.entries()));
          for (const k of VIEW_PARAM_KEYS) p.delete(k);
          return p;
        })()
      : paramsForView(view, sp);
    commit(next, "stage");
  }

  function clearAll() {
    const next = new URLSearchParams(Array.from(sp.entries()));
    for (const k of VIEW_PARAM_KEYS) next.delete(k);
    commit(next, "stage");
  }

  const atsBands: { id: AtsBand; label: string; range: string; dot: string }[] = [
    { id: "above_final",   label: "Above", range: `≥ ${thresholds.final}`,                          dot: "bg-green-500" },
    { id: "below_final",   label: "Fair",  range: `${thresholds.initial}–${thresholds.final - 1}`,  dot: "bg-amber-500" },
    { id: "below_initial", label: "Below", range: `< ${thresholds.initial}`,                        dot: "bg-red-500"   },
  ];

  /* ── active-filter tokens ───────────────────────────────────────────── */
  interface Token { key: string; label: string; onClear: () => void }
  const tokens: Token[] = [];

  // Driven by the raw param rather than the tab list: a saved view can set a
  // stage that has no tab (letterReady), and without a token that filter would
  // be active with no way to lift it short of "Clear all".
  if (currentStage) {
    tokens.push({
      key:     "stage",
      label:   FILTER_LABELS[currentStage] ?? currentStage,
      onClear: () => setOne("stage", ""),
    });
  }
  if (sp.get("triage")) {
    const t = sp.get("triage")!;
    tokens.push({ key: "triage", label: FILTER_LABELS[t] ?? t, onClear: () => setOne("triage", "") });
  }
  for (const band of atsSet) {
    // "Not analysed" already reads as a funnel tab; don't double-report it.
    if (band === "no_ats" && atsSet.size === 1) continue;
    tokens.push({
      key: `ats:${band}`,
      label: `ATS ${FILTER_LABELS[band]?.replace(/^ATS /, "") ?? band}`,
      onClear: () => toggleMulti("ats", band),
    });
  }
  for (const q of jdSet) {
    tokens.push({ key: `jd:${q}`, label: FILTER_LABELS[q] ?? q, onClear: () => toggleMulti("jd", q) });
  }
  if (distanceValue) {
    tokens.push({ key: "dist", label: distanceLabel, onClear: () => setDistance("") });
  }
  if (currentLocation) {
    tokens.push({ key: "loc", label: `“${currentLocation}”`, onClear: () => setOne("location", "") });
  }

  const anyFilterActive = tokens.length > 0 || !allTabActive;

  return (
    <div className="rounded-md border border-border bg-surface overflow-visible">
      {/* ── saved views ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap border-b border-border px-2.5 py-1.5">
        <button
          type="button"
          onClick={clearAll}
          className={
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label font-medium transition-colors " +
            (!anyFilterActive
              ? "bg-[var(--brand)]/10 text-[var(--brand)]"
              : "text-text-2 hover:bg-[var(--surface-2)]")
          }
        >
          All jobs
          <span className="tabular-nums text-caption text-text-3">{counts.discovered}</span>
        </button>

        {BOARD_VIEWS.map((v) => {
          const active = isViewActive(v, sp);
          const n = viewCounts[v.id];
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => applyView(v.id)}
              title={v.hint}
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label font-medium transition-colors " +
                (active
                  ? "bg-[var(--brand)]/10 text-[var(--brand)]"
                  : "text-text-2 hover:bg-[var(--surface-2)]")
              }
            >
              <Star className={`w-3 h-3 ${active ? "fill-current" : ""}`} />
              {v.label}
              {n != null && <span className="tabular-nums text-caption text-text-3">{n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── funnel tabs ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5 flex-wrap border-b border-border px-2.5">
        <TabButton active={allTabActive} onClick={() => selectTab(null)} count={counts.discovered}>
          All
        </TabButton>

        {FUNNEL_TABS.map((tab, i) => {
          const active = isTabActive(tab);
          const count  = tab.kind === "ats"
            ? atsCounts[tab.value as AtsBand] ?? 0
            : counts[tab.countKey!] ?? 0;
          return (
            <span key={tab.id} className="inline-flex items-center">
              {/* The funnel is ordinal up to Applied; the arrow says so. */}
              {i === 1 && <span aria-hidden className="px-1 text-text-3 select-none">→</span>}
              {tab.sep && <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />}
              <TabButton
                active={active}
                onClick={() => selectTab(tab)}
                count={count}
                disabled={count === 0 && !active}
                icon={tab.icon}
              >
                {tab.label}
              </TabButton>
            </span>
          );
        })}
      </div>

      {/* ── filter bar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap px-2.5 py-2">
        <div className="relative w-full sm:w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
          <input
            type="text"
            defaultValue={currentLocation}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== currentLocation) setOne("location", v);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder="Location or company…"
            className="field w-full pl-8 pr-8 text-label py-1.5"
          />
          {currentLocation && (
            <button
              onClick={() => setOne("location", "")}
              disabled={pending}
              aria-label="Clear location filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 hover:text-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Distance */}
        <Popover
          label="Distance"
          value={distanceValue ? distanceLabel : null}
          active={!!distanceValue}
        >
          {(close) => (
            <>
              <PopHeading>
                {homeAddress ? `Distance from ${homeAddress}` : "Distance from home"}
              </PopHeading>
              {DISTANCE_OPTIONS.map((o) => (
                <PopRow
                  key={o.value || "any"}
                  kind="radio"
                  selected={distanceValue === o.value}
                  count={distanceCounts[o.value || "any"]}
                  onClick={() => { setDistance(o.value); close(); }}
                >
                  {o.label}
                </PopRow>
              ))}
            </>
          )}
        </Popover>

        {/* ATS — genuinely multi-select now */}
        <Popover
          label="ATS"
          value={atsSet.size > 0 ? `${atsSet.size} selected` : null}
          active={atsSet.size > 0}
        >
          {() => (
            <>
              <PopHeading>ATS band</PopHeading>
              {atsBands.map((b) => (
                <PopRow
                  key={b.id}
                  kind="check"
                  selected={atsSet.has(b.id)}
                  count={atsCounts[b.id] ?? 0}
                  onClick={() => toggleMulti("ats", b.id)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
                    {b.label}
                    <span className="text-caption text-text-3">{b.range}</span>
                  </span>
                </PopRow>
              ))}
              {atsSet.size > 0 && (
                <div className="border-t border-border mt-1 pt-1 px-3 pb-1">
                  <button
                    type="button"
                    onClick={() => setOne("ats", "")}
                    className="text-caption text-[var(--brand)] hover:underline"
                  >
                    Clear
                  </button>
                </div>
              )}
            </>
          )}
        </Popover>

        {/* JD quality */}
        <Popover
          label="JD quality"
          value={jdSet.size > 0 ? `${jdSet.size} selected` : null}
          active={jdSet.size > 0}
        >
          {() => (
            <>
              <PopHeading>Description</PopHeading>
              <PopRow kind="check" selected={jdSet.has("full")} count={counts.richJd} onClick={() => toggleMulti("jd", "full")}>
                Full JD
              </PopRow>
              <PopRow kind="check" selected={jdSet.has("thin")} count={counts.thinJd} onClick={() => toggleMulti("jd", "thin")}>
                Thin JD
              </PopRow>
              {jdSet.size > 0 && (
                <div className="border-t border-border mt-1 pt-1 px-3 pb-1">
                  <button
                    type="button"
                    onClick={() => setOne("jd", "")}
                    className="text-caption text-[var(--brand)] hover:underline"
                  >
                    Clear
                  </button>
                </div>
              )}
            </>
          )}
        </Popover>

        {/* Sort — the only control that writes `sort` from this row */}
        <div className="ml-auto">
          <Popover
            label="Sort:"
            value={SORT_OPTIONS.find((o) => o.value === currentSort)?.label ?? "Date posted"}
            active={false}
            align="right"
          >
            {(close) => (
              <>
                <PopHeading>Sort by</PopHeading>
                {SORT_OPTIONS.filter((o) => o.group === "main").map((o) => (
                  <PopRow
                    key={o.value}
                    kind="radio"
                    selected={currentSort === o.value}
                    onClick={() => { setOne("sort", o.value); close(); }}
                  >
                    {o.label}
                  </PopRow>
                ))}
                <div className="border-t border-border my-1" />
                <PopHeading>Activity</PopHeading>
                {SORT_OPTIONS.filter((o) => o.group === "activity").map((o) => (
                  <PopRow
                    key={o.value}
                    kind="radio"
                    selected={currentSort === o.value}
                    onClick={() => { setOne("sort", o.value); close(); }}
                  >
                    {o.label}
                  </PopRow>
                ))}
              </>
            )}
          </Popover>
        </div>
      </div>

      {/* ── tokens — zero height when nothing is active ───────────────── */}
      {tokens.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap border-t border-border px-2.5 py-1.5">
          {tokens.map((t) => (
            <span
              key={t.key}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-[var(--surface-2)] px-2 py-0.5 text-caption text-text-2"
            >
              {t.label}
              <button
                type="button"
                onClick={t.onClear}
                aria-label={`Remove ${t.label} filter`}
                className="text-text-3 hover:text-text"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="ml-1 text-caption font-medium text-[var(--brand)] hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, count, disabled = false, icon, children,
}: {
  active:   boolean;
  onClick:  () => void;
  count:    number;
  disabled?: boolean;
  icon?:    "star";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={
        "inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-label transition-colors whitespace-nowrap " +
        (active
          ? "border-[var(--brand)] text-[var(--brand)] font-semibold"
          : disabled
            ? "border-transparent text-text-3 opacity-50 cursor-not-allowed"
            : "border-transparent text-text-2 hover:text-text font-medium")
      }
    >
      {icon === "star" && <Star className={`w-3 h-3 ${active ? "fill-current" : ""}`} />}
      {children}
      {count > 0 && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}
