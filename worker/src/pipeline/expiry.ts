// Stage 9 — Expiry check
// 1. Honour structured expires_at field if present
// 2. Heuristic: jobs posted > 60 days ago are likely filled
// 3. Simple regex scan for explicit close-date phrases in description
import type { NormalisedJob } from "./types.js";

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

// Phrases that suggest a closing date in the description body
const CLOSE_DATE_RE =
  /\b(?:applications?\s+close[sd]?|closing\s+date|apply\s+by|deadline)\s*[:\-–]?\s*(\d{1,2}[\s\/\-]\w+[\s\/\-]\d{2,4}|\w+\s+\d{1,2},?\s+\d{4})/i;

function parseCloseDate(description: string): Date | null {
  const m = description.match(CLOSE_DATE_RE);
  if (!m) return null;
  const d = new Date(m[1]);
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
  const closeDate = parseCloseDate(job.description);
  if (closeDate) {
    return {
      is_expired: closeDate.getTime() < now,
      expires_at: closeDate.toISOString(),
    };
  }

  return { is_expired: false, expires_at: null };
}
