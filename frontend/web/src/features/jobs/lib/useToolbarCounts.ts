"use client";

/**
 * Counts the toolbar needs, computed once and shared by both boards.
 *
 * The dashboard board and the per-profile board were already near-identical;
 * this stops the Option-D toolbar from adding a third and fourth copy of the
 * same memo to each of them.
 *
 * The rule these follow: a badge next to a filter must equal the number of rows
 * you get after clicking it. So every count is computed from the *current* view
 * with that one dimension released — not from the whole dataset, which would
 * promise 40 results and deliver 3 once an unrelated filter was already on.
 */

import { useMemo } from "react";
import { filterJobs, type AtsBand, type BoardJob } from "./jobFilters";
import { countAllViews } from "./boardViews";

export interface ToolbarCountInputs {
  stage:        string;
  triage:       string;
  jd:           string;
  minKeywords:  string;
  maxDistance:  string;
  minDistance:  string;
  sortCol:      string;
  employment?:  string;
  eligibleOnly?: string;
}

export function useToolbarCounts(jobs: BoardJob[], f: ToolbarCountInputs) {
  const {
    stage, triage, jd, minKeywords, maxDistance, minDistance,
    sortCol, employment = "", eligibleOnly = "",
  } = f;

  // ATS released — how many of the jobs you're currently looking at fall in
  // each band.
  const atsCountBase = useMemo(
    () => filterJobs(jobs, {
      stage, triage, jd, ats: "", minKeywords, maxDistance, minDistance,
      sort: sortCol, employment, eligibleOnly,
    }),
    [jobs, stage, triage, jd, minKeywords, maxDistance, minDistance, sortCol, employment, eligibleOnly],
  );

  const atsCounts = useMemo<Record<AtsBand, number>>(() => {
    const out: Record<AtsBand, number> = { above_final: 0, below_final: 0, below_initial: 0, no_ats: 0 };
    for (const j of atsCountBase) out[j.atsBand]++;
    return out;
  }, [atsCountBase]);

  // Distance released. Null distances pass every band — same rule filterJobs
  // uses, so these agree with the list.
  const distanceCountBase = useMemo(
    () => filterJobs(jobs, {
      stage, triage, jd, ats: "", minKeywords, maxDistance: "", minDistance: "",
      sort: sortCol, employment, eligibleOnly,
    }),
    [jobs, stage, triage, jd, minKeywords, sortCol, employment, eligibleOnly],
  );

  const distanceCounts = useMemo<Record<string, number>>(() => {
    const within = (km: number) =>
      distanceCountBase.filter((j) => j.distance_km == null || j.distance_km <= km).length;
    return {
      any:    distanceCountBase.length,
      "5":    within(5),
      "10":   within(10),
      "25":   within(25),
      "50":   within(50),
      over50: distanceCountBase.filter((j) => j.distance_km == null || j.distance_km >= 50).length,
    };
  }, [distanceCountBase]);

  // Saved views are absolute queries, so they count against the whole set —
  // a view badge answers "how many would this view show", not "how many of
  // what I'm looking at".
  const viewCounts = useMemo(() => countAllViews(jobs), [jobs]);

  return { atsCounts, distanceCounts, viewCounts };
}
