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
  notApplied:   string;
  minKeywords:  string;
  maxDistance:  string;
  minDistance:  string;
  sortCol:      string;
  employment?:  string;
  eligibleOnly?: string;
  postedWithin?: string;
}

export function useToolbarCounts(jobs: BoardJob[], f: ToolbarCountInputs) {
  const {
    stage, triage, jd, notApplied, minKeywords, maxDistance, minDistance,
    sortCol, employment = "", eligibleOnly = "", postedWithin = "",
  } = f;

  const atsCountBase = useMemo(
    () => filterJobs(jobs, {
      stage, triage, jd, notApplied, ats: "", minKeywords, maxDistance, minDistance,
      sort: sortCol, employment, eligibleOnly, postedWithin,
    }),
    [jobs, stage, triage, jd, notApplied, minKeywords, maxDistance, minDistance, sortCol, employment, eligibleOnly, postedWithin],
  );

  const atsCounts = useMemo<Record<AtsBand, number>>(() => {
    const out: Record<AtsBand, number> = { above_final: 0, below_final: 0, below_initial: 0, no_ats: 0 };
    for (const j of atsCountBase) out[j.atsBand]++;
    return out;
  }, [atsCountBase]);

  const viewCounts = useMemo(() => countAllViews(jobs), [jobs]);

  // DATE segment badges: same one-dimension-released rule as atsCounts, with
  // the date window as the released dimension. `any` = the current view with
  // no date window at all.
  const postedWithinCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {
      any: filterJobs(jobs, { ...f, ats: "", postedWithin: "" }).length,
    };
    for (const d of [1, 3, 7]) {
      out[String(d)] = filterJobs(jobs, { ...f, ats: "", postedWithin: String(d) }).length;
    }
    return out;
  }, [jobs, f]);

  return { atsCounts, viewCounts, postedWithinCounts };
}
