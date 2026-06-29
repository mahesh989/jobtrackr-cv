// Aged-care direct-from-employer adapter — scrapes aged-care providers that run
// on the Workday ATS via their PUBLIC CXS JSON API. No auth, no Cloudflare, free.
//
// Why a SEPARATE adapter from workday.ts?
//   workday.ts targets big-enterprise tech/finance tenants (CBA, ANZ, Telstra)
//   and keyword-filters on the caller's profile keywords. This adapter targets
//   AGED-CARE providers and filters by a fixed clinical/care ROLE taxonomy
//   (nursing, care/support workers, admin officers) regardless of the profile's
//   keywords — the whole point is a curated aged-care job stream. Different
//   tenant list, different filter, different vertical → its own file.
//
// Two public endpoints per tenant (verified against Anglicare 2026-06-29):
//   1. LIST   POST /wday/cxs/{tenant}/{board}/jobs
//             body {appliedFacets:{}, limit:20, offset:N, searchText:""}
//             → { total, jobPostings:[{title, locationsText, externalPath, ...}] }
//             `limit` is capped at 20 by Workday — page with `offset`.
//   2. DETAIL GET  /wday/cxs/{tenant}/{board}{externalPath}
//             → { jobPostingInfo:{ jobDescription(HTML), location, startDate, ... } }
//
// Cost discipline: the LIST call is cheap and returns every job, but we only
// spend a DETAIL call (full JD) on jobs whose TITLE matches the role taxonomy.
// For a ~48-job board that's ~3 list calls + ~15 detail calls — trivial load,
// which is also what keeps direct scraping legitimate.
//
// Adding a provider = one row in TENANTS (discover tenant/wdN/board from its
// careers URL: https://{tenant}.wd{wdN}.myworkdayjobs.com/.../{board}).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

// ── Aged-care Workday tenants ─────────────────────────────────────────────────
// wdN = the version number in the subdomain (wd1 / wd3 / wd5 / wd105 …).
// board = the site slug in the careers URL path. Validate a new tenant with:
//   curl -s -X POST https://{tenant}.wd{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs \
//     -H 'Content-Type: application/json' -d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}'
const TENANTS: { tenant: string; wdN: number; board: string; company: string }[] = [
  { tenant: "anglicare",      wdN: 105, board: "Anglicare_Careers",        company: "Anglicare" },        // ✅ validated 2026-06-29
  // Researched from public careers URLs — boards need the two-call validation
  // before they can be trusted (see docs/aged-care-ats-map.md).
  { tenant: "bupa",           wdN: 3,   board: "EXT_CAREER",               company: "Bupa Aged Care" },
  { tenant: "estiahealth",    wdN: 105, board: "Estia_Health_Careers",     company: "Estia Health" },
  { tenant: "hammondcare",    wdN: 105, board: "External_Careers",         company: "HammondCare" },
  { tenant: "boltonclarke",   wdN: 105, board: "Careers",                  company: "Bolton Clarke" },
  { tenant: "unitingcareqld", wdN: 105, board: "UnitingCareCareers",       company: "UnitingCare QLD" },
  { tenant: "rsllc",          wdN: 3,   board: "rsllc",                    company: "RSL LifeCare" },
  { tenant: "agecare",        wdN: 10,  board: "AgeCare_Careers_External", company: "AgeCare" },
];

// ── Workday CXS API shapes ────────────────────────────────────────────────────
interface WDListJob {
  title: string;
  externalPath: string;     // e.g. "/job/St-George/Care-Worker_JR7452"
  locationsText?: string;   // facility name(s), e.g. "Elizabeth Lodge, Rushcutters Bay" or "8 Locations"
  bulletFields?: string[];
  postedOn?: string;        // relative, e.g. "Posted 3 Days Ago" — not parseable
}
interface WDListResponse { total?: number; jobPostings?: WDListJob[] }

interface WDDetail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string; // full JD as HTML
    location?: string;       // clean suburb, e.g. "Blacktown"
    startDate?: string;      // ISO date, e.g. "2026-05-25"
    timeType?: string;
    jobReqId?: string;
  };
}

// Browser-ish headers: Workday CXS is open JSON, but a realistic UA avoids the
// occasional datacenter-IP 403. 4xx are swallowed by callers (skip, don't fail).
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const PAGE_LIMIT       = 20;   // Workday hard cap per list call
const MAX_PAGES        = 10;   // safety: up to 200 jobs per tenant
const MAX_DETAIL_FETCH = 40;   // safety: cap full-JD fetches per tenant per run
const DETAIL_DELAY_MS  = 300;  // gentle pacing between detail fetches

function base(tenant: string, wdN: number): string {
  return `https://${tenant}.wd${wdN}.myworkdayjobs.com`;
}

async function fetchPage(
  tenant: string, wdN: number, board: string, offset: number,
): Promise<WDListResponse> {
  const url = `${base(tenant, wdN)}/wday/cxs/${tenant}/${board}/jobs`;
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE_LIMIT, offset, searchText: "" }),
    signal: AbortSignal.timeout(15_000),
  });
  if ([400, 403, 404, 410].includes(res.status)) return {};
  if (!res.ok) throw new Error(`list HTTP ${res.status}`);
  return (await res.json()) as WDListResponse;
}

async function fetchDetail(
  tenant: string, wdN: number, board: string, externalPath: string,
): Promise<WDDetail["jobPostingInfo"] | null> {
  const url = `${base(tenant, wdN)}/wday/cxs/${tenant}/${board}${externalPath}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return ((await res.json()) as WDDetail).jobPostingInfo ?? null;
}

// ── Adapter ───────────────────────────────────────────────────────────────────
export const agedCareWorkdayAdapter: SourceAdapter = {
  name:           "agedcare",
  tier:           2,
  vertical:       "healthcare",
  rateLimitDelay: 500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const { tenant, wdN, board, company } of TENANTS) {
      // 1) Page the cheap LIST endpoint and collect title-matched jobs.
      const matched: { job: WDListJob; group: string }[] = [];
      let total = Infinity;
      let listFailed = false;

      for (let page = 0; page < MAX_PAGES && page * PAGE_LIMIT < total; page++) {
        let resp: WDListResponse;
        try {
          resp = await fetchPage(tenant, wdN, board, page * PAGE_LIMIT);
        } catch (err) {
          console.warn(`[agedcare] ${tenant} list page ${page}: ${err instanceof Error ? err.message : err}`);
          listFailed = true;
          break;
        }
        const postings = resp.jobPostings ?? [];
        if (resp.total !== undefined) total = resp.total;
        if (postings.length === 0) break;

        for (const job of postings) {
          const group = matchRole(job.title ?? "");
          if (group) matched.push({ job, group });
        }
        if (page * PAGE_LIMIT + postings.length >= total) break;
        await sleep(this.rateLimitDelay);
      }

      // If the very first list call failed (network/403), surface it so the
      // orchestrator's failure tracker can back off this source.
      if (listFailed && matched.length === 0) {
        throw new Error(`[agedcare] ${tenant}: list endpoint unreachable`);
      }

      console.log(`[agedcare] ${tenant}: ${matched.length} role-matched titles → fetching JDs`);

      // 2) Spend a DETAIL call (full JD) only on the role-matched jobs.
      let fetched = 0;
      for (const { job, group } of matched) {
        if (fetched >= MAX_DETAIL_FETCH) break;
        let info: WDDetail["jobPostingInfo"] | null = null;
        try {
          info = await fetchDetail(tenant, wdN, board, job.externalPath);
        } catch (err) {
          console.warn(`[agedcare] ${tenant} detail ${job.externalPath}: ${err instanceof Error ? err.message : err}`);
        }
        fetched++;

        const jd = info?.jobDescription ? stripHtml(info.jobDescription) : "";
        // Fall back to list teaser bullets if the detail JD is missing.
        const description = jd || (job.bulletFields ?? []).join(" ");
        const posted_at = info?.startDate
          ? (() => { try { return new Date(info!.startDate!).toISOString(); } catch { return null; } })()
          : null;

        out.push({
          url:         `${base(tenant, wdN)}${job.externalPath}`,
          title:       info?.title ?? job.title,
          company,
          // Prefer the clean detail suburb; fall back to the list facility name.
          location:    info?.location ?? job.locationsText ?? "Australia",
          description,
          source:      "agedcare",
          source_tier: 2,
          posted_at,
          expires_at:  null,
          raw:         { list: job, group, detail: info ?? undefined },
        });

        if (fetched < matched.length) await sleep(DETAIL_DELAY_MS);
      }
    }

    console.log(`[agedcare] done — ${out.length} jobs across ${TENANTS.length} tenant(s)`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { tenant, wdN, board } = TENANTS[0];
      const resp = await fetchPage(tenant, wdN, board, 0);
      return (resp.jobPostings?.length ?? 0) > 0;
    } catch {
      return false;
    }
  },
};
