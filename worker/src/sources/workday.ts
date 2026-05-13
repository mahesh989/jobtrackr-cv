// Workday enterprise ATS adapter — public CXS JSON API, no auth required.
// Covers ~30% of AU enterprise companies. POST endpoint returns structured JSON.
// 404/403 responses are silently skipped so stale tenant/board combos don't block the run.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

const AU_RE = /\b(australia|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|remote.{0,20}au)\b/i;

// Known AU enterprise Workday tenants. wdN = version suffix in subdomain (1, 3, 5…).
// Keep ordered: highest AU job volume first.
const ORGS: { tenant: string; board: string; wdN: number; company: string }[] = [
  { tenant: "cba",            board: "CommBank_Careers",  wdN: 3, company: "Commonwealth Bank" },
  { tenant: "anz",            board: "External",           wdN: 3, company: "ANZ" },
  { tenant: "westpac",        board: "wespac",             wdN: 3, company: "Westpac" },
  { tenant: "nab",            board: "nab_careers",        wdN: 3, company: "NAB" },
  { tenant: "telstra",        board: "External",           wdN: 3, company: "Telstra" },
  { tenant: "bhpbilliton",    board: "External",           wdN: 3, company: "BHP" },
  { tenant: "woolworths",     board: "External",           wdN: 3, company: "Woolworths Group" },
  { tenant: "wesfarmers",     board: "External",           wdN: 3, company: "Wesfarmers" },
  { tenant: "optus",          board: "External",           wdN: 3, company: "Optus" },
  { tenant: "medibank",       board: "External",           wdN: 3, company: "Medibank" },
  { tenant: "qantas",         board: "qantas",             wdN: 3, company: "Qantas" },
  { tenant: "agl",            board: "External",           wdN: 3, company: "AGL Energy" },
  { tenant: "suncorp",        board: "External",           wdN: 3, company: "Suncorp" },
  { tenant: "iag",            board: "External",           wdN: 3, company: "IAG" },
  { tenant: "macquarie",      board: "External",           wdN: 3, company: "Macquarie Group" },
  { tenant: "kpmgaustralia",  board: "External",           wdN: 3, company: "KPMG Australia" },
  { tenant: "deloitte",       board: "External",           wdN: 1, company: "Deloitte" },
  { tenant: "pwcaustralia",   board: "External",           wdN: 3, company: "PwC Australia" },
  { tenant: "ey",             board: "au-eycareer-en",     wdN: 5, company: "EY Australia" },
  { tenant: "transurban",     board: "External",           wdN: 3, company: "Transurban" },
];

interface WDJob {
  title: string;
  locationsText: string;
  postedOn: string;
  bulletFields: string[];
  externalPath: string;
}

interface WDResponse {
  jobPostings: WDJob[];
  total: number;
}

async function fetchBoard(tenant: string, board: string, wdN: number): Promise<WDJob[]> {
  const url = `https://${tenant}.wd${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${board}/jobs`;
  const res = await fetch(url, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      Accept: "application/json",
      "Accept-Language": "en-US"
    },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
    signal: AbortSignal.timeout(15_000),
  });
  if ([400, 403, 404, 410].includes(res.status)) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as WDResponse).jobPostings ?? [];
}

export const workdayAdapter: SourceAdapter = {
  name: "workday",
  tier: 2,
  vertical: "tech",
  rateLimitDelay: 500,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { tenant, board, wdN, company } of ORGS) {
      let postings: WDJob[];
      try {
        postings = await fetchBoard(tenant, board, wdN);
      } catch (err) {
        console.warn(`[workday] ${tenant}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const p of postings) {
        if (!AU_RE.test(p.locationsText ?? "")) continue;
        const desc = (p.bulletFields ?? []).join(" ");
        const text = `${p.title} ${desc}`.toLowerCase();
        if (!kwLower.some((kw) => text.includes(kw))) continue;

        jobs.push({
          url: `https://${tenant}.wd${wdN}.myworkdayjobs.com${p.externalPath}`,
          title: p.title,
          company,
          location: p.locationsText ?? "Australia",
          description: desc,
          source: "workday",
          source_tier: 2,
          posted_at: null, // Workday returns relative strings like "Posted 3 Days Ago"
          expires_at: null,
          raw: p,
        });
      }

      if (postings.length > 0) {
        await new Promise((r) => setTimeout(r, this.rateLimitDelay));
      }
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      await fetchBoard("cba", "CommBank_Careers", 3);
      return true;
    } catch {
      return false;
    }
  },
};
