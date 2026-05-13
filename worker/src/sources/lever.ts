// Lever ATS adapter — api.lever.co/v0/postings/{slug}?mode=json
//
// Lever powers ~5-10% of AU tech companies. Public JSON API, no auth required.
// Job descriptions are returned as plain text via `descriptionPlain` — no HTML
// stripping needed. Location is in `categories.location`.
//
// Strategy: fetch all postings per slug, filter AU locations, keyword-match,
// then pass to the standard pipeline. Like Greenhouse, we get the FULL JD.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// ── Confirmed live Lever slugs with AU jobs ───────────────────────────────────
// Verified via api.lever.co/v0/postings/{slug}?mode=json — 404s skipped silently.
// Re-verify periodically as companies migrate ATS.
const SLUGS: { slug: string; company: string }[] = [
  // ── Confirmed live with AU jobs ───────────────────────────────────────────
  { slug: "pexa",      company: "PEXA" },        // 13 AU jobs (Melbourne)
  { slug: "deputy",    company: "Deputy" },       // 10 AU jobs (Sydney)
  { slug: "brighte",   company: "Brighte" },      // 5 AU jobs (Sydney, Perth)
  { slug: "immutable", company: "Immutable" },    // 5 AU/APAC jobs (Sydney + APAC)

  // ── Candidates (404s silently skipped) ────────────────────────────────────
  // These may have live boards — kept for periodic re-checking
  { slug: "safety-culture", company: "SafetyCulture" },
  { slug: "go1",            company: "GO1" },
  { slug: "simpro",         company: "simPRO" },
  { slug: "nearmap",        company: "Nearmap" },
  { slug: "humanitix",      company: "Humanitix" },
  { slug: "rea-group",      company: "REA Group" },
  { slug: "versent",        company: "Versent" },
];

// ── AU location regex ─────────────────────────────────────────────────────────
// Covers AU cities, state abbreviations, APAC/ANZ variants used by Lever slugs.
const AU_RE = /\b(australia|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b|new south wales|victoria|queensland|western australia|south australia|remote.{0,30}(australia|APAC|ANZ)|\bAPAC\b/i;

// ── Lever API types ───────────────────────────────────────────────────────────

interface LeverPosting {
  id: string;
  text: string;                  // job title
  categories: {
    location?: string;
    team?: string;
    commitment?: string;
  };
  description?: string;          // HTML description
  descriptionPlain?: string;     // plain-text description (preferred)
  additionalPlain?: string;      // additional plain-text info
  hostedUrl: string;             // canonical job board URL
  createdAt: number;             // epoch ms
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchBoard(slug: string): Promise<LeverPosting[]> {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${slug}?mode=json`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (res.status === 404) return [];   // slug doesn't exist — skip silently
  if (!res.ok) throw new Error(`HTTP ${res.status} (${slug})`);
  const body = await res.json();
  return Array.isArray(body) ? (body as LeverPosting[]) : [];
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const leverAdapter: SourceAdapter = {
  name: "lever",
  tier: 2,
  vertical: "tech",
  rateLimitDelay: 400,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of SLUGS) {
      let board: LeverPosting[];
      try {
        board = await fetchBoard(slug);
      } catch (err) {
        console.warn(`[lever] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      if (board.length === 0) continue;

      let auCount = 0;
      let kwCount = 0;

      for (const p of board) {
        const loc = p.categories?.location ?? "";
        if (!AU_RE.test(loc)) continue;
        auCount++;

        // `descriptionPlain` is already plain text — no HTML stripping needed.
        // Concatenate all text fields for keyword matching.
        const plainText = [p.descriptionPlain, p.additionalPlain].filter(Boolean).join(" ");
        const haystack = `${p.text} ${plainText}`.toLowerCase();

        if (!kwLower.some((kw) => haystack.includes(kw.toLowerCase()))) continue;
        kwCount++;

        jobs.push({
          url: p.hostedUrl,
          title: p.text,
          company,
          location: loc || "Australia",
          description: plainText,     // ← full plain-text JD
          source: "lever",
          source_tier: 2,
          posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          expires_at: null,
          raw: p,
        });
      }

      if (auCount > 0 || kwCount > 0) {
        console.log(`[lever] ${slug}: ${board.length} total → ${auCount} AU → ${kwCount} keyword match`);
      }

      await delay(this.rateLimitDelay);
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const jobs = await fetchBoard("brighte");
      return jobs.length > 0;
    } catch {
      return false;
    }
  },
};
