"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Sparkles, MapPin,
  Clock, AlertTriangle, Inbox, CheckCircle2 } from "lucide-react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { bulkArchiveJobs, bulkStarJobs } from "@/lib/actions/jobs";
import { jobNeedsJd, type BoardJob, type AtsBand, type JobGroup } from "../lib/jobFilters";
import type { FunnelCounts } from "./PipelineFunnel";
import { SmartToolbar } from "./SmartToolbar";
import { SelectModeButton, SelectAllButton } from "./SelectModeButton";
import { JobSelectionContext, useJobSelection, type JobSelectionCtx } from "./feedSelection";
import { HeroCard, JobCard, EmptyState } from "./FeedCards";
import { shallowSetParams } from "../lib/shallowNav";
import { type AtsThresholds } from "@/lib/atsThresholds";
import {
  clampInt, isPostedToday, byDistanceAsc } from "@/features/jobs/lib/smartFeedUtils";
import { DistanceRibbon } from "./DistanceRibbon";
import { BulkActionBar } from "./BulkActionBar";
import { BoardDetailPanel, EmptyDetail } from "./detail/BoardDetailPanel";

// ── smart-section bucketing ─────────────────────────────────────────────

interface FeedSection {
  id: string;
  label: string;
  caption: string;
  tone: "brand" | "green" | "amber" | "muted";
  Icon: typeof Sparkles;
  jobs: BoardJob[];
  hero?: boolean;
}

/**
 * Split the (already sorted) feed into the default smart sections.
 *
 * Two rules that were previously broken and are load-bearing:
 *
 *  1. EVERY bucket is drawn from `active`. "Everything else" used to be built
 *     from the full list, so every applied job fell through into it — which is
 *     why a job you applied to 3 km away showed up under "Everything else"
 *     instead of anywhere sensible. Applied jobs now get their own section at
 *     the bottom rather than being silently mixed into the working set.
 *
 *  2. Only "Closest to you" re-sorts, because proximity is the entire reason
 *     that section exists. The others keep the order they came in with, which
 *     is the board's chosen sort. Re-sorting all four by distance is what made
 *     the default "Date posted" look like it did nothing — the list was always
 *     distance-ordered no matter what the toolbar said.
 */
function bucketJobs(jobs: BoardJob[]): FeedSection[] {
  if (jobs.length === 0) return [];
  const active  = jobs.filter((j) => !j.applied_at && !j.dismissed_at);
  const applied = jobs.filter((j) => j.applied_at && !j.dismissed_at);
  const placed  = new Set<string>();

  const closest = active
    .filter((j) => j.distance_km != null && j.distance_km <= 15)
    .sort(byDistanceAsc);
  closest.forEach((j) => placed.add(j.id));

  const fresh = active.filter((j) => !placed.has(j.id) && isPostedToday(j));
  fresh.forEach((j) => placed.add(j.id));

  const attention = active.filter((j) => !placed.has(j.id) && jobNeedsJd(j));
  attention.forEach((j) => placed.add(j.id));

  const rest = active.filter((j) => !placed.has(j.id));

  const out: FeedSection[] = [];
  if (closest.length   > 0) out.push({ id: "closest",   label: "Closest to you",  caption: "Within 15 km of a profile's home address",       tone: "green", Icon: MapPin,        jobs: closest });
  if (fresh.length     > 0) out.push({ id: "fresh",     label: "Fresh today",     caption: "Posted in the last 24 hours",                    tone: "brand", Icon: Clock,         jobs: fresh });
  if (attention.length > 0) out.push({ id: "attention", label: "Needs attention", caption: "Thin JDs — open and paste the full description", tone: "amber", Icon: AlertTriangle, jobs: attention });
  if (rest.length      > 0) out.push({ id: "rest",      label: "Everything else", caption: "Further out, and not posted today",              tone: "muted", Icon: Inbox,         jobs: rest });
  if (applied.length   > 0) out.push({ id: "applied",   label: "Already applied", caption: "You've sent an application for these",           tone: "muted", Icon: CheckCircle2,  jobs: applied });
  return out;
}

// ── bulk-select context ─────────────────────────────────────────────────

export function SmartFeed({
  jobs, groups, hasActiveFilter, currentTab, counts, atsCounts,
  viewCounts, distanceCounts,
  homeAddress = null, thresholds, excludeKeywords }: {
  jobs:            BoardJob[];
  groups?:         JobGroup[];
  hasActiveFilter: boolean;
  currentTab:      string;
  counts:          FunnelCounts;
  atsCounts:       Record<AtsBand, number>;
  /** Saved-view and distance-option badge counts — computed by the board from
   *  the unfiltered job set, since this component only ever sees the filtered one. */
  viewCounts?:     Record<string, number>;
  distanceCounts?: Record<string, number>;
  homeAddress?:    string | null;
  thresholds?:     AtsThresholds;
  excludeKeywords?: string;
}) {
  const router   = useRouter();
  const sp       = useSearchParams();
  const pathname = usePathname();
  const isFavouriteFilter = sp.get("stage") === "favourite";

  const selectedJobId = sp.get("job");
  const openDetail = useCallback((id: string) => {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.set("job", id);
    shallowSetParams(pathname, next);
  }, [sp, pathname]);
  // `apply=1` is a one-shot request the detail header consumes and strips. It
  // rides the URL rather than a callback because the header is mounted twice
  // (desktop + mobile twins) and neither instance is a child of the card.
  const openDetailAndApply = useCallback((id: string) => {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.set("job", id);
    next.set("apply", "1");
    shallowSetParams(pathname, next);
  }, [sp, pathname]);

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

  const setMany = useCallback((ids: string[], select: boolean) => {
    setConfirmAnalyse(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (select) ids.forEach((id) => next.add(id));
      else        ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const selectionValue = useMemo<JobSelectionCtx>(
    () => ({
      selectMode: false,
      isSelected: (id) => selected.has(id),
      toggle, setMany,
      onOpenDetail: openDetail,
      onOpenDetailAndApply: openDetailAndApply,
      activeJobId:  selectedJobId,
    }),
    [selected, toggle, setMany, openDetail, openDetailAndApply, selectedJobId],
  );

  const toggleSelectMode = useCallback((sectionId: string, sectionJobs?: BoardJob[]) => {
    setActiveSelectModes((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
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

  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // Field-level optimistic overrides for rows the detail pane has just changed
  // (applied, mostly). The pane deliberately refreshes only its own payload —
  // router.refresh() would refetch the server-rendered board and throw away its
  // scroll position — which left the card on the left contradicting the pane on
  // the right until the next navigation. Cleared wholesale when a genuinely new
  // `jobs` array arrives, same as hiddenIds.
  const [jobPatches, setJobPatches] = useState<Record<string, Partial<BoardJob>>>({});
  const patchJob = useCallback((id: string, patch: Partial<BoardJob>) => {
    setJobPatches((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const [prevJobs, setPrevJobs] = useState(jobs);
  if (prevJobs !== jobs) {
    setPrevJobs(jobs);
    if (hiddenIds.size > 0) setHiddenIds(new Set());
    if (Object.keys(jobPatches).length > 0) setJobPatches({});
  }

  const patchedJobs = useMemo(() => {
    if (Object.keys(jobPatches).length === 0) return jobs;
    return jobs.map((j) => {
      const patch = jobPatches[j.id];
      if (!patch) return j;
      const next = { ...j, ...patch };
      // pipelineState drives the card's chip and its footer button, and it is
      // derived server-side — so patching applied_at alone would flip the row's
      // accent but leave it still offering "Apply".
      if (patch.applied_at) next.pipelineState = "applied";
      return next;
    });
  }, [jobs, jobPatches]);

  async function runBulkArchive() {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkPending) return;
    setBulkPending("archive");
    const idsSet = new Set(ids);
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    try {
      await bulkArchiveJobs(ids);
      exitAllSelectModes();
      router.refresh();
    } catch (e) {
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
          await fetch(`/api/jobs/${id}/analyze?override=all`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    "{}" });
        } catch { /* best-effort */ }
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

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  function scrollToJob(id: string) {
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-[var(--brand)]");
    setTimeout(() => el.classList.remove("ring-2", "ring-[var(--brand)]"), 1500);
  }

  const visibleJobs = useMemo(
    () => (hiddenIds.size === 0 ? patchedJobs : patchedJobs.filter((j) => !hiddenIds.has(j.id))),
    [patchedJobs, hiddenIds],
  );
  const visibleGroups = useMemo(() => {
    if (!groups) return groups;
    if (hiddenIds.size === 0 && Object.keys(jobPatches).length === 0) return groups;
    const byId = new Map(patchedJobs.map((j) => [j.id, j]));
    return groups
      .map((g) => ({
        ...g,
        jobs: g.jobs.filter((j) => !hiddenIds.has(j.id)).map((j) => byId.get(j.id) ?? j),
      }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, hiddenIds, jobPatches, patchedJobs]);

  const distanceMax = useMemo(() => {
    let max = 0;
    for (const j of visibleJobs) if (j.distance_km != null && j.distance_km > max) max = j.distance_km;
    return max;
  }, [visibleJobs]);

  const hasJobs = visibleJobs.length > 0;

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

  // State rather than a ref: reading a ref during render is exactly the
  // cascading-render smell the lint config flags, and this value IS render
  // input — it decides which job the detail pane shows on first paint.
  // Assigning during render is the sanctioned derive-state pattern, and the
  // `=== null` guard makes it fire once (the first job stays selected even as
  // filtering reorders the list underneath).
  const [defaultJobId, setDefaultJobId] = useState<string | null>(null);
  if (!selectedJobId && hasJobs && defaultJobId === null) setDefaultJobId(visibleJobs[0].id);

  const resolvedJobId = selectedJobId ?? defaultJobId;

  const selectedJob = useMemo(
    () => {
      if (resolvedJobId) return visibleJobs.find((j) => j.id === resolvedJobId) ?? (visibleJobs[0] ?? null);
      return null;
    },
    [visibleJobs, resolvedJobId],
  );

  function closeDetail() {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.delete("job");
    shallowSetParams(pathname, next);
  }


  return (
    <div className="space-y-5">
      <SmartToolbar
        counts={counts}
        atsCounts={atsCounts}
        viewCounts={viewCounts}
        distanceCounts={distanceCounts}
        homeAddress={homeAddress}
        thresholds={thresholds}
      />

      {distanceMax > 0 && (
        <DistanceRibbon
          jobs={visibleJobs}
          maxKm={ribbonMax}
          range={range}
          onRangeChange={setRange}
          onJobClick={scrollToJob}
        />
      )}

      <div className="flex gap-0 -mx-4 sm:-mx-6">
        <div className="w-[440px] min-w-[400px] shrink-0 bg-[var(--bg)] border-r border-border self-start" style={{ height: "calc(100vh - 2rem)" }}>
          <div className="h-full flex flex-col">
            {/* The feed's own scroller — the outer main column doesn't move
                with it, so ScrollRestoration has to know about this one to put
                the user back on the card they were reading. */}
            <div data-scroll-container="board-list" className="flex-1 overflow-y-auto p-5 pb-7">
              {visibleJobs.length === 0 ? (
                <EmptyState favourite={isFavouriteFilter} />
              ) : (
                <JobSelectionContext.Provider value={selectionValue}>
                  <SmartFeedBody
                    jobs={visibleJobs}
                    groups={visibleGroups}
                    hasActiveFilter={hasActiveFilter}
                    currentTab={currentTab}
                    cardRefs={cardRefs}
                    activeSelectModes={activeSelectModes}
                    onToggleSelectMode={hasJobs ? toggleSelectMode : undefined}
                    excludeKeywords={excludeKeywords}
                  />
                </JobSelectionContext.Provider>
              )}
            </div>

            <BulkActionBar
              selectedCount={selected.size}
              isAnySelectMode={isAnySelectMode}
              progress={progress}
              confirmAnalyse={confirmAnalyse}
              bulkPending={bulkPending}
              onStar={runBulkStar}
              onArchive={runBulkArchive}
              onConfirmAnalyse={runBulkAnalyse}
              onSetConfirmAnalyse={setConfirmAnalyse}
              onStop={exitAllSelectModes}
            />
          </div>
        </div>

        <div
          className="hidden lg:block flex-1 min-w-[540px] bg-surface self-start overflow-hidden"
          style={{ height: "calc(100vh - 2rem)" }}
        >
          {selectedJob
            ? <BoardDetailPanel job={selectedJob} onClose={closeDetail} onPatchJob={patchJob} />
            : <EmptyDetail />}
        </div>
      </div>

      {selectedJob && (
        <div className="lg:hidden">
          <BoardDetailPanel job={selectedJob} onClose={closeDetail} onPatchJob={patchJob} mobile />
        </div>
      )}
    </div>
  );
}

// ── feed body ───────────────────────────────────────────────────────────

function SmartFeedBody({
  jobs, groups, hasActiveFilter, currentTab, cardRefs,
  activeSelectModes, onToggleSelectMode, excludeKeywords }: {
  jobs: BoardJob[];
  groups?: JobGroup[];
  hasActiveFilter: boolean;
  currentTab: string;
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  activeSelectModes: Set<string>;
  onToggleSelectMode?: (sectionId: string, sectionJobs?: BoardJob[]) => void;
  excludeKeywords?: string;
}) {
  const sp       = useSearchParams();
  const pathname = usePathname();
  const parentSelection = useJobSelection()!;

  const groupSections: FeedSection[] | null = useMemo(() => {
    if (!groups || groups.length === 0) return null;
    return groups.map((g) => ({
      id:     g.id as FeedSection["id"],
      label:  g.label,
      caption: g.caption ?? "",
      tone:   "muted",
      Icon:   Inbox,
      jobs:   g.jobs }));
  }, [groups]);

  const sections = useMemo(
    () => groupSections ?? (hasActiveFilter ? null : bucketJobs(jobs)),
    [groupSections, hasActiveFilter, jobs],
  );

  return (
    <>
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
              excludeKeywords={excludeKeywords}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {onToggleSelectMode && (
            <div className="flex justify-end gap-2">
              {activeSelectModes.has("flat") && jobs.length > 0 && (
                <SelectAllButton
                  allSelected={jobs.every((j) => parentSelection.isSelected(j.id))}
                  onToggle={() => {
                    const allSelected = jobs.every((j) => parentSelection.isSelected(j.id));
                    parentSelection.setMany(jobs.map((j) => j.id), !allSelected);
                  }}
                />
              )}
              <SelectModeButton selectMode={activeSelectModes.has("flat")} onToggle={() => onToggleSelectMode("flat", jobs)} />
            </div>
          )}
          <JobSelectionContext.Provider value={{ ...parentSelection, selectMode: activeSelectModes.has("flat") }}>
            <div className="grid gap-2.5">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  currentTab={currentTab}
                  refSetter={(el) => { cardRefs.current[job.id] = el; }}
                  excludeKeywords={excludeKeywords}
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
  section, currentTab, refSetter, selectMode, onToggleSelectMode, excludeKeywords }: {
  section: FeedSection;
  currentTab: string;
  refSetter: (id: string) => (el: HTMLDivElement | null) => void;
  selectMode: boolean;
  onToggleSelectMode?: () => void;
  excludeKeywords?: string;
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
    muted: "text-text-2" };
  const Icon = section.Icon;
  return (
    <JobSelectionContext.Provider value={selectionValue}>
      <section>
      {/* Sticky within the board-list scroller, so the heading you are reading
          under ("Closest to you · Within 15 km") stays on screen for the whole
          run of cards it describes and is pushed off by the next section's own
          heading. The negative inline margins cancel the scroller's p-5 so the
          bar spans the full rail width and cards pass underneath it rather than
          beside it. */}
      <div className="sticky -top-5 z-10 -mx-5 px-5 pt-6 pb-2 -mt-1 mb-2.5 bg-[var(--bg)] border-b border-[var(--border-muted)] flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <Icon className={`w-4 h-4 self-center shrink-0 ${toneClass[section.tone]}`} strokeWidth={2.5} />
          <h3 className="text-lead font-semibold text-text">{section.label}</h3>
          <span className="text-label font-medium text-text-3 tabular-nums">{section.jobs.length}</span>
          {section.caption ? (
            <span className="text-caption text-text-3 truncate">— {section.caption}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {selectMode && section.jobs.length > 0 && (
            <SelectAllButton
              allSelected={section.jobs.every((j) => selectionValue.isSelected(j.id))}
              onToggle={() => {
                const allSelected = section.jobs.every((j) => selectionValue.isSelected(j.id));
                selectionValue.setMany(section.jobs.map((j) => j.id), !allSelected);
              }}
            />
          )}
          {onToggleSelectMode && (
            <SelectModeButton selectMode={selectMode} onToggle={onToggleSelectMode} />
          )}
        </div>
      </div>

      {section.hero ? (
        <div className="grid gap-2.5 sm:grid-cols-1 lg:grid-cols-3">
          {section.jobs.map((job) => (
            <HeroCard key={job.id} job={job} currentTab={currentTab} refSetter={refSetter(job.id)} excludeKeywords={excludeKeywords} />
          ))}
        </div>
      ) : (
        <div className="grid gap-2.5">
          {section.jobs.map((job) => (
            <JobCard key={job.id} job={job} currentTab={currentTab} refSetter={refSetter(job.id)} excludeKeywords={excludeKeywords} />
          ))}
        </div>
      )}
      </section>
    </JobSelectionContext.Provider>
  );
}

// ── hero card ───────────────────────────────────────────────────────────

