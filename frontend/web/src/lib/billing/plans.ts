/**
 * Billing — neutral plan module (no server/client runtime imports).
 *
 * Safe to import from BOTH server components and "use client" components
 * (see OPS-16: never import a runtime value from a "use client" module into a
 * server component). This holds types, plan display metadata, and the limit
 * shape. The AUTHORITATIVE limits live in the DB `plans` table and are loaded
 * by lib/billing/entitlements.ts; the constants here are a typed mirror for
 * UI display + as a fallback.
 *
 * Metering decided 2026-06-02: tailored_cv and cover_letter are SEPARATE
 * buckets with equal caps (either/or). total = unique * 1.5. Caps reset per
 * Stripe billing period. Pricing (AUD): Weekly A$9.99/wk, Monthly A$19.99/mo,
 * Unlimited A$29.99/mo — finalized 2026-06-23.
 *
 * Weekly caps restored 2026-07-22 (migration 082, reversing 061): an uncapped
 * A$9.99 weekly undermined the Unlimited tier. Ladder is now
 * Weekly (capped sprint) → Monthly (best value) → Unlimited (no caps).
 */

export const PLAN_IDS = ["trial", "weekly", "monthly", "unlimited", "comp"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Stripe subscription statuses + our synthetic 'comp' (grandfathered). */
export const SUB_STATUSES = [
  "trialing", "active", "past_due", "canceled",
  "unpaid", "incomplete", "incomplete_expired", "comp",
] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** A null cap means unlimited for that dimension. */
export interface PlanLimits {
  maxProfiles: number | null;
  maxRuns: number | null;
  maxCvUnique: number | null;
  maxCvTotal: number | null;
  maxLetterUnique: number | null;
  maxLetterTotal: number | null;
}

export interface PlanDisplay extends PlanLimits {
  id: PlanId;
  displayName: string;
  interval: "day" | "week" | "month";
  trialDays: number;
  priceCents: number; // AUD cents (placeholder)
  currency: string;
  isPublic: boolean;
  blurb: string;
  highlights: string[];
}

/** Typed mirror of the plans seed (shared/supabase/migrations/003_seed.sql). */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  trial: {
    maxProfiles: 1, maxRuns: 1,
    maxCvUnique: 3, maxCvTotal: 3, maxLetterUnique: 3, maxLetterTotal: 3,
  },
  weekly: {
    maxProfiles: 5, maxRuns: 30,
    maxCvUnique: 50, maxCvTotal: 75, maxLetterUnique: 50, maxLetterTotal: 75,
  },
  monthly: {
    maxProfiles: 10, maxRuns: 120,
    maxCvUnique: 250, maxCvTotal: 375, maxLetterUnique: 250, maxLetterTotal: 375,
  },
  unlimited: {
    maxProfiles: null, maxRuns: null,
    maxCvUnique: null, maxCvTotal: null, maxLetterUnique: null, maxLetterTotal: null,
  },
  comp: {
    maxProfiles: null, maxRuns: null,
    maxCvUnique: null, maxCvTotal: null, maxLetterUnique: null, maxLetterTotal: null,
  },
};

/** Pricing-page metadata for the three purchasable plans. */
export const PUBLIC_PLANS: PlanDisplay[] = [
  {
    id: "weekly",
    displayName: "Weekly",
    interval: "week",
    trialDays: 0,
    priceCents: 999, // A$9.99
    currency: "aud",
    isPublic: true,
    blurb: "For an active job search sprint.",
    highlights: [
      "50 tailored CVs / week",
      "50 cover letters / week",
      "5 search profiles",
      "30 discovery runs / week",
    ],
    ...PLAN_LIMITS.weekly,
  },
  {
    id: "monthly",
    displayName: "Monthly",
    interval: "month",
    trialDays: 0,
    priceCents: 1999, // A$19.99
    currency: "aud",
    isPublic: true,
    blurb: "Best value for a sustained search.",
    highlights: [
      "250 tailored CVs / month",
      "250 cover letters / month",
      "10 search profiles",
      "120 discovery runs / month",
    ],
    ...PLAN_LIMITS.monthly,
  },
  {
    id: "unlimited",
    displayName: "Unlimited",
    interval: "month",
    trialDays: 0,
    priceCents: 2999, // A$29.99
    currency: "aud",
    isPublic: true,
    blurb: "No caps. For power users and recruiters.",
    highlights: [
      "Unlimited tailored CVs",
      "Unlimited cover letters",
      "Unlimited profiles & runs",
      "Priority support",
    ],
    ...PLAN_LIMITS.unlimited,
  },
];

export const TRIAL_DAYS = 3;

/** Reason codes returned by the entitlement layer → mapped to UI copy. */
export const DENY_REASONS = [
  "no_subscription", "read_only", "profile_cap", "run_cap",
  "cv_unique_cap", "cv_total_cap", "letter_unique_cap", "letter_total_cap",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export const DENY_COPY: Record<DenyReason, { title: string; body: string }> = {
  no_subscription: {
    title: "Start your free trial",
    body: "Choose a plan to unlock job discovery and CV tailoring. Your 3-day trial includes 3 tailored CVs and 3 cover letters.",
  },
  read_only: {
    title: "Your subscription has ended",
    body: "Your account is read-only — you can still view past CVs and cover letters. Resubscribe to create new ones.",
  },
  profile_cap: {
    title: "Profile limit reached",
    body: "You've reached the number of search profiles your plan allows. Upgrade for more, or delete an existing profile.",
  },
  run_cap: {
    title: "Run limit reached",
    body: "You've used all the discovery runs in this billing period. Upgrade your plan for more runs.",
  },
  cv_unique_cap: {
    title: "Tailored CV limit reached",
    body: "You've tailored the maximum number of jobs for this period. Upgrade to tailor more.",
  },
  cv_total_cap: {
    title: "Re-analysis limit reached",
    body: "You've used all your tailored-CV generations (including re-analyses) for this period. Upgrade for more.",
  },
  letter_unique_cap: {
    title: "Cover letter limit reached",
    body: "You've generated the maximum number of cover letters for this period. Upgrade to write more.",
  },
  letter_total_cap: {
    title: "Cover letter limit reached",
    body: "You've used all your cover-letter generations (including regenerations) for this period. Upgrade for more.",
  },
};

/** Format AUD cents → "A$9.99". */
export function formatAud(cents: number): string {
  return `A$${(cents / 100).toFixed(2)}`;
}
