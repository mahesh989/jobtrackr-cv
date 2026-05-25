/**
 * Shared setup-step definitions — the single source of truth for the onboarding
 * wizard. Deliberately a *plain* module (NO "use client"): both the server
 * (instructions page, dashboard first-run) and the client wizard components
 * import from here. Importing real values from a "use client" file into a
 * server component hands back a client-reference proxy (NaN math, crashes), so
 * the step data + count must live in a neutral module like this one.
 */

import {
  UserCircle2, FileText, PenLine, Plug, Mail, Cloud, Briefcase,
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
}

export const SETUP_STEPS: SetupStep[] = [
  {
    key: "profile", icon: UserCircle2, title: "Set up your profile", tag: "required",
    blurb: "Your contact details are stamped onto every tailored CV. Name, address and contact number are required; LinkedIn, GitHub, portfolio and projects are optional but recommended.",
    href: "/dashboard/settings/profile",
  },
  {
    key: "cv", icon: FileText, title: "Upload your CV", tag: "required",
    blurb: "The AI tailors this to each job and scores how well you match. Upload a PDF or DOCX, then set one version as active.",
    href: "/dashboard/cv",
  },
  {
    key: "voice", icon: PenLine, title: "Set up your writing voice", tag: "recommended",
    blurb: "Makes your cover letters read like a human — like you, not generic AI. Paste a short writing sample or pick a tone; it's used whenever a letter is drafted.",
    href: "/dashboard/voice",
  },
  {
    key: "aiKey", icon: Plug, title: "Add an AI key (BYOK)", tag: "required",
    blurb: "Analysis, tailoring and cover letters run on your own Anthropic, OpenAI or DeepSeek key — your key, your data. Paste it under AI providers and it validates automatically.",
    href: "/dashboard/integrations",
  },
  {
    key: "email", icon: Mail, title: "Connect your email", tag: "optional",
    blurb: "Optional — lets you send cover-letter emails to hiring contacts straight from JobTrackr via Gmail or Outlook.",
    href: "/dashboard/integrations",
  },
  {
    key: "apify", icon: Cloud, title: "Add your Apify account", tag: "recommended",
    blurb: "A backup scraper for SEEK if the free path is ever blocked. Paste your Apify token; a monthly budget cap applies.",
    href: "/dashboard/integrations",
  },
  {
    key: "searchProfile", icon: Briefcase, title: "Create a search profile & run it", tag: "required",
    blurb: "Your job radar: keywords + location + schedule. Save it, then hit Run now — your first AI-scored results land in a minute or two.",
    href: "/dashboard/profiles/new",
  },
];

export const SETUP_STEP_COUNT = SETUP_STEPS.length;

/** Steps that gate "setup complete" — the recommended/optional ones don't. */
export const SETUP_REQUIRED_KEYS: SetupStepKey[] = ["profile", "cv", "aiKey", "searchProfile"];

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
