/**
 * Public interface of the jobs feature — exactly the symbols the app/
 * pages consume. Feature internals stay importable only by path (and
 * cross-feature imports deliberately stay direct to avoid module cycles).
 */
export { AddButton } from "./components/AddButton";
export { JobBoard } from "./components/JobBoard";
export { NotificationsToggle } from "./components/NotificationsToggle";
export { type FunnelCounts } from "./components/PipelineFunnel";
export { ProfileJobBoard } from "./components/ProfileJobBoard";
export { ScrollToJobsOnFilter } from "./components/ScrollToJobsOnFilter";
export { deriveBoardJob } from "./lib/boardDerivation";
export { type BoardJob, jobNeedsJd, normalizeWorkTypes, passesWorkTypes } from "./lib/jobFilters";
export { recomputeGates } from "./lib/pipelineState";
export { type AnalysisRunRef, type CoverLetterRef, indexLatestByJob } from "./lib/progressFlags";
