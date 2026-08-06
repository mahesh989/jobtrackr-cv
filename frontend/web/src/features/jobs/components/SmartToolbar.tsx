"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { X, ChevronDown, Search, Star } from "lucide-react";
import type { FunnelCounts } from "./PipelineFunnel";
import type { AtsBand } from "../lib/jobFilters";
import { FILTER_LABELS } from "../lib/jobFilters";
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

/* ── popover (Sort only) ───────────────────────────────────────────────── */

function Popover({
  label, value, active, children, align = "left",
}: {
  label:    string;
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
          ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-fg)]" />
          : <span className="text-[var(--brand-fg)] text-[9px] leading-none font-bold">\u2713</span>)}
      </span>
      <span className="flex-1 min-w-0">{children}</span>
      {count != null && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}

/* ── inline filter chip ────────────────────────────────────────────────── */

function FilterChip({
  active, onClick, dot, children, count,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-label font-medium transition-colors whitespace-nowrap " +
        (active
          ? "border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)]"
          : "border-border text-text-2 hover:bg-[var(--surface-2)]")
      }
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      {children}
      {count != null && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}

/* ── toolbar ────────────────────────────────────────────────────────────── */

export function SmartToolbar({
  counts,
  atsCounts,
  viewCounts = {},
}: {
  counts:    FunnelCounts;
  atsCounts: Record<AtsBand, number>;
  viewCounts?:     Record<string, number>;
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

  function toggleMulti(key: "ats" | "jd", value: string) {
    const cur = new Set((sp.get(key) || "").split(",").filter(Boolean));
    if (cur.has(value)) cur.delete(value); else cur.add(value);
    setOne(key, Array.from(cur).join(","));
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
    commit(next, "stage");
  }

  const atsBands: { id: AtsBand; label: string; dot: string }[] = [
    { id: "above_final",   label: "Above", dot: "bg-green-500" },
    { id: "below_final",   label: "Fair",  dot: "bg-amber-500" },
    { id: "below_initial", label: "Below", dot: "bg-red-500"   },
  ];

  /* ── active-filter tokens ───────────────────────────────────────────── */
  interface Token { key: string; label: string; onClear: () => void }
  const tokens: Token[] = [];

  if (currentStage) {
    tokens.push({
      key: "stage",
      label: FILTER_LABELS[currentStage] ?? currentStage,
      onClear: () => setOne("stage", ""),
    });
  }
  if (sp.get("triage")) {
    const t = sp.get("triage")!;
    tokens.push({ key: "triage", label: FILTER_LABELS[t] ?? t, onClear: () => setOne("triage", "") });
  }
  for (const band of atsSet) {
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
  if (sp.get("not_applied") === "1") {
    tokens.push({ key: "notApplied", label: "Not yet applied", onClear: () => setOne("not_applied", "") });
  }
  if (currentLocation) {
    tokens.push({ key: "loc", label: `\u201c${currentLocation}\u201d`, onClear: () => setOne("location", "") });
  }

  const atsAllSelected = atsBands.every((b) => atsSet.has(b.id));
  const jdBothSelected = jdSet.has("full") && jdSet.has("thin");

  return (
    <div className="rounded-md border border-border bg-surface overflow-visible">
      {/* Row 1 — funnel tabs (left) + saved views (right, after divider) */}
      <div className="flex items-center flex-wrap px-2.5 border-b border-border">
        <div className="flex items-center gap-0.5">
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

        <span aria-hidden className="mx-2 h-5 w-px bg-border" />

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

      {/* Row 2 — search + sort */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
        <div className="relative flex-1 min-w-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
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
            className="field w-full text-label py-1.5"
            // `.field`'s own `padding: 8px 10px` shorthand (globals.css) lives
            // outside Tailwind's layer and wins the cascade over `pl-8`/`pr-8`
            // at equal specificity — without the inline override here, the
            // search icon and the text/placeholder both sat at the same 10px
            // offset instead of the icon making room for the text.
            style={{ paddingLeft: 32, paddingRight: 32 }}
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

        <div className="shrink-0">
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

      {/* Row 3 — ATS band (left) + JD quality (right) */}
      <div className="flex items-center gap-2 flex-wrap px-2.5 py-2">
        <span className="text-label font-medium text-text-2 shrink-0">ATS Band</span>
        {atsBands.map((b) => (
          <FilterChip
            key={b.id}
            active={atsSet.has(b.id)}
            onClick={() => toggleMulti("ats", b.id)}
            dot={b.dot}
            count={atsCounts[b.id] ?? 0}
          >
            {b.label}
          </FilterChip>
        ))}
        {atsSet.size > 0 && !atsAllSelected && (
          <button
            type="button"
            onClick={() => setOne("ats", "")}
            className="text-caption text-[var(--brand)] hover:underline shrink-0"
          >
            Clear
          </button>
        )}

        <span className="ml-auto" />

        <span className="text-label font-medium text-text-2 shrink-0">Job Description</span>
        <FilterChip active={jdSet.has("full")} onClick={() => toggleMulti("jd", "full")} count={counts.richJd}>
          Full JD
        </FilterChip>
        <FilterChip active={jdSet.has("thin")} onClick={() => toggleMulti("jd", "thin")} count={counts.thinJd}>
          Thin JD
        </FilterChip>
        {jdSet.size > 0 && !jdBothSelected && (
          <button
            type="button"
            onClick={() => setOne("jd", "")}
            className="text-caption text-[var(--brand)] hover:underline shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {/* Row 4 — tokens */}
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
      {children}
      {count > 0 && <span className="tabular-nums text-caption text-text-3">{count}</span>}
    </button>
  );
}
