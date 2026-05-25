"use client";

/**
 * SetupGuide — a stepped "Next / Next" card walkthrough of first-run setup.
 *
 * One card visible at a time, with Back / Next, a clickable dot row, a
 * required/recommended/optional tag, a deep-link CTA to the relevant page,
 * and a live green check when that step is already done (from getSetupStatus).
 *
 * Rendered on the dashboard until the first pipeline run produces data, and
 * always available on /dashboard/instructions.
 */

import { useState } from "react";
import Link from "next/link";
import {
  UserCircle2, FileText, PenLine, Plug, Mail, Cloud, Briefcase,
  Check, ChevronLeft, ChevronRight,
  type LucideIcon,
} from "lucide-react";
import type { SetupStatus, SetupStepKey } from "@/lib/setupStatus";

type Tag = "required" | "recommended" | "optional";

interface Step {
  key:   SetupStepKey;
  icon:  LucideIcon;
  title: string;
  tag:   Tag;
  blurb: string;
  href:  string;
  cta:   string;
}

const STEPS: Step[] = [
  {
    key: "profile", icon: UserCircle2, title: "Set up your profile", tag: "required",
    blurb: "Your contact details are stamped onto every tailored CV. Name, address and contact number are required; LinkedIn, GitHub, portfolio and projects are optional but recommended.",
    href: "/dashboard/settings/profile", cta: "Set up profile",
  },
  {
    key: "cv", icon: FileText, title: "Upload your CV", tag: "required",
    blurb: "The AI tailors this to each job and scores how well you match. Upload a PDF or DOCX, then set one version as active.",
    href: "/dashboard/cv", cta: "Go to CV library",
  },
  {
    key: "voice", icon: PenLine, title: "Set up your writing voice", tag: "recommended",
    blurb: "Makes your cover letters read like a human — like you, not generic AI. Paste a short writing sample or pick a tone; it's used whenever a letter is drafted.",
    href: "/dashboard/voice", cta: "Set writing voice",
  },
  {
    key: "aiKey", icon: Plug, title: "Add an AI key (BYOK)", tag: "required",
    blurb: "Analysis, tailoring and cover letters run on your own Anthropic, OpenAI or DeepSeek key — your key, your data. Paste it under AI providers and it validates automatically.",
    href: "/dashboard/integrations", cta: "Add AI key",
  },
  {
    key: "email", icon: Mail, title: "Connect your email", tag: "optional",
    blurb: "Optional — lets you send cover-letter emails to hiring contacts straight from JobTrackr via Gmail or Outlook.",
    href: "/dashboard/integrations", cta: "Connect email",
  },
  {
    key: "apify", icon: Cloud, title: "Add your Apify account", tag: "recommended",
    blurb: "A backup scraper for SEEK if the free path is ever blocked. Paste your Apify token; a monthly budget cap applies.",
    href: "/dashboard/integrations", cta: "Add Apify",
  },
  {
    key: "searchProfile", icon: Briefcase, title: "Create a search profile & run it", tag: "required",
    blurb: "Your job radar: keywords + location + schedule. Save it, then hit Run now — your first AI-scored results land in a minute or two.",
    href: "/dashboard/profiles/new", cta: "Create your first profile",
  },
];

const TAG_CLASS: Record<Tag, string> = {
  required:    "text-[var(--brand)] bg-[var(--brand)]/10 border-[var(--brand)]/20",
  recommended: "text-[var(--amber)] bg-[var(--amber-light)] border-[var(--amber)]/30",
  optional:    "text-text-2 bg-[var(--surface-2)] border-border",
};

const TAG_LABEL: Record<Tag, string> = {
  required: "Required", recommended: "Recommended", optional: "Optional",
};

/** Number of setup steps — shared with SetupReturnBar for the "Step N of X" label. */
export const SETUP_STEP_COUNT = STEPS.length;

export function SetupGuide({
  status,
  initialStep = 0,
  returnTo = "/dashboard/instructions",
}: {
  status: SetupStatus;
  /** Zero-based card to open on first render (used by the instructions round-trip). */
  initialStep?: number;
  /** Where the "Back to setup" bar should return after a CTA is followed. */
  returnTo?: string;
}) {
  const [i, setI] = useState(initialStep);
  const step = STEPS[i];
  const Icon = step.icon;
  const done = status[step.key];
  const doneCount = STEPS.filter((s) => status[s.key]).length;

  // The CTA carries its origin so the shared SetupReturnBar can offer a
  // one-click way back to the exact step the user left from.
  const backHref = returnTo.includes("?") ? `${returnTo}&step=${i + 1}` : `${returnTo}?step=${i + 1}`;
  const ctaHref  = `${step.href}?from=setup&step=${i + 1}&return=${encodeURIComponent(backHref)}`;

  return (
    <div className="w-full max-w-xl mx-auto">
      {/* Progress summary */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] text-text-3">
          Step {i + 1} of {STEPS.length}
        </span>
        <span className="text-[12px] text-text-3">
          {doneCount}/{STEPS.length} done
        </span>
      </div>

      {/* Card */}
      <div className="bg-surface border border-border rounded-xl p-6 sm:p-8 text-center anim-in">
        <div className="relative w-14 h-14 mx-auto mb-5">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center">
            <Icon className="w-7 h-7 text-[var(--brand)]" />
          </div>
          {done && (
            <span className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-[var(--green)] border-2 border-surface flex items-center justify-center">
              <Check className="w-3.5 h-3.5 text-surface" strokeWidth={3} />
            </span>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 mb-2">
          <h2 className="text-[18px] font-semibold text-text">{step.title}</h2>
        </div>

        <div className="flex items-center justify-center gap-2 mb-4">
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${TAG_CLASS[step.tag]}`}>
            {TAG_LABEL[step.tag]}
          </span>
          {done && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border text-[var(--green)] bg-[var(--green-light)] border-[var(--green)]/30">
              Done
            </span>
          )}
        </div>

        <p className="text-[13px] text-text-2 leading-relaxed mb-6 max-w-md mx-auto">
          {step.blurb}
        </p>

        <Link
          href={ctaHref}
          className="gh-btn gh-btn-blue text-[13px] px-4 py-2 inline-flex items-center gap-1.5"
        >
          {done ? "Review" : step.cta}
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setI((n) => Math.max(0, n - 1))}
          disabled={i === 0}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>

        <div className="flex items-center gap-1.5">
          {STEPS.map((s, idx) => (
            <button
              key={s.key}
              onClick={() => setI(idx)}
              aria-label={`Go to step ${idx + 1}: ${s.title}`}
              className={
                "h-2 rounded-full transition-all " +
                (idx === i ? "w-5 bg-[var(--brand)]" : "w-2 ") +
                (idx !== i ? (status[s.key] ? "bg-[var(--green)]" : "bg-border hover:bg-text-3") : "")
              }
            />
          ))}
        </div>

        <button
          onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))}
          disabled={i === STEPS.length - 1}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
