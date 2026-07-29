/**
 * Saved views — named queries that set several filters at once.
 *
 * Once a board has more than about four filter dimensions, the bottleneck stops
 * being "how fast can I set a filter" and becomes "how do I get back to the
 * combination I run every morning". Linear, Jira and Stripe all answer that the
 * same way, with named views above the filter bar, and this is that.
 *
 * Definitions live here rather than in the toolbar because two things need
 * them: the toolbar (to render and apply them) and the board (to count how many
 * jobs each one would show). Counting runs the view's filters through the same
 * `filterJobs` the board itself uses, so a view's badge can never disagree with
 * what clicking it produces.
 */

import { filterJobs, type BoardJob, type ViewFilters } from "./jobFilters";

export interface BoardView {
  id:    string;
  label: string;
  /** Tooltip — spells out the query, since the label deliberately doesn't. */
  hint:  string;
  /** URL params this view sets. Every key in VIEW_PARAM_KEYS that is absent
   *  here is cleared on activation, so views never inherit a stale filter from
   *  whatever was on screen before. */
  params: Record<string, string>;
}

/**
 * Every param a view may own. Switching views clears all of these first.
 *
 * `location` is deliberately NOT in this list: it narrows the dataset rather
 * than the view, and silently dropping someone's search text when they click a
 * view would read as a bug.
 */
export const VIEW_PARAM_KEYS = [
  "stage", "triage", "ats", "jd", "not_applied",
  "max_distance", "min_distance", "min_keywords",
  "sort", "dir",
] as const;

/**
 * Every view sets `not_applied`. A view answers "what should I work on next",
 * and a job you already applied to is finished — it was showing up because the
 * stage filters describe what a job HAS (a cover letter) rather than what is
 * left to do with it.
 */
export const BOARD_VIEWS: BoardView[] = [
  {
    id:    "ready",
    label: "Ready to apply",
    hint:  "Analysed, ATS above the final gate, full job description — best score first",
    params: { stage: "analysed", ats: "above_final", jd: "full", not_applied: "1", sort: "ats_score", dir: "desc" },
  },
  {
    id:    "near",
    label: "Close & strong",
    hint:  "ATS above the final gate, within 10 km — nearest first",
    params: { ats: "above_final", max_distance: "10", not_applied: "1", sort: "distance" },
  },
];

/** The view's params expressed as the filter shape `filterJobs` consumes. */
export function viewFilters(view: BoardView): ViewFilters {
  const p = view.params;
  return {
    stage:       p.stage       ?? "",
    triage:      p.triage      ?? "",
    ats:         p.ats         ?? "",
    jd:          p.jd          ?? "",
    notApplied:  p.not_applied ?? "",
    minKeywords: p.min_keywords ?? "",
    maxDistance: p.max_distance ?? "",
    minDistance: p.min_distance ?? "",
    sort:        p.sort        ?? "",
  };
}

export function countView(jobs: BoardJob[], view: BoardView): number {
  return filterJobs(jobs, viewFilters(view)).length;
}

export function countAllViews(jobs: BoardJob[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of BOARD_VIEWS) out[v.id] = countView(jobs, v);
  return out;
}

/**
 * A view is active when every param it owns matches exactly — both the ones it
 * sets and the ones it expects to be absent. Anything looser would light up
 * "Ready to apply" while the user was looking at a hand-built query that merely
 * overlapped it.
 */
export function isViewActive(view: BoardView, sp: URLSearchParams): boolean {
  return VIEW_PARAM_KEYS.every((k) => (sp.get(k) ?? "") === (view.params[k] ?? ""));
}

/** Params for activating `view`, preserving everything a view doesn't own. */
export function paramsForView(view: BoardView, sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(Array.from(sp.entries()));
  for (const k of VIEW_PARAM_KEYS) next.delete(k);
  for (const [k, v] of Object.entries(view.params)) if (v) next.set(k, v);
  return next;
}
