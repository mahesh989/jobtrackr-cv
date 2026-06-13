// Greenhouse ATS adapter — boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
//
// Greenhouse is the most widely-used ATS in AU tech & finance.
// Public JSON API — no auth, no rate-limit headers, just fetch.
// The `content=true` param returns the FULL job description as HTML,
// which we strip to plain text before passing downstream.
//
// Strategy: fetch all jobs for each known company board, filter AU
// locations client-side, then let the standard keyword/dedup/visa
// pipeline handle the rest. No per-keyword API calls needed.
// Unlike Adzuna snippets, we get the FULL JD — visa extraction is reliable.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// ── AU companies confirmed live on Greenhouse ─────────────────────────────────
// Verified against boards-api.greenhouse.io — 404s are skipped silently but
// keeping dead slugs wastes time. Re-verify periodically as companies migrate ATS.
// Ordered: highest AU job volume / most analyst-relevant first.
// Companies where ALL AU roles are relevant regardless of keyword match —
// skip the early keyword filter for these (let stage 4b handle it properly).
const BYPASS_KW_FILTER = new Set(["quantium"]);

const SLUGS: { slug: string; company: string }[] = [
  // ── AU data & analytics ───────────────────────────────────────────────────
  { slug: "quantium",            company: "Quantium" },         // AU data analytics firm — bypass keyword pre-filter

  // ── AU tech (confirmed live) ──────────────────────────────────────────────
  { slug: "prospa",              company: "Prospa" },
  { slug: "buildkite",           company: "Buildkite" },
  { slug: "cultureamp",          company: "Culture Amp" },    // 12 AU jobs verified

  // ── Global tech with confirmed AU presence ────────────────────────────────
  { slug: "databricks",          company: "Databricks" },       // 816 total, AU jobs confirmed
  { slug: "mongodb",             company: "MongoDB" },           // 424 total, AU jobs confirmed
  { slug: "datadog",             company: "Datadog" },           // 406 total, AU jobs confirmed
  { slug: "block",               company: "Block" },             // 174 total, AU jobs confirmed
  { slug: "twilio",              company: "Twilio" },            // 153 total, AU jobs confirmed
  { slug: "elastic",             company: "Elastic" },           // 152 total, AU jobs confirmed
  { slug: "eucalyptus",          company: "Eucalyptus" },        // 82 total, AU jobs confirmed
  { slug: "newrelic",            company: "New Relic" },         // 74 total, AU jobs confirmed
  { slug: "pagerduty",           company: "PagerDuty" },         // 42 total, AU jobs confirmed
  { slug: "latitude",            company: "Latitude" },          // 36 total, AU jobs confirmed
  { slug: "cloudflare",          company: "Cloudflare" },
  { slug: "amplitude",           company: "Amplitude" },
  { slug: "mixpanel",            company: "Mixpanel" },
  { slug: "figma",               company: "Figma" },
  { slug: "okta",                company: "Okta" },
  { slug: "asana",               company: "Asana" },
  { slug: "squarespace",         company: "Squarespace" },
  { slug: "thoughtworks",        company: "Thoughtworks" },
  { slug: "fivetran",            company: "Fivetran" },
  { slug: "hightouch",           company: "Hightouch" },

  // ── AU & global with verified AU jobs ────────────────────────────────────
  { slug: "appen",               company: "Appen" },             // 41 jobs (AU AI/data, ASX-listed)
  { slug: "applydigital",        company: "Apply Digital" },      // 22 jobs
  { slug: "solutions",           company: "Solutions" },          // 17 jobs
  { slug: "honeycomb",           company: "Honeycomb.io" },       // 11 jobs
  { slug: "infomedia",           company: "Infomedia" },          // 8 jobs (AU automotive data, ASX-listed)
  { slug: "flamingo",            company: "Flamingo" },           // 8 jobs (AU insurtech)
  { slug: "altium",              company: "Altium" },             // 7 jobs (AU EDA software)
  { slug: "athena",              company: "Athena Group Advisors" }, // 1 job

  // ── Candidates (404s silently skipped) ───────────────────────────────────
  // These may have migrated ATS — kept for periodic re-checking
  { slug: "atlassian",           company: "Atlassian" },
  { slug: "canva",               company: "Canva" },
  { slug: "xero",                company: "Xero" },
  { slug: "safetyculture",       company: "SafetyCulture" },
  { slug: "airtasker",           company: "Airtasker" },
  { slug: "airwallex",           company: "Airwallex" },
  { slug: "employmenthero",      company: "Employment Hero" },
  { slug: "linktree",            company: "Linktree" },
  { slug: "rokt",                company: "Rokt" },
  { slug: "siteminder",          company: "SiteMinder" },
  { slug: "zip",                 company: "Zip Co" },
  { slug: "iress",               company: "IRESS" },
  { slug: "seek",                company: "SEEK" },
  { slug: "carsales",            company: "Carsales" },
  { slug: "realestate",          company: "REA Group" },
  { slug: "domain",              company: "Domain" },
  { slug: "wisetechglobal",      company: "WiseTech Global" },
  { slug: "pexa",                company: "PEXA" },
  { slug: "medibank",            company: "Medibank" },
  { slug: "nib",                 company: "nib" },
  { slug: "macquarie",           company: "Macquarie" },
  { slug: "servicenow",          company: "ServiceNow" },
  { slug: "hubspot",             company: "HubSpot" },
  { slug: "zendesk",             company: "Zendesk" },
  // cultureamp → promoted to confirmed (12 AU jobs verified)
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Matches AU cities, state abbreviations, and remote-AU variants.
const AU_RE = /\b(australia|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b|new south wales|victoria|queensland|western australia|south australia|remote.{0,30}(australia|APAC|ANZ)/i;

/**
 * Strip HTML tags and decode entities so the plain-text description is
 * suitable for keyword matching and visa extraction.
 *
 * Greenhouse serves double-encoded HTML in JSON — the content field contains
 * literal &lt;div&gt; strings, not <div> tags. So we must:
 *   1. Decode entities first  (&lt; → <)
 *   2. Then strip the now-real HTML tags  (<div> → " ")
 */
function stripHtml(html: string): string {
  // Step 1: decode HTML entities (handles double-encoding from Greenhouse API)
  const decoded = html
    .replace(/&amp;/g,        "&")
    .replace(/&lt;/g,         "<")
    .replace(/&gt;/g,         ">")
    .replace(/&quot;/g,       '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g,       " ")
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(Number(n)));

  // Step 2: strip HTML tags, preserving word boundaries at block elements
  return decoded
    .replace(/<br\s*\/?>/gi,  " ")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g,      "")
    // Final cleanup: any residual entities after nesting
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g,  "<")
    .replace(/&gt;/g,  ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Greenhouse API types ──────────────────────────────────────────────────────

interface GHJob {
  id: number;
  title: string;
  location: { name: string };
  content: string;           // full JD as HTML (requires ?content=true)
  absolute_url: string;
  updated_at: string;
}
interface GHResponse { jobs: GHJob[] }

async function fetchBoard(slug: string): Promise<GHJob[]> {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (res.status === 404) return [];   // slug doesn't exist — skip silently
  if (!res.ok) throw new Error(`HTTP ${res.status} (${slug})`);
  return ((await res.json()) as GHResponse).jobs ?? [];
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const greenhouseAdapter: SourceAdapter = {
  name: "greenhouse",
  tier: 2,
  vertical: "tech",
  rateLimitDelay: 300,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of SLUGS) {
      let board: GHJob[];
      try {
        board = await fetchBoard(slug);
      } catch (err) {
        console.warn(`[greenhouse] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      if (board.length === 0) continue;

      let auCount = 0;
      let kwCount = 0;
      for (const j of board) {
        // Skip non-AU locations
        if (!AU_RE.test(j.location?.name ?? "")) continue;
        auCount++;

        // Strip HTML to get the full plain-text JD
        const plainText = stripHtml(j.content ?? "");

        // Early keyword pre-filter — cheap substring check so we don't pass
        // every engineering role through the rest of the pipeline.
        // Stage 4b (keywordFilter) does the proper word-boundary match afterward.
        // Companies in BYPASS_KW_FILTER are data-specialist firms where ALL AU
        // roles are potentially relevant — let the pipeline's own keyword filter decide.
        if (!BYPASS_KW_FILTER.has(slug)) {
          const haystack = `${j.title} ${plainText}`.toLowerCase();
          if (!kwLower.some((kw) => haystack.includes(kw.toLowerCase()))) continue;
        }
        kwCount++;

        jobs.push({
          url: j.absolute_url,
          title: j.title,
          company,
          location: j.location?.name ?? "Australia",
          description: plainText,    // ← full plain-text JD, not a snippet
          source: "greenhouse",
          source_tier: 2,
          posted_at: j.updated_at ?? null,
          expires_at: null,
          raw: j,
        });
      }

      if (auCount > 0 || kwCount > 0) {
        console.log(`[greenhouse] ${slug}: ${board.length} total → ${auCount} AU → ${kwCount} keyword match`);
      }

      await delay(this.rateLimitDelay);
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      // Use a confirmed-live slug — atlassian migrated off Greenhouse (returns 404/[]).
      // databricks has 800+ jobs globally; extremely unlikely to change ATS.
      const jobs = await fetchBoard("databricks");
      return jobs.length > 0;
    } catch {
      return false;
    }
  },
};
