/**
 * Shared setup-step definitions — the single source of truth for the onboarding
 * wizard. Deliberately a *plain* module (NO "use client"): both the server
 * (instructions page, dashboard first-run) and the client wizard components
 * import from here. Importing real values from a "use client" file into a
 * server component hands back a client-reference proxy (NaN math, crashes), so
 * the step data + count must live in a neutral module like this one.
 */

import {
  CreditCard, UserCircle2, PenLine, Mail, Briefcase,
  type LucideIcon,
} from "lucide-react";
import type { SetupStatus, SetupStepKey } from "./setupStatus";

export type SetupTag = "required" | "recommended" | "optional";

export interface SetupStep {
  key:   SetupStepKey;
  icon:  LucideIcon;
  title: string;
  tag:   SetupTag;
  blurb: string;
  href:  string;
  tab?:  string; // optional sub-tab param (e.g. "details" → ?tab=details)
}

export const SETUP_STEPS: SetupStep[] = [
  {
    key: "billing", icon: CreditCard, title: "Choose your plan", tag: "required",
    blurb: "Start with a free 3-day trial or subscribe directly — pick whichever plan fits how you want to search. You can switch plans anytime afterwards.",
    href: "/onboarding/plan",
  },
  {
    key: "profile", icon: UserCircle2, title: "Set up your Profile", tag: "required",
    blurb: "Fill in your contact details (Details tab), then upload or build your CV (CVs tab). Both are needed before your first analysis.",
    href: "/cv", tab: "details",
  },
  {
    key: "voice", icon: PenLine, title: "Set up your writing voice", tag: "recommended",
    blurb: "Makes your cover letters read like a human — like you, not generic AI. Paste a short writing sample or pick a tone; it's used whenever a letter is drafted.",
    href: "/voice",
  },
  {
    key: "email", icon: Mail, title: "Connect your email", tag: "optional",
    blurb: "Optional — lets you send cover-letter emails to hiring contacts straight from JobTrackr via Gmail or Outlook. Connect under Settings → Account.",
    href: "/settings/account",
  },
  {
    key: "searchProfile", icon: Briefcase, title: "Create a search profile & run it", tag: "required",
    blurb: "Your job radar: keywords + location + schedule. Save it, then hit Run now — your first AI-scored results land in a minute or two.",
    href: "/profiles/new",
  },
];

export const SETUP_STEP_COUNT = SETUP_STEPS.length;

/** Steps that gate "setup complete" — the recommended/optional ones don't. */
const SETUP_REQUIRED_KEYS: SetupStepKey[] = ["billing", "profile", "searchProfile"];

export const TAG_LABEL: Record<SetupTag, string> = {
  required: "Required", recommended: "Recommended", optional: "Optional",
};

/** Zero-based index of the first step not yet done (0 if all done). */
export function firstIncompleteStep(status: SetupStatus): number {
  const idx = SETUP_STEPS.findIndex((s) => !status[s.key]);
  return idx === -1 ? 0 : idx;
}

/** True once every required step is done. Drives the cards → checklist switch. */
export function isSetupComplete(status: SetupStatus): boolean {
  return SETUP_REQUIRED_KEYS.every((k) => status[k]);
}

/** Clamp a 1-based step param into a valid 0-based index. */
export function clampStepIndex(oneBased: number, fallback = 0): number {
  if (!Number.isFinite(oneBased)) return fallback;
  return Math.min(Math.max(oneBased - 1, 0), SETUP_STEP_COUNT - 1);
}
