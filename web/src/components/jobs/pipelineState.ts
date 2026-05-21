/**
 * Job-board pipeline state derivation.
 *
 * Pure function — no React, no Supabase. Takes raw job/run/letter row
 * data and returns the single most-specific pipeline state. Mirrors
 * progressFlags.deriveProgress in spirit.
 *
 * Why: avoids storing pipeline_state as a denormalised column with
 * trigger maintenance. Single source of truth, computed at read time.
 * Performance is fine at hundreds-of-jobs scale; we can denormalise
 * later if scale demands it.
 *
 * Precedence (highest first — earliest match wins):
 *   archived         → job.dismissed_at IS NOT NULL
 *   applied          → job.applied_at   IS NOT NULL
 *   ready_to_send    → cover letter completed AND has_email
 *   ready_to_apply   → cover letter completed AND NOT has_email
 *   below_final      → analysis_run.passed_final_gate === false   (Phase C)
 *   below_initial    → analysis_run.passed_initial_gate === false (Phase C)
 *   analysing        → analysis_run.status === 'running'
 *   role_mismatch    → job.role_match === 'mismatch'
 *   needs_jd         → job.jd_quality === 'thin'
 *   discovered       → fallback (default — nothing happening yet)
 *
 * Phase B note: below_final / below_initial / role_mismatch states are
 * VISIBLE in the UI but won't appear in real data until Phase C populates
 * the gate columns. Empty chip counts (0) are expected.
 */

import type { AnalysisRunRef, CoverLetterRef } from "./progressFlags";

export type PipelineState =
  | "archived"
  | "applied"
  | "ready_to_send"
  | "ready_to_apply"
  | "below_final"
  | "below_initial"
  | "analysing"
  | "role_mismatch"
  | "needs_jd"
  | "discovered";

export interface PipelineStateInput {
  job: {
    applied_at:   string | null;
    dismissed_at: string | null;
    has_email:    boolean | null;
    jd_quality:   string | null;
    role_match:   string | null;
  };
  latestRun?:    AnalysisRunRef;
  latestLetter?: CoverLetterRef;
}

export function derivePipelineState(input: PipelineStateInput): PipelineState {
  const { job, latestRun, latestLetter } = input;

  if (job.dismissed_at) return "archived";
  if (job.applied_at)   return "applied";

  if (latestLetter?.status === "completed") {
    return job.has_email ? "ready_to_send" : "ready_to_apply";
  }

  if (latestRun?.passed_final_gate   === false) return "below_final";
  if (latestRun?.passed_initial_gate === false) return "below_initial";
  if (latestRun?.status === "running")          return "analysing";

  if (job.role_match === "mismatch") return "role_mismatch";
  if (job.jd_quality === "thin")     return "needs_jd";

  return "discovered";
}

// ── State presentation metadata ──────────────────────────────────────────────
// label   — human-readable, fits in a small pill
// tone    — drives colour mapping (success/warning/danger/info/neutral)
// short   — terse one-line description for hover tooltips
// showAsBadge — if false, the State column shows '—' (default discovered state
//               doesn't need its own badge — too noisy on healthy rows)

export interface PipelineStateMeta {
  label:       string;
  tone:        "success" | "warning" | "danger" | "info" | "neutral";
  short:       string;
  showAsBadge: boolean;
}

export const PIPELINE_STATE_META: Record<PipelineState, PipelineStateMeta> = {
  archived:        { label: "Archived",       tone: "neutral", short: "Dismissed from your feed",                                          showAsBadge: true  },
  applied:         { label: "Applied",        tone: "success", short: "You marked this as applied",                                        showAsBadge: true  },
  ready_to_send:   { label: "Ready to send",  tone: "success", short: "Cover letter + email ready — contact present",                     showAsBadge: true  },
  ready_to_apply:  { label: "Ready to apply", tone: "success", short: "Cover letter ready — no email, open the job link to apply",       showAsBadge: true  },
  below_final:     { label: "Below final",    tone: "warning", short: "Tailored CV scored below your final-ATS threshold. Manual runs complete; the automated worker (Phase E) will skip these.",   showAsBadge: true  },
  below_initial:   { label: "Below initial",  tone: "warning", short: "Initial ATS scored below your starting threshold. Manual runs complete; the automated worker (Phase E) will skip these.",      showAsBadge: true  },
  analysing:       { label: "Analysing…",     tone: "info",    short: "Analysis in progress",                                              showAsBadge: true  },
  role_mismatch:   { label: "Role mismatch",  tone: "danger",  short: "Title doesn't match your profile keywords",                         showAsBadge: true  },
  // Needs-JD: showAsBadge=false because the thin-JD icon already appears
  // inline with the location, and the Analyze button surfaces a clear
  // toast + "Run anyway" option when clicked. A separate State badge
  // would be redundant.
  needs_jd:        { label: "Needs JD",       tone: "warning", short: "Job description too short to analyse — paste the full JD to continue", showAsBadge: false },
  discovered:      { label: "—",              tone: "neutral", short: "Not yet processed",                                                 showAsBadge: false },
};

/** Tailwind utility classes per tone for a small pill badge. */
export const TONE_CLASSES: Record<PipelineStateMeta["tone"], { pill: string; dot: string }> = {
  success: { pill: "text-emerald-700 bg-emerald-50 border-emerald-200", dot: "bg-emerald-500" },
  warning: { pill: "text-amber-700   bg-amber-50   border-amber-200",   dot: "bg-amber-500"   },
  danger:  { pill: "text-red-700     bg-red-50     border-red-200",     dot: "bg-red-500"     },
  info:    { pill: "text-blue-700    bg-blue-50    border-blue-200",    dot: "bg-blue-500"    },
  neutral: { pill: "text-text-2      bg-[var(--surface-2)] border-[var(--border)]", dot: "bg-text-3" },
};
