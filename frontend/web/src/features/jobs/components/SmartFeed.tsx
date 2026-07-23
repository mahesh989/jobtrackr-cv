"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Sparkles, MapPin,
  Clock, AlertTriangle, Inbox } from "lucide-react";
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

function bucketJobs(jobs: BoardJob[]): FeedSection[] {
  if (jobs.length === 0) return [];
  const active = jobs.filter((j) => !j.applied_at && !j.dismissed_at);
  const placed = new Set<string>();

  const closest = active
    .filter((j) => !placed.has(j.id) && j.distance_km != null && j.distance_km <= 15)
    .sort(byDistanceAsc);
  closest.forEach((j) => placed.add(j.id));

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
  if (closest.length   > 0) out.push({ id: "closest",   label: "Closest to you",  caption: "Within 15 km of a profile's home address",               tone: "green", Icon: MapPin,        jobs: closest });
  if (fresh.length     > 0) out.push({ id: "fresh",     label: "Fresh today",     caption: "Posted in the last 24 hours",                            tone: "brand", Icon: Clock,         jobs: fresh });
  if (attention.length > 0) out.push({ id: "attention", label: "Needs attention", caption: "Thin JDs — open and paste the full description",         tone: "amber", Icon: AlertTriangle, jobs: attention });
  if (rest.length      > 0) out.push({ id: "rest",      label: "Everything else", caption: "",                                                       tone: "muted", Icon: Inbox,         jobs: rest });
  return out;
}

// ── bulk-select context ─────────────────────────────────────────────────

export function SmartFeed({
  jobs, groups, hasActiveFilter, currentTab, counts, atsCounts,
  homeAddress = null, thresholds, excludeKeywords }: {
  jobs:            BoardJob[];
  groups?:         JobGroup[];
  hasActiveFilter: boolean;
  currentTab:      string;
  counts:          FunnelCounts;
  atsCounts:       Record<AtsBand, number>;
  homeAddress?:    string | null;
  thresholds?:     AtsThresholds;
  excludeKeywords?: string;
}) {
  const router = useRouter();
  const sp     = useSearchParams();
  const isFavouriteFilter = sp.get("stage") === "favourite";

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
    () => ({ selectMode: false, isSelected: (id) => selected.has(id), toggle, setMany }),
    [selected, toggle, setMany],
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
  const [prevJobs, setPrevJobs] = useState(jobs);
  if (prevJobs !== jobs) {
    setPrevJobs(jobs);
    if (hiddenIds.size > 0) setHiddenIds(new Set());
  }

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
    () => (hiddenIds.size === 0 ? jobs : jobs.filter((j) => !hiddenIds.has(j.id))),
    [jobs, hiddenIds],
  );
  const visibleGroups = useMemo(() => {
    if (!groups || hiddenIds.size === 0) return groups;
    return groups
      .map((g) => ({ ...g, jobs: g.jobs.filter((j) => !hiddenIds.has(j.id)) }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, hiddenIds]);

  const distanceMax = useMemo(() => {
    let max = 0;
    for (const j of visibleJobs) if (j.distance_km != null && j.distance_km > max) max = j.distance_km;
    return max;
  }, [visibleJobs]);

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
        <EmptyState favourite={isFavouriteFilter} />
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
            excludeKeywords={excludeKeywords}
          />
        </JobSelectionContext.Provider>
      )}

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
  );
}

// ── feed body ───────────────────────────────────────────────────────────

function SmartFeedBody({
  jobs, groups, hasActiveFilter, currentTab, distanceMax, cardRefs, scrollToJob,
  activeSelectModes, onToggleSelectMode, excludeKeywords }: {
  jobs: BoardJob[];
  groups?: JobGroup[];
  hasActiveFilter: boolean;
  currentTab: string;
  distanceMax: number;
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  scrollToJob: (id: string) => void;
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
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
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

