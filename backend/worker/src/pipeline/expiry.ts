// Stage 9 — Expiry check
// 1. Honour structured expires_at field if present
// 2. Heuristic: jobs posted > 60 days ago are likely filled
// 3. AU day-first closing-date extraction (shared with JD-facts extraction)
//    scan for explicit close-date phrases in description
import type { NormalisedJob } from "./types.js";
import { extractClosingDate } from "../ai/jdFacts.js";

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

// Finding #53 — this used to hand a matched date substring straight to
// `new Date(...)`, which parses slash-separated dates as US month/day, not
// AU day/month, and silently drops unparseable-in-that-order dates (day >
// 12) entirely. A day-first date like "03/04/2026" (3 April) read as March
// 4th — a date that can already be in the past while the real closing date
// is still weeks away, hiding a genuinely live job from the board. Fixed
// by reusing extractClosingDate (ai/jdFacts.ts), the same AU-day-first
// parser already used and tested for job-facts extraction (bucket.ts,
// orchestrator/jobFacts.ts) — one parser, not a second drifted copy.
function parseCloseDate(description: string, now: Date): Date | null {
  const iso = extractClosingDate(description, now);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

export function checkExpiry(job: NormalisedJob): {
  is_expired: boolean;
  expires_at: string | null;
} {
  const now = Date.now();

  // 1. Structured expires_at
  if (job.expires_at) {
    const exp = new Date(job.expires_at).getTime();
    return { is_expired: exp < now, expires_at: job.expires_at };
  }

  // 2. Heuristic: older than 60 days
  if (job.posted_at) {
    const age = now - new Date(job.posted_at).getTime();
    if (age > SIXTY_DAYS_MS) {
      return { is_expired: true, expires_at: null };
    }
  }

  // 3. Description scan for close date
  const closeDate = parseCloseDate(job.description, new Date(now));
  if (closeDate) {
    return {
      is_expired: closeDate.getTime() < now,
      expires_at: closeDate.toISOString(),
    };
  }

  return { is_expired: false, expires_at: null };
}
