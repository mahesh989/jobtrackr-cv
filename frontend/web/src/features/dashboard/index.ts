/**
 * Public interface of the dashboard feature — exactly the symbols the app/
 * pages consume. Feature internals stay importable only by path (and
 * cross-feature imports deliberately stay direct to avoid module cycles).
 */
export { BackButton } from "./BackButton";
export { PipelineDonut, type PipelineLensData } from "./PipelineDonut";
export { StatCards } from "./StatCards";
