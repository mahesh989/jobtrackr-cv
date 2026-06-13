"use client";

/**
 * SmartFeed — card-based job board for the dashboard.
 *
 * Replaces the JobTable on /dashboard with a denser, scannable card layout
 * inspired by the /dashboard/beta/job-feed prototype. Reads the same URL
 * params as the legacy board so PipelineFunnel + SmartFilterBar continue to
 * drive filtering — this component is purely the presentation layer.
 *
 * Two modes:
 *   • No view filter active → smart sections (Today's picks · Closest ·
 *     Fresh today · Needs attention · Everything else), each with a
 *     coloured banner.
 *   • Any view filter active → flat card list, sorted by SmartFilterBar.
 *
 * Top of feed (always shown when ≥1 job has distance_km):
 *   • Distance ribbon — 0→max-km axis with every job plotted as a dot
 *     coloured by ATS band. Hover for title. Click jumps to the card.
 *
 * Cards carry: profile chip · title · company · location · distance ·
 * visa dot · source pill · ATS chip (band-coloured) · keyword chips ·
 * match-score bar · progress dots · Analyze button · ⋮ menu (Edit /
 * Mark applied / Dismiss). Apply + Dismiss reuse the JobTable's flash +
 * fade-collapse animations.
 *
 * The per-profile board still uses JobTable — this component is dashboard-only.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BarChart3, FileText, Mail, CheckCircle2, MoreHorizontal, Sparkles, MapPin,
  Clock, AlertTriangle, Inbox, FileWarning, FileQuestion, Loader2, X,
  Archive, Star,
} from "lucide-react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { markJobDismissed, bulkArchiveJobs, bulkStarJobs } from "@/lib/actions";
import { AnalyzeJobButton, FullAnalysisButton, triggerReanalyze } from "@/components/cv/AnalyzeJobButton";
import { JobEditModal } from "@/components/cv/JobEditModal";
import { jobNeedsJd, MANUAL_JD_MIN_CHARS, type BoardJob, type AtsBand, type JobGroup } from "./jobFilters";
import type { FunnelCounts } from "./PipelineFunnel";
import { SmartToolbar } from "./SmartToolbar";
import { SelectModeButton } from "./SelectModeButton";
import { shallowSetParams } from "./shallowNav";
import { type AtsThresholds } from "@/lib/atsThresholds";

// ── scoring ─────────────────────────────────────────────────────────────

/** 0–100 opinionated match score. Combines distance, ATS band, JD quality,
 *  freshness, visa hints. Shown as a bar on every card so the user can see
 *  *why* one job ranks above another. */
export function matchScore(j: BoardJob): number {
  let s = 50;
  if (j.distance_km != null) s += Math.max(0, 30 - j.distance_km * 0.7);
  if (j.atsBand === "above_final")        s += 28;
  else if (j.atsBand === "below_final")   s += 8;
  else if (j.atsBand === "below_initial") s -= 14;
  if (j.jd_quality === "thin") s -= 8;
  const posted = j.posted_at ? new Date(j.posted_at).getTime() : 0;
  if (posted) {
    const days = (Date.now() - posted) / 86400000;
    if (days < 1)       s += 8;
    else if (days > 21) s -= 6;
  }
  if (j.sponsorship_status === "yes")        s += 6;
  else if (j.sponsorship_status === "no")    s -= 10;
  if (j.citizen_pr_only)                     s -= 8;
  if (j.applied_at)   s = Math.min(s, 5);
  if (j.dismissed_at) s = Math.min(s, 5);
  return Math.max(0, Math.min(100, Math.round(s)));
}

// ── time helpers (mirror JobTable) ──────────────────────────────────────

function relativeDate(d: string | null): string | null {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Parse a string param to an int, clamp to [lo, hi], fall back to default. */
function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function isPostedToday(j: BoardJob): boolean {
  if (!j.posted_at) return false;
  const d = new Date(j.posted_at);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
      && d.getMonth()    === now.getMonth()
      && d.getDate()     === now.getDate();
}

// ── ATS band visuals (mirrors lib/atsThresholds) ────────────────────────

// Job-card badge labels — kept numeric/range here because the card prefixes
// "ATS " before the label (`AtsChip` below). The filter chips in SmartToolbar
// use friendlier "ATS Above / Fair / Below" labels — those own their own
// "ATS " prefix and live in atsBands there.
const ATS_BAND_META: Record<AtsBand, { label: string; dot: string; chipBg: string; chipText: string; barColor: string; tip: string }> = {
  above_final:   { label: "≥ 70",  dot: "bg-green-500", chipBg: "bg-green-100",          chipText: "text-green-800", barColor: "bg-green-500", tip: "Passed final gate — auto cover letter eligible" },
  below_final:   { label: "60–69", dot: "bg-amber-500", chipBg: "bg-amber-100",          chipText: "text-amber-800", barColor: "bg-amber-500", tip: "Tailored CV — between gates" },
  below_initial: { label: "< 60",  dot: "bg-red-500",   chipBg: "bg-red-100",            chipText: "text-red-800",   barColor: "bg-red-500",   tip: "Below initial gate — pipeline stopped" },
  no_ats:        { label: "—",     dot: "bg-gray-300",  chipBg: "bg-[var(--surface-2)]", chipText: "text-text-2",    barColor: "bg-gray-400",  tip: "Not yet analysed" },
};

export function getAtsMeta(job: { atsBand: AtsBand; atsThresholds?: { initial: number; final: number } }) {
  const band = job.atsBand;
  const th = job.atsThresholds ?? { initial: 60, final: 70 };
  const staticMeta = ATS_BAND_META[band];

  // Per-vertical range labels for the card (e.g. "< 40" for healthcare).
  // AtsChip renders these as `ATS ${label}` so the prefix is added there.
  if (band === "above_final") {
    return {
      ...staticMeta,
      label: `≥ ${th.final}`,
      tip: `Passed final gate (${th.final}) — auto cover letter eligible`,
    };
  }
  if (band === "below_final") {
    return {
      ...staticMeta,
      label: `${th.initial}–${th.final - 1}`,
      tip: `Tailored CV — between gates (${th.initial}–${th.final - 1})`,
    };
  }
  if (band === "below_initial") {
    return {
      ...staticMeta,
      label: `< ${th.initial}`,
      tip: `Below initial gate (${th.initial}) — pipeline stopped`,
    };
  }
  return staticMeta;
}

const VISA_COLOR = { yes: "#22c55e", no: "#ef4444", pr_only: "#f59e0b", unknown: "#94a3b8" };
const VISA_LABEL = { yes: "Sponsored", no: "No sponsor", pr_only: "PR or citizens only", unknown: "Visa not mentioned" };

function visaKey(j: BoardJob): keyof typeof VISA_COLOR {
  if (j.citizen_pr_only === true) return "pr_only";
  if (j.sponsorship_status === "yes") return "yes";
  if (j.sponsorship_status === "no")  return "no";
  return "unknown";
}

function sourcePillTone(source: string): string {
  const m: Record<string, string> = {
    adzuna:    "bg-blue-100 text-blue-700",
    seek:      "bg-blue-100 text-blue-700",
    careerjet: "bg-teal-100 text-teal-700",
    greenhouse:"bg-purple-100 text-purple-700",
    lever:     "bg-purple-100 text-purple-700",
    indeed:    "bg-amber-100 text-amber-700",
  };
  return m[source.toLowerCase()] ?? "bg-[var(--surface-2)] text-text-2";
}

// ── smart-section bucketing ─────────────────────────────────────────────

function pickScore(j: BoardJob): number {
  // Same shape as matchScore but tuned for ranking "today's picks".
  return matchScore(j);
}

interface FeedSection {
  /** Built-in smart-section ids OR a custom string for grouped views
   *  (time/distance buckets surfaced by JobBoard). */
  id: string;
  label: string;
  caption: string;
  tone: "brand" | "green" | "amber" | "muted";
  Icon: typeof Sparkles;
  jobs: BoardJob[];
  hero?: boolean; // render top picks with the elevated hero card
}

/** Ascending-distance comparator. Null distances sink to the bottom so an
 *  unresolved location can't claim a top slot inside any section. */
function byDistanceAsc(a: BoardJob, b: BoardJob): number {
  const aNull = a.distance_km == null;
  const bNull = b.distance_km == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return (a.distance_km as number) - (b.distance_km as number);
}

function bucketJobs(jobs: BoardJob[]): FeedSection[] {
  if (jobs.length === 0) return [];
  const active = jobs.filter((j) => !j.applied_at && !j.dismissed_at);
  const placed = new Set<string>();

  // Picks: rank by pickScore (today's best), then break ties by distance.
  const picks = [...active]
    .sort((a, b) => {
      const d = pickScore(b) - pickScore(a);
      return d !== 0 ? d : byDistanceAsc(a, b);
    })
    .slice(0, 3);
  picks.forEach((j) => placed.add(j.id));

  const closest = active
    .filter((j) => !placed.has(j.id) && j.distance_km != null && j.distance_km <= 15)
    .sort(byDistanceAsc);
  closest.forEach((j) => placed.add(j.id));

  // Every other section also sorts by distance ascending so the dashboard
  // reads consistently top-to-bottom — closest first, unknown distance last.
  const fresh = active
    .filter((j) => !placed.has(j.id) && isPostedToday(j))
    .sort(byDistanceAsc);
  fresh.forEach((j) => placed.add(j.id));

  const attention = active
    .filter((j) => !placed.has(j.id) && jobNeedsJd(j))
    .sort(byDistanceAsc);
  attention.forEach((j) => placed.add(j.id));

  const rest = jobs.filter((j) => !placed.has(j.id)).sort(byDistanceAsc);

  const out: FeedSection[] = [];
  if (picks.length     > 0) out.push({ id: "picks",     label: "Today's picks",   caption: "Best matches across distance, ATS band, and freshness", tone: "brand", Icon: Sparkles,      jobs: picks, hero: true });
  if (closest.length   > 0) out.push({ id: "closest",   label: "Closest to you",  caption: "Within 15 km of a profile's home address",               tone: "green", Icon: MapPin,        jobs: closest });
  if (fresh.length     > 0) out.push({ id: "fresh",     label: "Fresh today",     caption: "Posted in the last 24 hours",                            tone: "brand", Icon: Clock,         jobs: fresh });
  if (attention.length > 0) out.push({ id: "attention", label: "Needs attention", caption: "Thin JDs — open and paste the full description",         tone: "amber", Icon: AlertTriangle, jobs: attention });
  if (rest.length      > 0) out.push({ id: "rest",      label: "Everything else", caption: "",                                                       tone: "muted", Icon: Inbox,         jobs: rest });
  return out;
}

// ── component ───────────────────────────────────────────────────────────

// ── bulk-select (iOS/Google style) ───────────────────────────────────────
// Checkboxes are HIDDEN by default and only appear when the user explicitly
// enters "select mode" via contextual "Select" buttons — one per smart-section
// heading (Today's picks, Closest to you, …) and one above the first card when
// a sort/stage/ATS filter flattens the feed. Toolbar no longer hosts Select.
interface JobSelectionCtx {
  selectMode: boolean;
  isSelected: (id: string) => boolean;
  toggle:     (id: string) => void;
}
const JobSelectionContext = createContext<JobSelectionCtx | null>(null);

export function SmartFeed({
  jobs,
  groups,
  hasActiveFilter,
  currentTab,
  counts,
  atsCounts,
  homeAddress = null,
  thresholds,
}: {
  /** Pre-filtered + pre-sorted by the parent board. */
  jobs:            BoardJob[];
  /** When provided, render the flat list as labelled groups (time / distance
   *  buckets) instead of a single sorted list. Total job count across groups
   *  should match `jobs`; the same id should not appear twice. */
  groups?:         JobGroup[];
  /** True when stage/triage/ATS view filters are active. Switches the feed
   *  from smart-section mode to flat-list mode. */
  hasActiveFilter: boolean;
  /** Current stage — passed to JobEditModal-aware children. */
  currentTab:      string;
  /** Stage counts for the toolbar's chip badges. */
  counts:          FunnelCounts;
  /** ATS-band counts derived from the *unfiltered* loaded set — drives the
   *  toolbar chip badges so users see what they can filter to. */
  atsCounts:       Record<AtsBand, number>;
  /** When set, the toolbar renders the "Within X km" distance select. */
  homeAddress?:    string | null;
  thresholds?:     AtsThresholds;
}) {
  const router = useRouter();

  // ── selection state (iOS/Google style) ──────────────────────────────────
  const [activeSelectModes, setActiveSelectModes] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmAnalyse, setConfirmAnalyse] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelledRef = useRef(false);

  const toggle = useCallback((id: string) => {
    setConfirmAnalyse(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectionValue = useMemo<JobSelectionCtx>(
    () => ({ selectMode: false, isSelected: (id) => selected.has(id), toggle }),
    [selected, toggle],
  );

  const toggleSelectMode = useCallback((sectionId: string, sectionJobs?: BoardJob[]) => {
    setActiveSelectModes((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
        // Clear selected jobs specifically from this section when cancelling its select mode
        if (sectionJobs) {
          setSelected((selPrev) => {
            const selNext = new Set(selPrev);
            sectionJobs.forEach(j => selNext.delete(j.id));
            return selNext;
          });
        }
      } else {
        next.add(sectionId);
      }
      return next;
    });
    setConfirmAnalyse(false);
  }, []);

  function exitAllSelectModes() {
    setActiveSelectModes(new Set());
    setSelected(new Set());
    setConfirmAnalyse(false);
    cancelledRef.current = true;
    setProgress(null);
  }

  const isAnySelectMode = activeSelectModes.size > 0;

  const [bulkPending, setBulkPending] = useState<"archive" | "star" | null>(null);

  // Optimistically-hidden job ids — keeps the just-archived rows out of the
  // rendered feed instantly, without waiting for router.refresh to bring back
  // a server-side payload that excludes them. Cleared on the next mount /
  // when `jobs` actually changes (i.e. the server roundtrip arrives).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // Reset hiddenIds when the upstream `jobs` array reference changes (server
  // refresh completed). Without this, a job re-archived later would still
  // appear briefly while the optimistic hide from a previous run lingers.
  const lastJobsRef = useRef(jobs);
  if (lastJobsRef.current !== jobs) {
    lastJobsRef.current = jobs;
    if (hiddenIds.size > 0) setHiddenIds(new Set());
  }

  async function runBulkArchive() {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkPending) return;
    setBulkPending("archive");
    // Hide first, ask questions later — gives instant feedback. If the action
    // fails we restore the hidden rows below.
    const idsSet = new Set(ids);
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    try {
      await bulkArchiveJobs(ids);
      exitAllSelectModes();
      router.refresh();
    } catch (e) {
      // Reveal again on failure so the user can retry / sees the row.
      setHiddenIds((prev) => {
        const next = new Set(prev);
        idsSet.forEach((id) => next.delete(id));
        return next;
      });
      throw e;
    } finally {
      setBulkPending(null);
    }
  }

  async function runBulkStar() {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkPending) return;
    setBulkPending("star");
    try {
      await bulkStarJobs(ids);
      exitAllSelectModes();
      router.refresh();
    } finally {
      setBulkPending(null);
    }
  }

  async function runBulkAnalyse() {
    const ids = Array.from(selected);
    if (ids.length === 0 || progress) return;
    cancelledRef.current = false;
    setProgress({ done: 0, total: ids.length });
    let idx = 0;
    let done = 0;
    const worker = async () => {
      while (idx < ids.length && !cancelledRef.current) {
        const id = ids[idx++];
        try {
          // override=all → bypass the initial gate + thin-JD precheck so every
          // selected job is fully analysed regardless of cutoffs.
          await fetch(`/api/jobs/${id}/analyze?override=all`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    "{}",
          });
        } catch {
          /* best-effort — keep going */
        }
        if (!cancelledRef.current) {
          done++;
          setProgress({ done, total: ids.length });
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    if (!cancelledRef.current) {
      setProgress(null);
      exitAllSelectModes();
      router.refresh();
    }
  }

  // Ref map per job id so the distance ribbon can scroll to a card.
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  function scrollToJob(id: string) {
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-[var(--brand)]");
    setTimeout(() => el.classList.remove("ring-2", "ring-[var(--brand)]"), 1500);
  }

  // Apply the optimistic-hide filter before computing anything downstream.
  // hiddenIds only contains ids the user just bulk-archived; once router
  // .refresh delivers a `jobs` prop that already excludes them, the set is
  // cleared (see the lastJobsRef compare above) and this becomes a no-op.
  const visibleJobs = useMemo(
    () => (hiddenIds.size === 0 ? jobs : jobs.filter((j) => !hiddenIds.has(j.id))),
    [jobs, hiddenIds],
  );
  const visibleGroups = useMemo(() => {
    if (!groups || hiddenIds.size === 0) return groups;
    return groups
      .map((g) => ({ ...g, jobs: g.jobs.filter((j) => !hiddenIds.has(j.id)) }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, hiddenIds]);

  // Distance ribbon — only render when at least one job has a resolved
  // distance. The bucketing is profile-agnostic, but the chart still helps
  // spot clusters.
  const distanceMax = useMemo(() => {
    let max = 0;
    for (const j of visibleJobs) if (j.distance_km != null && j.distance_km > max) max = j.distance_km;
    return max;
  }, [visibleJobs]);

  // When no jobs, hide bulk actions toolbar and select options
  const hasJobs = visibleJobs.length > 0;

  return (
    <div className="space-y-5">
      <SmartToolbar
        counts={counts}
        atsCounts={atsCounts}
        homeAddress={homeAddress}
        thresholds={thresholds}
      />

      {visibleJobs.length === 0 ? (
        <EmptyState />
      ) : (
        <JobSelectionContext.Provider value={selectionValue}>
          <SmartFeedBody
            jobs={visibleJobs}
            groups={visibleGroups}
            hasActiveFilter={hasActiveFilter}
            currentTab={currentTab}
            distanceMax={distanceMax}
            cardRefs={cardRefs}
            scrollToJob={scrollToJob}
            activeSelectModes={activeSelectModes}
            onToggleSelectMode={hasJobs ? toggleSelectMode : undefined}
          />
        </JobSelectionContext.Provider>
      )}

      {/* Sticky bulk-action bar — appears once in select mode.
          Shows count, Analyse, Stop (during run), and Cancel to exit. */}
      {isAnySelectMode && (
        <div className="sticky bottom-4 z-30 mx-auto max-w-2xl rounded-lg border border-[var(--border)] bg-surface shadow-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-[13px] font-semibold text-text">
            {selected.size > 0 ? `${selected.size} selected` : "Tap jobs to select"}
          </span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {progress ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Analysing {progress.done}/{progress.total}…
                </span>
                {/* Stop mid-run — prevents remaining queued requests from firing.
                    Already-sent requests on the server will still complete. */}
                <button
                  onClick={exitAllSelectModes}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:text-red-700 border border-red-200 hover:border-red-300 bg-red-50 hover:bg-red-100 rounded-md px-2.5 py-1 transition-colors"
                  title="Stop queuing new analyses — already-sent requests will still complete"
                >
                  <X className="w-3.5 h-3.5" />
                  Stop
                </button>
              </>
            ) : confirmAnalyse ? (
              <>
                <span className="text-[12px] text-text-2">
                  Uses {selected.size} credit{selected.size !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={runBulkAnalyse}
                  className="gh-btn gh-btn-primary text-[12px] px-3 py-1 inline-flex items-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Confirm — analyse {selected.size}
                </button>
                <button
                  onClick={() => setConfirmAnalyse(false)}
                  className="text-[12px] text-text-3 hover:text-text px-2 py-1 transition-colors"
                >
                  Back
                </button>
              </>
            ) : (
              <>
                {selected.size > 0 && (
                  <>
                    <button
                      onClick={runBulkStar}
                      disabled={bulkPending !== null}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 border border-amber-200 hover:border-amber-300 bg-amber-50 hover:bg-amber-100 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                      title="Star selected jobs — adds to your favourites"
                    >
                      {bulkPending === "star"
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Star className="w-3.5 h-3.5" />}
                      Star
                    </button>
                    <button
                      onClick={runBulkArchive}
                      disabled={bulkPending !== null}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-2 hover:text-text border border-[var(--border)] hover:border-text-3 bg-[var(--surface-2)] hover:bg-[var(--surface)] rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                      title="Archive selected jobs — hides from the main view"
                    >
                      {bulkPending === "archive"
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Archive className="w-3.5 h-3.5" />}
                      Archive
                    </button>
                    <button
                      onClick={() => setConfirmAnalyse(true)}
                      disabled={bulkPending !== null}
                      className="gh-btn gh-btn-primary text-[12px] px-3 py-1 inline-flex items-center gap-1.5 disabled:opacity-50"
                      title="Analyse selected jobs — bypasses the initial gate"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Analyse {selected.size}
                    </button>
                  </>
                )}
                <button
                  onClick={exitAllSelectModes}
                  className="text-[12px] text-text-3 hover:text-text px-2 py-1 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Hook for cards to reach the selection context (null when not inside a feed). */
function useJobSelection(): JobSelectionCtx | null {
  return useContext(JobSelectionContext);
}

function SmartFeedBody({
  jobs, groups, hasActiveFilter, currentTab, distanceMax, cardRefs, scrollToJob,
  activeSelectModes, onToggleSelectMode,
}: {
  jobs: BoardJob[];
  groups?: JobGroup[];
  hasActiveFilter: boolean;
  currentTab: string;
  distanceMax: number;
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  scrollToJob: (id: string) => void;
  activeSelectModes: Set<string>;
  onToggleSelectMode?: (sectionId: string, sectionJobs?: BoardJob[]) => void;
}) {
  const sp       = useSearchParams();
  const pathname = usePathname();

  // Three rendering modes, in priority order:
  //   1. groups   → explicit time/distance bucketing (the parent decided)
  //   2. !filter  → smart sections (Today's picks · Closest · …)
  //   3. otherwise→ flat sorted list (the parent already sorted it)
  const groupSections: FeedSection[] | null = useMemo(() => {
    if (!groups || groups.length === 0) return null;
    return groups.map((g) => ({
      id:     g.id as FeedSection["id"],
      label:  g.label,
      caption: g.caption ?? "",
      tone:   "muted",
      Icon:   Inbox,
      jobs:   g.jobs,
    }));
  }, [groups]);

  const sections = useMemo(
    () => groupSections ?? (hasActiveFilter ? null : bucketJobs(jobs)),
    [groupSections, hasActiveFilter, jobs],
  );

  // Distance-range URL state for the ribbon's draggable handles. min_distance
  // and max_distance are both read by jobFilters, so dragging filters the
  // feed live without a server round-trip.
  // Axis is fixed at 50 km — outlier jobs (e.g., 900 km away) pin to the right
  // edge instead of stretching the tick scale into illegible overlap. Matches
  // the beta /dashboard/beta/job-feed prototype.
  const ribbonMax = 50;
  const minDist   = clampInt(sp.get("min_distance"), 0, ribbonMax, 0);
  const maxDist   = clampInt(sp.get("max_distance"), 0, ribbonMax, ribbonMax);
  const range: [number, number] = [minDist, maxDist];

  function setRange(r: [number, number]) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (r[0] > 0)         next.set("min_distance", String(r[0])); else next.delete("min_distance");
    if (r[1] < ribbonMax) next.set("max_distance", String(r[1])); else next.delete("max_distance");
    shallowSetParams(pathname, next);
  }

  return (
    <>
      {distanceMax > 0 && (
        <DistanceRibbon
          jobs={jobs}
          maxKm={ribbonMax}
          range={range}
          onRangeChange={setRange}
          onJobClick={scrollToJob}
        />
      )}

      {sections ? (
        <div className="space-y-7">
          {sections.map((sec) => (
            <FeedSectionView
              key={sec.id}
              section={sec}
              currentTab={currentTab}
              refSetter={(id) => (el: HTMLDivElement | null) => { cardRefs.current[id] = el; }}
              selectMode={activeSelectModes.has(sec.id)}
              onToggleSelectMode={onToggleSelectMode ? () => onToggleSelectMode(sec.id, sec.jobs) : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {onToggleSelectMode && (
            <div className="flex justify-end">
              <SelectModeButton selectMode={activeSelectModes.has("flat")} onToggle={() => onToggleSelectMode("flat", jobs)} />
            </div>
          )}
          <JobSelectionContext.Provider value={{ ...useJobSelection()!, selectMode: activeSelectModes.has("flat") }}>
            <div className="grid gap-2.5">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  currentTab={currentTab}
                  refSetter={(el) => { cardRefs.current[job.id] = el; }}
                />
              ))}
            </div>
          </JobSelectionContext.Provider>
        </div>
      )}
    </>
  );
}

// ── section ─────────────────────────────────────────────────────────────

function FeedSectionView({
  section, currentTab, refSetter, selectMode, onToggleSelectMode,
}: {
  section: FeedSection;
  currentTab: string;
  refSetter: (id: string) => (el: HTMLDivElement | null) => void;
  selectMode: boolean;
  onToggleSelectMode?: () => void;
}) {
  const parentCtx = useJobSelection();
  const selectionValue = useMemo(() => ({
    ...parentCtx!,
    selectMode
  }), [parentCtx, selectMode]);
  const toneClass: Record<FeedSection["tone"], string> = {
    brand: "text-[var(--brand)]",
    green: "text-green-600",
    amber: "text-amber-600",
    muted: "text-text-2",
  };
  const Icon = section.Icon;
  return (
    <JobSelectionContext.Provider value={selectionValue}>
      <section>
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <Icon className={`w-4 h-4 self-center shrink-0 ${toneClass[section.tone]}`} strokeWidth={2.5} />
          <h3 className="text-[15px] font-semibold text-text">{section.label}</h3>
          <span className="text-[12px] font-medium text-text-3 tabular-nums">{section.jobs.length}</span>
          {section.caption ? (
            <span className="text-[11px] text-text-3 truncate">— {section.caption}</span>
          ) : null}
        </div>
        {onToggleSelectMode && (
          <SelectModeButton selectMode={selectMode} onToggle={onToggleSelectMode} />
        )}
      </div>

      {section.hero ? (
        <div className="grid gap-2.5 sm:grid-cols-1 lg:grid-cols-3">
          {section.jobs.map((job) => (
            <HeroCard key={job.id} job={job} currentTab={currentTab} refSetter={refSetter(job.id)} />
          ))}
        </div>
      ) : (
        <div className="grid gap-2.5">
          {section.jobs.map((job) => (
            <JobCard key={job.id} job={job} currentTab={currentTab} refSetter={refSetter(job.id)} />
          ))}
        </div>
      )}
      </section>
    </JobSelectionContext.Provider>
  );
}

// ── distance ribbon ─────────────────────────────────────────────────────

/** "Distance from home" ribbon. Dots coloured by visa status (matches the
 *  beta — Sponsored / Unknown / PR only / No sponsor). Hover for the job
 *  title; click jumps to the matching card. Range handles let you bracket
 *  by km, writing min_distance + max_distance URL params (shallow nav so
 *  the feed re-filters instantly). */
function DistanceRibbon({ jobs, maxKm, range, onRangeChange, onJobClick }: {
  jobs: BoardJob[];
  maxKm: number;
  range: [number, number];
  onRangeChange: (r: [number, number]) => void;
  onJobClick: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<"min" | "max" | null>(null);

  // While dragging we keep the range in local state so the handles + dot-mute
  // update at 60fps without pushing every mousemove into the URL (which would
  // re-render every job card and could crash the tab). The URL is committed
  // once on mouseup.
  const [localRange, setLocalRange] = useState<[number, number]>(range);
  const localRangeRef = useRef(localRange);
  localRangeRef.current = localRange;

  // Sync local state when the URL changes from somewhere else (e.g. "clear").
  useEffect(() => { if (!dragging) setLocalRange(range); }, [range, dragging]);

  // Tick step adapts to the axis so we don't render 100 overlapping labels.
  // At 50 km we get 0/10/20/30/40/50 — same as the beta.
  const tickStep = maxKm <= 60 ? 10 : maxKm <= 200 ? 25 : 50;
  const ticks = Array.from(
    { length: Math.floor(maxKm / tickStep) + 1 },
    (_, i) => i * tickStep,
  );

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent | TouchEvent) {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const km = Math.round(pct * maxKm);
      const [lo, hi] = localRangeRef.current;
      if (dragging === "min") setLocalRange([Math.min(km, hi - 1), hi]);
      else                    setLocalRange([lo, Math.max(km, lo + 1)]);
    }
    function onUp() {
      setDragging(null);
      onRangeChange(localRangeRef.current);
    }
    window.addEventListener("mousemove",  onMove);
    window.addEventListener("mouseup",    onUp);
    window.addEventListener("touchmove",  onMove);
    window.addEventListener("touchend",   onUp);
    return () => {
      window.removeEventListener("mousemove",  onMove);
      window.removeEventListener("mouseup",    onUp);
      window.removeEventListener("touchmove",  onMove);
      window.removeEventListener("touchend",   onUp);
    };
  }, [dragging, maxKm, onRangeChange]);

  const displayRange = dragging ? localRange : range;
  const rangeActive  = displayRange[0] > 0 || displayRange[1] < maxKm;

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[11px] font-semibold text-text-2 uppercase tracking-wider">
          Distance from home
          {rangeActive && (
            <span className="text-text font-normal normal-case ml-1">
              · {displayRange[0]}–{displayRange[1]} km
              <button
                onClick={() => onRangeChange([0, maxKm])}
                className="ml-1 text-[var(--brand)] hover:underline"
              >clear</button>
            </span>
          )}
        </p>
        <div className="flex items-center gap-3 text-[10px] text-text-2">
          <Legend color={VISA_COLOR.yes}     label="Sponsored" />
          <Legend color={VISA_COLOR.unknown} label="Unknown" />
          <Legend color={VISA_COLOR.pr_only} label="PR only" />
          <Legend color={VISA_COLOR.no}      label="No sponsor" />
        </div>
      </div>

      <div ref={trackRef} className="relative h-14 select-none">
        <div className="absolute left-0 right-0 top-7 h-px bg-border" />
        <div
          className="absolute top-[26px] h-[3px] bg-[var(--brand)]/40 rounded"
          style={{
            left:  `${(displayRange[0] / maxKm) * 100}%`,
            width: `${((displayRange[1] - displayRange[0]) / maxKm) * 100}%`,
          }}
        />
        {ticks.map((t) => (
          <div key={t} className="absolute top-7" style={{ left: `${(t / maxKm) * 100}%` }}>
            <div className="w-px h-1.5 bg-border" />
            <div className="text-[9px] text-text-3 mt-1 -translate-x-1/2 whitespace-nowrap">{t} km</div>
          </div>
        ))}
        {jobs.filter((j) => j.distance_km != null).map((j, i) => {
          const km = j.distance_km as number;
          const x = (Math.min(km, maxKm) / maxKm) * 100;
          const y = 28 + ((i % 3) - 1) * 3;
          const muted = km < displayRange[0] || km > displayRange[1];
          const vk = visaKey(j);
          return (
            <button
              key={j.id}
              type="button"
              onClick={() => onJobClick(j.id)}
              title={`${j.title}\n${j.company ?? "—"} · ${j.location} · ${km.toFixed(1)} km · ${VISA_LABEL[vk]}`}
              className="absolute w-2.5 h-2.5 rounded-full hover:scale-150 transition-all shadow-sm"
              style={{
                left: `calc(${x}% - 5px)`,
                top:  `${y - 5}px`,
                background: VISA_COLOR[vk],
                borderColor: "white",
                borderWidth: 1,
                borderStyle: "solid",
                opacity: muted ? 0.25 : 1,
              }}
            />
          );
        })}
        <RangeHandle pos={(displayRange[0] / maxKm) * 100} onStart={() => setDragging("min")} label={`${displayRange[0]} km`} />
        <RangeHandle pos={(displayRange[1] / maxKm) * 100} onStart={() => setDragging("max")} label={`${displayRange[1]} km`} />
      </div>
    </div>
  );
}

function RangeHandle({ pos, onStart, label }: { pos: number; onStart: () => void; label: string }) {
  return (
    <button
      type="button"
      title={`Drag — ${label}`}
      onMouseDown={onStart}
      onTouchStart={onStart}
      className="absolute top-[20px] w-3 h-3 rounded-sm bg-white border-2 border-[var(--brand)] cursor-ew-resize hover:scale-125 transition-transform shadow"
      style={{ left: `calc(${pos}% - 6px)` }}
    />
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ── hero card (Today's picks) ───────────────────────────────────────────

function HeroCard({ job, currentTab, refSetter }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} hero>
      <CardChips job={job} />
      <CardTitle job={job} />
      <CardMeta job={job} />
      <div className="mt-2"><MatchBar job={job} /></div>
      <CardActions job={job} />
    </CardShell>
  );
}

// ── compact card ────────────────────────────────────────────────────────

function JobCard({ job, currentTab, refSetter }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter}>
      <div className="flex items-center gap-3.5 min-w-0">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${getAtsMeta(job).dot}`}
          title={`ATS ${getAtsMeta(job).label} — ${getAtsMeta(job).tip}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <CardTitle job={job} inline />
            <SourcePill source={job.source} />
            {job.profile_name && <ProfileChip name={job.profile_name} />}
            {jobNeedsJd(job) && <ChipWarn label="thin JD" tooltip="JD too short to analyse" />}
            {job.dedup_status === "possible_duplicate" && <ChipWarn label="dup?" tooltip="Possible duplicate" />}
          </div>
          <CardMeta job={job} compact />
          <div className="mt-2.5"><MatchBar job={job} compact /></div>
        </div>
        <CardActions job={job} compact />
      </div>
    </CardShell>
  );
}

// ── shared card chrome (handles flash/fade animations on apply/dismiss) ─

type ExitPhase = "idle" | "flash" | "fading" | "gone";

function CardShell({
  job, currentTab, refSetter, hero, children,
}: {
  job: BoardJob;
  currentTab: string;
  refSetter: (el: HTMLDivElement | null) => void;
  hero?: boolean;
  children: React.ReactNode;
}) {
  const [exit, setExit] = useState<ExitPhase>("idle");
  const [showEdit, setShowEdit] = useState(false);
  const [manualJd, setManualJd] = useState<string | null>(job.manual_jd_text ?? null);
  const [savedFlicker, setSavedFlicker] = useState(false);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [hiringMgr, setHiringMgr] = useState<string | null>(job.hiring_manager ?? null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(job.company_address ?? null);
  const [pending, setPending] = useState(false);

  const selection  = useJobSelection();
  const selectable = selection?.selectMode ?? false;  // checkboxes only in select mode
  const checked    = selection?.isSelected(job.id) ?? false;

  async function onDismiss() {
    if (exit !== "idle" || pending) return;
    setPending(true);
    setExit("fading");
    setTimeout(() => setExit("gone"), 450);
    try { await markJobDismissed(job.id, job.profile_id); }
    catch { setExit("idle"); }
    finally { setPending(false); }
  }

  if (exit === "gone") return null;

  const isFading = exit === "fading";
  const isFlash  = exit === "flash";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: isFading ? "0fr" : "1fr",
        opacity: isFading ? 0 : 1,
        transition: isFading ? "grid-template-rows 420ms ease, opacity 280ms ease" : undefined,
        overflow: "hidden",
        pointerEvents: exit !== "idle" ? "none" : undefined,
      }}
    >
      <div style={{ overflow: "hidden" }} className="relative">
        {/* Selection checkbox overlay — top-left, mirrors the Applications pool.
            Always reserves space (pl-10 below) so the title doesn't shift. */}
        {selectable && (
          <button
            type="button"
            onClick={() => selection!.toggle(job.id)}
            className={`absolute top-3 left-2.5 z-10 w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              checked
                ? "bg-[var(--brand)] border-[var(--brand)]"
                : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--brand)]"
            }`}
            aria-label={checked ? "Deselect job" : "Select job"}
          >
            {checked && <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
          </button>
        )}
        <div
          ref={refSetter}
          className={`rounded-md border transition-all ${
            hero ? "border-2 border-[var(--brand)]/30 bg-surface p-4 hover:shadow-md" : "border-border bg-surface px-4 py-3.5 hover:bg-[var(--surface-2)]/60"
          } ${selectable ? "pl-10" : ""} ${
            checked ? "ring-2 ring-[var(--brand)] border-[var(--brand)]" : ""
          } ${isFlash ? "bg-green-light border-green-500" : ""} ${savedFlicker ? "jd-saved-flicker" : ""} ${
            !!job.applied_at ? "border-l-2 border-l-green-500" : ""
          }`}
        >
          <CardActionsContext.Provider value={{ onDismiss, onEdit: () => setShowEdit(true), pending }}>
            {children}
          </CardActionsContext.Provider>
        </div>
      </div>

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          jobUrl={job.url}
          originalJd={job.description ?? ""}
          initialManual={manualJd}
          initialEmail={contactEmail}
          initialHiringMgr={hiringMgr}
          initialCompanyAddress={companyAddress}
          onClose={() => setShowEdit(false)}
          onSaved={(patch) => {
            // Flicker the card on the thin→filled JD flip so the user can see
            // which job they just fixed (they often lose their place).
            const wasThin = job.jd_quality === "thin" || job.jd_quality === "unknown";
            const nowFilled = (patch.manual_jd_text?.trim().length ?? 0) >= MANUAL_JD_MIN_CHARS;
            if (wasThin && nowFilled) {
              setSavedFlicker(true);
              // Keep the class on for the full 1.8s keyframe (globals.css).
              setTimeout(() => setSavedFlicker(false), 1900);
            }
            setManualJd(patch.manual_jd_text);
            setContactEmail(patch.contact_email);
            setHiringMgr(patch.hiring_manager);
            setCompanyAddress(patch.company_address);
          }}
        />
      )}
    </div>
  );
}

// Context so HeroCard/JobCard children can reach the shell's handlers.
const CardActionsContext = createContext<{
  onDismiss: () => Promise<void>;
  onEdit:    () => void;
  pending:   boolean;
}>({ onDismiss: async () => {}, onEdit: () => {}, pending: false });

// ── card sub-pieces ─────────────────────────────────────────────────────

function CardChips({ job }: { job: BoardJob }) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${getAtsMeta(job).dot}`}
        title={`ATS ${getAtsMeta(job).label} — ${getAtsMeta(job).tip}`}
      />
      <SourcePill source={job.source} />
      {job.profile_name && <ProfileChip name={job.profile_name} />}
      {job.atsBand !== "no_ats" && <AtsChip job={job} />}
      <span
        className="inline-block w-2 h-2 rounded-full ml-auto"
        style={{ background: VISA_COLOR[visaKey(job)] }}
        title={VISA_LABEL[visaKey(job)]}
      />
      <span className="text-[10px] text-text-3">{relativeDate(job.posted_at || job.created_at) ?? "—"}</span>
    </div>
  );
}

function CardTitle({ job, inline }: { job: BoardJob; inline?: boolean }) {
  return (
    <a
      href={job.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${inline ? "text-[13px]" : "text-[13px]"} font-semibold text-text hover:text-[var(--brand)] leading-snug ${inline ? "truncate" : "block mb-1.5"}`}
    >
      {job.title}
    </a>
  );
}

function CardMeta({ job, compact }: { job: BoardJob; compact?: boolean }) {
  // Show whichever dates we have. Posted date is the more relevant signal
  // for "is this fresh?", added is "when did the pipeline pick it up?".
  // Tooltips carry the absolute date so the user can hover for precision.
  const postedRel = relativeDate(job.posted_at);
  const addedRel  = relativeDate(job.created_at);
  return (
    <p className={`${compact ? "mt-1 text-[11.5px]" : "text-[11px]"} text-text-2 truncate`}>
      {job.company && <span className="font-medium">{job.company}</span>}
      {job.company && job.location && <span className="text-text-3"> · </span>}
      {job.location && <span>{job.location}</span>}
      {typeof job.distance_km === "number" && (
        <>
          <span className="text-text-3"> · </span>
          <Distance km={job.distance_km} method={job.distance_method ?? null} />
        </>
      )}
      {postedRel && (
        <>
          <span className="text-text-3"> · </span>
          <span title={`Posted ${new Date(job.posted_at as string).toLocaleDateString()}`}>
            Posted {postedRel.toLowerCase()}
          </span>
        </>
      )}
      {!postedRel && addedRel && (
        <>
          <span className="text-text-3"> · </span>
          <span title={`Added ${new Date(job.created_at as string).toLocaleDateString()}`}>
            Added {addedRel.toLowerCase()}
          </span>
        </>
      )}
      {jobNeedsJd(job) && (
        <span className="ml-2 inline-flex items-center gap-0.5 text-amber-600 align-middle">
          <FileWarning className="w-3 h-3 inline" /> <span className="text-[10px]">thin JD</span>
        </span>
      )}
      {job.jd_quality === "unknown" && (
        <span className="ml-2 inline-flex items-center text-text-3 align-middle">
          <FileQuestion className="w-3 h-3 inline" />
        </span>
      )}
    </p>
  );
}

function CardActions({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const { onDismiss, onEdit, pending } = useContext(CardActionsContext);
  return (
    <div
      className={`flex items-center gap-2 shrink-0 ${compact ? "" : "mt-2 justify-between"}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && <ProgressDots progress={job.progress} />}
      <div className="flex items-center gap-1.5">
        {compact && <ProgressDots progress={job.progress} />}
        {job.progress.latest_run_id ? (
          <FullAnalysisButton
            jobId={job.id}
            analysisHref={`/dashboard/jobs/${job.id}/analyze/${job.progress.latest_run_id}`}
          />
        ) : job.applied_at ? (
          <button
            disabled
            className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] border border-border px-2.5 py-1 text-xs font-medium text-text-3 cursor-not-allowed"
            title="This job was manually marked as applied and has no analysis run."
          >
            No Analysis
          </button>
        ) : (
          <AnalyzeJobButton jobId={job.id} hasAnalysis={job.progress.has_analysis} />
        )}
        <CardMenu
          job={job}
          onDismiss={onDismiss}
          onEdit={onEdit}
          pending={pending}
        />
      </div>
    </div>
  );
}

// ── overflow menu ───────────────────────────────────────────────────────

function CardMenu({
  job, onDismiss, onEdit, pending,
}: {
  job:       BoardJob;
  onDismiss: () => void;
  onEdit:    () => void;
  pending:   boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [reanalysePending, setReanalysePending] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((v) => !v);
  }
  useEffect(() => {
    if (!open) return;
    function onAway(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onAway);
    return () => document.removeEventListener("mousedown", onAway);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label="More actions"
        className="p-1 rounded hover:bg-[var(--surface-2)] text-text-3 disabled:opacity-40"
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, right: pos.right }}
          className="z-50 min-w-[160px] rounded-md border border-border bg-surface shadow-lg py-1 text-[12px]"
        >
          <MenuItem onClick={() => { setOpen(false); onEdit(); }}>Edit JD…</MenuItem>
          {job.progress.has_analysis && job.progress.latest_run_id && (
            <MenuItem
              onClick={async () => {
                setOpen(false);
                if (reanalysePending) return;
                setReanalysePending(true);
                try {
                  const run_id = await triggerReanalyze(job.id);
                  router.push(`/dashboard/jobs/${job.id}/analyze/${run_id}`);
                } catch { /* ignore */ } finally { setReanalysePending(false); }
              }}
              disabled={reanalysePending}
            >
              {reanalysePending ? "Starting…" : "Re-analyze"}
            </MenuItem>
          )}
          <MenuItem onClick={() => { setOpen(false); onDismiss(); }}>Dismiss</MenuItem>
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-2)] disabled:text-text-3 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

// ── tiny presentational primitives ──────────────────────────────────────

function MatchBar({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const hasAnalysis = job.atsBand !== "no_ats";
  if (!hasAnalysis) return null;

  // For analysed jobs show the REAL ATS score (tailored if available, else
  // initial).
  const atsScore    = job.tailored_match_score ?? job.initial_ats_score ?? null;
  const displayScore = atsScore ?? 0;
  const label        = atsScore != null ? "ATS" : "Match";

  const cls = hasAnalysis
    ? getAtsMeta(job).barColor
    : (displayScore >= 70 ? "bg-green-500" : displayScore >= 50 ? "bg-amber-500" : "bg-red-500");

  const tip = atsScore != null
    ? `ATS score ${displayScore}/100 — ${getAtsMeta(job).tip}`
    : `Match score ${displayScore}/100 — combines distance, ATS band, JD quality, freshness, visa hints`;

  return (
    <div className="flex items-center gap-1.5" title={tip}>
      {!compact && (
        <span className="text-[9px] font-semibold text-text-3 shrink-0 uppercase tracking-wide w-7 text-right">
          {label}
        </span>
      )}
      <div className={`relative bg-[var(--surface-2)] rounded-full overflow-hidden ${compact ? "h-1" : "h-1.5"} flex-1`}>
        <div className={`h-full ${cls}`} style={{ width: `${displayScore}%` }} />
      </div>
      <span className={`tabular-nums font-semibold text-text-2 shrink-0 ${compact ? "text-[10px]" : "text-[11px]"}`}>
        {displayScore}
      </span>
    </div>
  );
}

function ProgressDots({ progress }: { progress: BoardJob["progress"] }) {
  const items = [
    { on: progress.has_analysis,      Icon: BarChart3,    cls: "text-blue-600",   label: "Analysed" },
    { on: progress.has_tailored_cv,   Icon: FileText,     cls: "text-purple-600", label: "Tailored CV" },
    { on: progress.has_cover_letter,  Icon: Mail,         cls: "text-amber-600",  label: "Cover letter" },
    { on: progress.is_applied,        Icon: CheckCircle2, cls: "text-green-600",  label: "Applied" },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, cls, label }, i) => (
        <Icon
          key={i}
          className={`w-3.5 h-3.5 ${on ? cls : "text-text-3 opacity-30"}`}
          strokeWidth={on ? 2.5 : 1.5}
          aria-label={label}
        />
      ))}
    </div>
  );
}

function ProfileChip({ name }: { name: string }) {
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-[var(--surface-2)] text-text-2 border border-border"
      title={`Found via the "${name}" search profile`}
    >
      {name}
    </span>
  );
}

function SourcePill({ source }: { source: string }) {
  return (
    <span
      className={`text-[9px] uppercase font-semibold tracking-wide px-1.5 py-px rounded shrink-0 ${sourcePillTone(source)}`}
      title={`Source: ${source}`}
    >
      {source}
    </span>
  );
}

function AtsChip({ job }: { job: BoardJob }) {
  const meta = getAtsMeta(job);
  return (
    <span
      title={meta.tip}
      className={`text-[10px] font-semibold px-1.5 py-px rounded shrink-0 ${meta.chipBg} ${meta.chipText}`}
    >
      ATS {meta.label}
    </span>
  );
}

function ChipWarn({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <span
      title={tooltip}
      className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-amber-100 text-amber-800"
    >
      {label}
    </span>
  );
}

function Distance({ km, method }: { km: number; method: "driving" | "haversine" | null }) {
  const approx = method === "haversine";
  const tone = km <= 10 ? "text-green-600" : km <= 25 ? "text-text-2" : km <= 50 ? "text-amber-600" : "text-red-600";
  const display = km < 10 ? km.toFixed(1) : Math.round(km);
  return (
    <span
      className={`tabular-nums font-medium ${tone}`}
      title={approx ? "Straight-line estimate" : "Driving distance from your home address"}
    >
      {approx ? "~" : ""}{display} km
    </span>
  );
}

function EmptyState() {
  return (
    <div className="bg-surface border border-border rounded-md">
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-lg bg-[var(--surface-2)] border border-border flex items-center justify-center mb-4">
          <Inbox className="w-5 h-5 text-text-3" />
        </div>
        <p className="text-[14px] font-semibold text-text mb-1">No jobs match your filters</p>
        <p className="text-[12px] text-text-2">Adjust the filters above or run the pipeline to fetch new listings.</p>
      </div>
    </div>
  );
}
