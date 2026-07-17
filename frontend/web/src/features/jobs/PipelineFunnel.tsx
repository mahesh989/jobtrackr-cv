/**
 * FunnelCounts — the shared count-by-stage shape used across the jobs UI
 * (SmartToolbar, SmartFeed, JobBoard, ProfileJobBoard, dashboard pages).
 *
 * The PipelineFunnel component that originally lived in this file (a
 * horizontal connected bar showing jobs flowing through pipeline stages —
 * "replaces StatusTabs + ProgressChips + TriageBanner") was removed: it was
 * never rendered anywhere (SmartToolbar's own comment says it "replaces
 * PipelineFunnel + SmartFilterBar"), only this type survived as the shared
 * counts shape. Kept in this file rather than moved, since 6+ files already
 * import FunnelCounts from here.
 */
export interface FunnelCounts {
  discovered: number;
  analysed: number;
  cvReady: number;
  letterReady: number;
  applied: number;
  dismissed: number;
  favourite: number;
  newCount: number;
  needsJd: number;      // kept for compat
  roleMismatch: number;
  belowThreshold: number;
  hasEmail: number;
  thinJd: number;
  richJd: number;
}
