// SEEK AU adapter — via custom Apify actor (seek-au-scraper)
//
// SEEK blocks direct HTTP from static datacenter IPs.
// Our custom actor hits SEEK's internal JSON API with rotating IPs via
// Apify proxy, keeping costs inside the $5/month free tier.
//
// Architecture: factory function, NOT a static export.
// SEEK requires a per-user Apify token — it can't live in the global adapters[]
// array. The orchestrator creates this adapter at runtime if the user has a
// valid, quota-remaining Apify integration, then discards it after the run.
//
// Actor output fields (our custom actor):
//   id, title, company, location, area, salary, teaser,
//   listingDate, url, workType, keyword
//
// Pricing: Apify platform compute only (~$0.002/result + $0.02/run).
// SEEK hard cap: 550 results per search (platform limit).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
// Actor IDs: set via env vars after deploying.
// Format: "<your-apify-username>~seek-au-scraper"
const ACTOR_ID         = process.env.SEEK_ACTOR_ID    ?? "prospect_fuzz~seek-au-scraper";
const APIFY_RUN_URL    = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;

// Cost estimate — used by orchestrator to update quota_used_usd after each run.
const COST_PER_RESULT_USD = 0.002;
const COST_PER_RUN_USD    = 0.02;

// ── Output shape from our custom actor ────────────────────────────────────────
interface SeekItem {
  id?:          string;
  title?:       string;
  company?:     string;     // already resolved from advertiser.description
  location?:    string;     // e.g. "Sydney NSW 2000"
  area?:        string;     // e.g. "CBD, Inner West & Eastern Suburbs"
  salary?:      string;     // e.g. "$90,000 – $110,000"
  teaser?:      string;
  listingDate?: string;     // ISO date string (NOT "featured" — filtered at actor level)
  url?:         string;
  workType?:    string;
  keyword?:     string;     // which search keyword found this job
}

// ── Salary parsing ─────────────────────────────────────────────────────────────
// Shared with seekDirect.ts (identical SEEK salary-label format on both paths).
// Period alternation matches careerjet.ts's own H/D/W/M scaling, plus the AU
// abbreviated forms ("p.h.", "p.d." etc) this free-text label commonly uses.
//
// C29b (6 review rounds — see EXECUTION-LOG.md [C29b] for the full history,
// summarized here since the final shape isn't self-explanatory):
//
// Both the abbreviated forms ("ph"/"pd"/"pw"/"pm", punctuation optional) and
// the bare word forms ("daily"/"weekly"/"monthly"/"hourly") are, on their
// own, indistinguishable from ordinary English substrings genuinely present
// in real SEEK labels — "Phone", "Physiotherapist", "(PM)", "9am-5pm",
// "monthly commission/incentive", "weekly on-call allowance" all matched and
// mis-scaled a correct figure by 12x-2080x. An enumerated exclusion-noun
// blocklist is unfixably incomplete against an unbounded vocabulary and
// regressed genuine cases like "$45 hourly pay" — replaced with a
// magnitude-plausibility gate instead (mirrors ai/jdFacts.ts's own "hourly
// rates above $500... are misparses"): a period match is only trusted if
// the RAW (pre-scale) figure is a plausible magnitude for that period
// (MAX_PLAUSIBLE_RAW). A separate STRONG/WEAK split (explicit "per day" /
// bare "daily" vs the collision-prone abbreviations) stops a spurious
// abbreviation match from being preferred over an unambiguous marker.
//
// Neither fix alone was enough: with MULTIPLE plausible candidates in the
// SAME tier (e.g. "$1,800 per week + daily site allowance" — both "per
// week" and "daily" are present, and $1,800 is plausible as EITHER a
// weekly or a daily rate), a fixed H>D>W>M precedence order still picked
// whichever period happened to be checked first, not whichever marker was
// actually describing the headline figure. Fixed with PROXIMITY: among all
// plausible candidates in a tier, the marker positioned CLOSEST to the
// first number in the raw text wins — the qualifier immediately next to a
// number is what describes it, matching how these labels read in English.
// STRONG tier is still tried in full before WEAK (an unambiguous marker
// anywhere beats a collision-prone abbreviation, regardless of distance).
//
// Separately, `salary_max` was derived by scaling `hi` with WHATEVER scale
// `lo`'s context selected, with no plausibility check of its own — a
// second, unrelated already-annual figure elsewhere in the label (e.g.
// "$55 per hour, up to $120,000 package") got multiplied by the hourly
// scale into a nine-figure number. Guarded as a CLAMP (not a conditional
// gate — an earlier version only rewrote salary_max when hi >= $20k,
// leaving a smaller `hi` like a real $15,900/$18,550 AU salary-packaging
// cap to slip through unclamped): any candidateMax above $1M is always
// replaced with `hi` unscaled (if `hi` independently looks annual) or
// `salary_min` (otherwise), never left as the fabricated 8-figure product.
//
// Accepted residual, NOT closed by this chunk (documented, not silently
// missed): the clamp only fires once candidateMax exceeds $1M, so a
// smaller mis-scale on a low-multiplier period can still slip under it —
// e.g. "$7,500 per month + $18,000 annual bonus" -> max=216000 (should be
// 90000). Every case found stays UNDER the same ceiling a genuine wide
// range could legitimately reach, so tightening this needs a relative
// check (hi vs salary_min) rather than an absolute one — a real design
// decision for a future round, not a defect in this one.
//
// Verified against a 69-case table spanning every round's finding (see
// seek.salary.test.ts) with zero regressions.
const HOURLY_STRONG  = /per\s*hours?\b|\bhourly\b|an\s+hour/i;
const HOURLY_WEAK    = /\/\s*hrs?\b|p[.\/]?hr?\.?/i;
const DAILY_STRONG   = /per\s*day\b|\bdaily\b/i;
const DAILY_WEAK     = /p[.\/]?d\.?/i;
const WEEKLY_STRONG  = /per\s*week\b|\bweekly\b/i;
const WEEKLY_WEAK    = /p[.\/]?w\.?/i;
const MONTHLY_STRONG = /per\s*month\b|\bmonthly\b/i;
const MONTHLY_WEAK   = /p[.\/]?m\.?/i;

// Upper bound on the RAW (pre-scale) figure for each period, beyond which a
// matched period marker is almost certainly describing something other than
// the headline figure's own period (a bonus/allowance/pay-cycle mention).
const MAX_PLAUSIBLE_RAW: Record<number, number> = {
  2080: 500,    // hourly:  > $500/hr is not a real rate
  260:  5000,   // daily:   > $5,000/day is not a real rate
  52:   10000,  // weekly:  > $10,000/week is not a real rate
  12:   40000,  // monthly: > $40,000/month is not a real rate
};
// No real individual AU salary on a general job board reaches this — beyond
// it, a scaled `hi` is almost certainly a mis-scale of an unrelated figure.
const MAX_PLAUSIBLE_ANNUAL = 1_000_000;
// Floor matching ai/jdFacts.ts's own "annual below $20k is a misparse" —
// used here as evidence a second figure is ALREADY an annual amount.
const MIN_PLAUSIBLE_ANNUAL = 20_000;

const STRONG_PERIODS: [RegExp, number][] = [
  [HOURLY_STRONG, 2080], [DAILY_STRONG, 260], [WEEKLY_STRONG, 52], [MONTHLY_STRONG, 12],
];
const WEAK_PERIODS: [RegExp, number][] = [
  [HOURLY_WEAK, 2080], [DAILY_WEAK, 260], [WEEKLY_WEAK, 52], [MONTHLY_WEAK, 12],
];

// Among candidates that both match and pass their own magnitude cap, picks
// whichever marker sits CLOSEST (by string index) to the number at
// `loIndex` — not simply the first in fixed H/D/W/M order.
function closestPlausibleScale(
  candidates: [RegExp, number][], text: string, lo: number | undefined, loIndex: number,
): number | undefined {
  let best: { scale: number; dist: number } | undefined;
  for (const [re, scale] of candidates) {
    const idx = text.search(re);
    if (idx === -1) continue;
    if ((lo ?? 0) > MAX_PLAUSIBLE_RAW[scale]) continue;
    const dist = Math.abs(idx - loIndex);
    if (!best || dist < best.dist) best = { scale, dist };
  }
  return best?.scale;
}

export function parseSalary(text: string | undefined | null): { salary_min?: number; salary_max?: number } {
  if (!text) return {};

  // A number immediately followed by "%" is a super/loading rate, not a
  // dollar figure (e.g. "$120,000 + 11.5% Super") — exclude it from the
  // candidate pool entirely so it's never mistaken for salary_max, rather
  // than blindly taking the first two numbers in the label.
  const numMatches = [...text.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)]
    .filter((m) => !m[0].endsWith("%"));
  if (numMatches.length === 0) return {};
  const nums = numMatches.map((m) => Number(m[0].replace(/,/g, "")));
  const loIndex = numMatches[0].index ?? 0;
  const [lo, hi] = nums;

  const scale = closestPlausibleScale(STRONG_PERIODS, text, lo, loIndex)
    ?? closestPlausibleScale(WEAK_PERIODS, text, lo, loIndex)
    ?? 1;                             // no plausible period marker found — already annual

  const salary_min = lo ? lo * scale : undefined;
  const candidateMax = (hi ?? lo) * scale;
  let salary_max = candidateMax;
  // C29b round 7 finding: this must be a CLAMP, not a conditional gate — an
  // earlier version only rewrote salary_max when `hi >= MIN_PLAUSIBLE_ANNUAL`,
  // leaving every implausible `candidateMax` with a smaller `hi` (e.g. a
  // $15,900/$18,550 AU NFP/health salary-packaging cap — statutory figures
  // common in exactly the hourly-quoted roles this scales) to pass through
  // UNCHECKED. Any implausible candidateMax must be replaced with SOMETHING
  // safe: `hi` unscaled if it independently looks annual, otherwise fall
  // back to salary_min (a real min beats a fabricated 8-figure max).
  if (hi != null && candidateMax > MAX_PLAUSIBLE_ANNUAL) {
    salary_max = hi >= MIN_PLAUSIBLE_ANNUAL ? hi : (salary_min ?? candidateMax);
  }

  // Sanity guard (same rule as ai/jdFacts.ts's extractTextSalary): a max
  // below the min is a misparse, not a real range.
  if (salary_min != null && salary_max < salary_min) salary_max = salary_min;

  return { salary_min, salary_max };
}

// ── Result returned to orchestrator (includes cost for quota tracking) ─────────
export interface SeekFetchResult {
  jobs:    RawJob[];
  costUsd: number;   // orchestrator persists this to user_integrations.quota_used_usd
}

// ── Factory ───────────────────────────────────────────────────────────────────
/**
 * Create a SEEK adapter bound to a specific user's Apify token.
 * Call createSeekAdapter(decryptedToken) from the orchestrator after loading
 * the user's integration — never store the adapter globally.
 */
export function createSeekAdapter(apifyToken: string): {
  fetchJobs(profile: SearchProfile): Promise<SeekFetchResult>;
  isHealthy(): Promise<boolean>;
  name: string;
  tier: SourceAdapter["tier"];
} {
  return {
    name: "seek",
    tier: 1,

    async fetchJobs(profile: SearchProfile): Promise<SeekFetchResult> {
      const allJobs: RawJob[] = [];
      // Always use a fixed window — SEEK is deduped at the DB layer, so repeating
      // jobs costs nothing extra. A short adaptive window (like Adzuna uses to cut
      // API spend) causes the actor to return 0 results on same-day re-runs.
      const daysOld = 14;

      console.log(`[seek] actor: ${ACTOR_ID}`);
      console.log(`[seek] keywords: ${profile.keywords.join(", ")}`);

      let items: SeekItem[] = [];
      try {
        // Run all keywords in one actor call — the actor handles pagination per keyword
        const res = await fetch(
          `${APIFY_RUN_URL}?timeout=300`,
          {
            method:  "POST",
            headers: {
              Authorization:  `Bearer ${apifyToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              keywords:   profile.keywords,
              location:   profile.location || "All Australia",
              dateRange:  daysOld,
              maxResults: 200,
            }),
            signal: AbortSignal.timeout(310_000),
          }
        );

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          // THROW instead of returning a normal-looking empty result — the
          // orchestrator's own catch (sourceFetch.ts) exists specifically to
          // mark the integration invalid and skip billing on a real failure.
          // Returning {jobs:[], costUsd} here made a dead/expired token
          // indistinguishable from a legitimate zero-result search: the
          // caller billed quota AND reset status to "valid" on every auth
          // failure, permanently hiding the broken token (#23 audit).
          throw new Error(`Apify ${res.status}: ${body.slice(0, 300)}`);
        }

        items = (await res.json()) as SeekItem[];
        console.log(`[seek] actor returned ${items.length} raw items`);
      } catch (err) {
        console.error(`[seek] actor call failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }

      let skipped = 0;
      for (const item of items) {
        // Safety: featured items should be filtered by the actor, but double-check
        if (
          typeof item.listingDate === "string" &&
          item.listingDate.toLowerCase() === "featured"
        ) {
          skipped++;
          continue;
        }

        const url = item.url ?? (item.id ? `https://www.seek.com.au/job/${item.id}` : "");
        if (!url || !item.title) continue;

        // Combine area + location for display: "CBD, Inner West & Eastern Suburbs · Sydney NSW"
        const location = [item.area, item.location]
          .filter(Boolean)
          .join(" · ") || profile.location;

        const description = item.teaser ?? "";
        const posted_at   = item.listingDate
          ? (() => { try { return new Date(item.listingDate!).toISOString(); } catch { return null; } })()
          : null;

        const { salary_min, salary_max } = parseSalary(item.salary);

        allJobs.push({
          url,
          title:       item.title,
          company:     item.company ?? "",
          location,
          description,
          source:      "seek",
          source_tier: 1,
          posted_at,
          expires_at:  null,
          ...(salary_min !== undefined && { salary_min }),
          ...(salary_max !== undefined && { salary_max }),
          ...(item.workType && { employment_types_raw: [item.workType] }),
          raw: item,
        });
      }

      if (skipped > 0) {
        console.log(`[seek] skipped ${skipped} featured/sponsored listings (post-filter)`);
      }

      const costUsd = COST_PER_RUN_USD + allJobs.length * COST_PER_RESULT_USD;
      console.log(`[seek] done — ${allJobs.length} jobs, estimated cost $${costUsd.toFixed(4)}`);

      return { jobs: allJobs, costUsd };
    },

    async isHealthy(): Promise<boolean> {
      // Confirm the token is accepted by Apify — lightweight, no actor run
      try {
        const res = await fetch("https://api.apify.com/v2/users/me", {
          headers: { Authorization: `Bearer ${apifyToken}` },
          signal:  AbortSignal.timeout(8_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}


