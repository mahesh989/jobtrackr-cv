"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { X, ChevronDown, Search, Star } from "lucide-react";
import type { FunnelCounts } from "./PipelineFunnel";
import type { AtsBand } from "../lib/jobFilters";
import { BOARD_VIEWS, isViewActive, paramsForView, VIEW_PARAM_KEYS } from "../lib/boardViews";
import { shallowSetParams } from "../lib/shallowNav";

const SORT_OPTIONS = [
  { value: "posted_at",           label: "Date posted",        group: "main" },
  { value: "created_at",          label: "Date added",         group: "main" },
  { value: "ats_score",           label: "ATS score",          group: "main" },
  { value: "distance",            label: "Distance (nearest)", group: "main" },
  { value: "last_analysed",       label: "Recently analysed",  group: "activity" },
  { value: "recently_progressed", label: "Recently progressed", group: "activity" },
  { value: "most_progressed",     label: "Most progressed",    group: "activity" },
] as const;

interface FunnelTab {
  id:       string;
  label:    string;
  kind:     "stage" | "ats";
  value:    string;
  countKey?: keyof FunnelCounts;
}

const FUNNEL_TABS: FunnelTab[] = [
  { id: "notAnalysed", label: "Not analysed", kind: "ats",   value: "no_ats" },
  { id: "analysed",    label: "Analysed",     kind: "stage", value: "analysed", countKey: "analysed" },
  { id: "dismissed",   label: "Archive",      kind: "stage", value: "dismissed", countKey: "dismissed" },
];

const SHALLOW_KEYS = new Set([
  "stage", "triage", "ats", "jd", "sort", "dir",
  "min_keywords", "max_distance", "min_distance", "employment", "eligible",
]);

// DATE segment (handoff §2.3): single-select posted-window. Values are DAYS —
// the `posted_within` param the server's dataset query already understands
// (getDashboardData: posted_at >= now − N days).
const DATE_OPTIONS = [
  { value: "", label: "Any" },
  { value: "1", label: "24h" },
  { value: "3", label: "3d" },
  { value: "7", label: "7d" },
] as const;

/* ── popover (Sort only) ───────────────────────────────────────────────── */

function Popover({
  label, value, children, align = "left",
}: {
  label:    string;
  value?:   string | null;
  children: (close: () => void) => React.ReactNode;
  align?:   "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Passed to `children` — just flips the open flag. Refs are only ever
  // touched from effects/handlers below, never from a value handed to a
  // render-prop that gets invoked during render itself.
  const close = () => setOpen(false);

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

  // While open: move focus into the panel (first menu item). On close —
  // Escape, outside click, or an item being picked — this effect's cleanup
  // returns focus to the trigger, the menu-button pattern's expected
  // behaviour, without reading the ref during render.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      '[role="menuitemradio"], [role="menuitemcheckbox"]',
    );
    first?.focus();
    const trigger = triggerRef.current;
    return () => {
      trigger?.focus();
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={panelId}
        className={
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--surface-2)] px-3 py-[7px] text-[12.5px] font-medium text-text-2 hover:text-text hover:border-[var(--brand)]/35 transition-colors whitespace-nowrap"
        }
      >
        {label}
        {value && <b className="font-semibold text-text">{value}</b>}
        <ChevronDown className={`w-3 h-3 text-text-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={label.replace(/:$/, "")}
          className={
            "absolute z-40 mt-1.5 min-w-[240px] rounded-[10px] border border-border bg-surface shadow-lg py-1 " +
            (align === "right" ? "right-0" : "left-0")
          }
        >
          {children(close)}
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
          ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-fg)]" />
          : <span className="text-[var(--brand-fg)] text-[9px] leading-none font-bold">\u2713</span>)}
      </span>
      <span className="flex-1 min-w-0">{children}</span>
      {count != null && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}

/* ── segmented facet (handoff §2.3) ─────────────────────────────────────
   One `.fseg` group pill: surface-2 background, joined buttons separated by
   1px inner borders, active = brand-tinted + bold. Live counts per segment.
   Demo numbers: buttons `padding: 5px 12px`, 12px text, label `--t-micro`
   (10px) 600 uppercase, letter-spacing 0.09em. */

function Facet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-micro font-semibold uppercase tracking-[0.09em] text-text-3">
        {label}
      </span>
      <div className="inline-flex border border-border rounded-full overflow-hidden bg-[var(--surface-2)]">
        {children}
      </div>
    </div>
  );
}

function Fseg({
  active, onClick, children, count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 border-r border-border last:border-r-0 px-3 py-[5px] text-label font-medium transition-colors whitespace-nowrap " +
        (active
          ? "bg-[var(--brand)]/10 text-[var(--brand)] font-semibold"
          : "text-text-2 hover:text-text")
      }
    >
      {children}
      {count != null && (
        <span className={"tabular-nums text-caption " + (active ? "text-[var(--brand)]" : "text-text-3")}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ── toolbar ────────────────────────────────────────────────────────────── */

export function SmartToolbar({
  counts,
  atsCounts,
  viewCounts = {},
  postedWithinCounts = {},
}: {
  counts:    FunnelCounts;
  atsCounts: Record<AtsBand, number>;
  viewCounts?:     Record<string, number>;
  postedWithinCounts?: Record<string, number>;
}) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentStage  = sp.get("stage")    || "";
  const currentAtsRaw = sp.get("ats")      || "";
  const currentJdRaw  = sp.get("jd")       || "";
  const currentSort   = sp.get("sort")     || "posted_at";
  const currentLocation = sp.get("location") || "";
  // `posted_within` is a dataset filter (server refetch), so "any" means the
  // param absent — a stale "any" in the URL would just no-op server-side.
  const currentDate   = sp.get("posted_within") || "";

  const atsSet = new Set(currentAtsRaw.split(",").filter(Boolean));
  const jdSet  = new Set(currentJdRaw.split(",").filter(Boolean));

  function commit(params: URLSearchParams, key: string) {
    if (SHALLOW_KEYS.has(key)) shallowSetParams(pathname, params);
    else startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  function setOne(key: string, value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value) next.set(key, value); else next.delete(key);
    commit(next, key);
  }

  /** Single-select facet semantics (demo `applyAts`/`applyJd`): clicking the
   *  active segment clears it back to "Any"; clicking another moves it. The
   *  URL still stores a bare value (or comma-list from legacy links), which
   *  filterJobs already parses either way. */
  function selectOne(key: "ats" | "jd", value: string) {
    const cur = sp.get(key) || "";
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (cur === value) next.delete(key); else next.set(key, value);
    commit(next, key);
  }

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
    // Dataset filters are dataset filters: the date window clears with the
    // rest (it's part of "what am I looking at"), while `location` stays —
    // it narrows the fetch rather than the view, same rule as boardViews.
    next.delete("posted_within");
    commit(next, "stage");
  }

  // ATS range labels reflect the app's real gates (MIN_INITIAL_ATS 60,
  // MIN_FINAL_ATS 70 — atsThresholds.ts). The demo painted 50–69/<50 for its
  // mock banding (initial gate 50); 60–69/<60 is the same shape with the
  // app's actual threshold.
  const atsBands: { id: AtsBand; label: string }[] = [
    { id: "above_final",   label: "70+" },
    { id: "below_final",   label: "60–69" },
    { id: "below_initial", label: "<60" },
  ];

  // Demo's Clear-filters visibility rule: any active view/facet — tab,
  // saved view, date window, ATS or JD segment. Sort and search don't count
  // (the demo's `hasFilters`; location stays out on purpose — it narrows
  // the fetch, and clearAll below deliberately keeps it).
  const hasFacets = !!currentStage
    || !!sp.get("triage")
    || !!currentDate
    || atsSet.size > 0
    || jdSet.size > 0
    || !!sp.get("not_applied");

  return (
    <div>
      {/* Row 1 — funnel tabs (left) + saved views (right, after divider).
          Own full-width row with a bottom border — the demo's `.tabs-row`. */}
      <div className="flex items-center flex-wrap border-b border-border">
        <div className="flex items-center gap-0.5" role="group" aria-label="Filter by status">
          <TabButton active={allTabActive} onClick={() => selectTab(null)} count={counts.discovered}>
            All
          </TabButton>
          {FUNNEL_TABS.map((tab) => {
            const active = isTabActive(tab);
            const count  = tab.kind === "ats"
              ? atsCounts[tab.value as AtsBand] ?? 0
              : counts[tab.countKey!] ?? 0;
            return (
              <TabButton
                key={tab.id}
                active={active}
                onClick={() => selectTab(tab)}
                count={count}
                disabled={count === 0 && !active}
              >
                {tab.label}
              </TabButton>
            );
          })}
        </div>

        <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />

        <div className="flex items-center gap-1">
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
      </div>

      {/* Filter card (handoff §2.3) — demo `.filter-bar` numbers: surface
          card, radius +2px (14px), padding 12px 14px, column gap 10px,
          margin-top 12px. */}
      <div className="mt-3 rounded-[14px] border border-border bg-surface p-3 px-3.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
            <input
              key={currentLocation}
              type="text"
              defaultValue={currentLocation}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== currentLocation) setOne("location", v);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="Location or company…"
              className="field w-full text-body py-[10px] rounded-[12px]"
              // `.field`'s own `padding: 8px 10px` shorthand (globals.css) lives
              // outside Tailwind's layer and wins the cascade over `pl-8`/`pr-8`
              // at equal specificity — without the inline override here, the
              // search icon and the text/placeholder both sat at the same 10px
              // offset instead of the icon making room for the text.
              style={{ paddingLeft: 36, paddingRight: 36 }}
            />
            {currentLocation && (
              <button
                onClick={() => setOne("location", "")}
                disabled={pending}
                aria-label="Clear location filter"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-3 hover:text-text"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort pill — demo `.sort-btn`: 12.5px, surface-2, 999px,
              padding 7px 12px. */}
          <div className="shrink-0">
            <Popover
              label="Sort:"
              value={SORT_OPTIONS.find((o) => o.value === currentSort)?.label ?? "Date posted"}
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

          {/* ✕ Clear filters — demo `.clear-filters`: caption (11px) 600,
              brand, padding 7px 8px, top row, shown only when something is
              actually active (see hasFacets). */}
          {hasFacets && (
            <button
              type="button"
              onClick={clearAll}
              title="Clear all filters"
              className="inline-flex items-center gap-1.5 text-caption font-semibold text-[var(--brand)] px-2 py-[7px] rounded-lg hover:bg-[var(--brand)]/8 transition-colors whitespace-nowrap"
            >
              <X className="w-3.5 h-3.5" />
              Clear filters
            </button>
          )}
        </div>

        {/* Facet segments — demo `.facet-row`: 22px gaps, each facet a label
            (uppercase 10px) + one joined pill group with live counts. */}
        <div className="flex items-center gap-[22px] flex-wrap">
          <Facet label="Date">
            {DATE_OPTIONS.map((o) => (
              <Fseg
                key={o.value}
                active={currentDate === o.value}
                onClick={() => setOne("posted_within", o.value)}
                count={o.value ? (postedWithinCounts[o.value] ?? 0) : undefined}
              >
                {o.label}
              </Fseg>
            ))}
          </Facet>

          <Facet label="ATS">
            {atsBands.map((b) => (
              <Fseg
                key={b.id}
                active={atsSet.has(b.id)}
                onClick={() => selectOne("ats", b.id)}
                count={atsCounts[b.id] ?? 0}
              >
                {b.label}
              </Fseg>
            ))}
          </Facet>

          <Facet label="JD">
            <Fseg active={jdSet.has("full")} onClick={() => selectOne("jd", "full")} count={counts.richJd}>
              Full
            </Fseg>
            <Fseg active={jdSet.has("thin")} onClick={() => selectOne("jd", "thin")} count={counts.thinJd}>
              Thin
            </Fseg>
          </Facet>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, count, disabled = false, children,
}: {
  active:   boolean;
  onClick:  () => void;
  count:    number;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={
        "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-label transition-colors whitespace-nowrap " +
        (active
          ? "border-[var(--brand)] text-[var(--brand)] font-semibold"
          : disabled
            ? "border-transparent text-text-3 opacity-50 cursor-not-allowed"
            : "border-transparent text-text-2 hover:text-text font-medium")
      }
    >
      {children}
      {count > 0 && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}
