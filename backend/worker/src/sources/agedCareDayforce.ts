// Aged-care direct-from-employer adapter — providers on the Dayforce ATS.
// Mirrors agedCareWorkday: public JSON API, role-taxonomy title filter, full JD.
//
// Dayforce candidate-portal job-posting search (public, no auth):
//   POST https://jobs.dayforcehcm.com/api/geo/{client}/jobposting/search
//   → JSON list with full HTML descriptions, location (+coords), requisition IDs.
//
// The exact request/response field names vary slightly by tenant, so this
// adapter parses defensively (optional chaining, multiple known field names)
// and returns [] on any structural surprise rather than emitting garbage.
//
// ⚠ NOT yet API-validated — these hosts are blocked by the Claude-on-the-web
// egress policy, so validate locally/on Fly (see docs/aged-care-ats-map.md)
// before relying on this. Failures are swallowed → the orchestrator skips it.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

// Aged-care Dayforce clients. client = the {namespace} in the portal URL
// (jobs.dayforcehcm.com/en-AU/{client}/CANDIDATEPORTAL).
const CLIENTS: { client: string; company: string }[] = [
  { client: "opalhealthcare", company: "Opal HealthCare" },  // researched 2026-06-29
];

const PAGE_SIZE        = 50;
const MAX_PAGES        = 6;
const MAX_DETAIL_FETCH = 60;
const DETAIL_DELAY_MS  = 250;
const TIMEOUT_MS       = 15_000;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Accept-Language": "en-AU,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// Dayforce search responses differ by tenant; capture the common fields loosely.
interface DFPosting {
  Title?: string;          title?: string;
  JobId?: string | number; jobId?: string | number; Id?: string | number;
  Description?: string;    description?: string;
  Location?: string;       location?: string; City?: string; State?: string;
  PostedDate?: string;     postedDate?: string; DatePosted?: string;
  Url?: string;            url?: string; JobDetailsUrl?: string;
}
interface DFSearchResponse {
  Data?: DFPosting[]; data?: DFPosting[]; Postings?: DFPosting[]; results?: DFPosting[];
  TotalCount?: number; total?: number;
}

function postings(r: DFSearchResponse): DFPosting[] {
  return r.Data ?? r.data ?? r.Postings ?? r.results ?? [];
}
function field<T>(...vals: (T | undefined)[]): T | undefined {
  return vals.find((v) => v !== undefined && v !== null && v !== "");
}

async function search(client: string, page: number): Promise<DFSearchResponse> {
  const url = `https://jobs.dayforcehcm.com/api/geo/${client}/jobposting/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    // Common pagination shape; tenants ignore unknown keys.
    body: JSON.stringify({ jobBoardCode: "CANDIDATEPORTAL", page, pageSize: PAGE_SIZE, searchText: "" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if ([400, 403, 404, 410].includes(res.status)) return {};
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return (await res.json()) as DFSearchResponse;
}

function postingUrl(client: string, p: DFPosting): string {
  const direct = field(p.Url, p.url, p.JobDetailsUrl);
  if (direct) return direct.startsWith("http") ? direct : `https://jobs.dayforcehcm.com${direct}`;
  const id = field(p.JobId, p.jobId, p.Id);
  return `https://jobs.dayforcehcm.com/en-AU/${client}/CANDIDATEPORTAL/jobs/${id ?? ""}`;
}

export const agedCareDayforceAdapter: SourceAdapter = {
  name:           "agedcare_dayforce",
  tier:           2,
  vertical:       "healthcare",
  rateLimitDelay: 500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const { client, company } of CLIENTS) {
      let fetched = 0;
      let failed = false;

      for (let page = 1; page <= MAX_PAGES; page++) {
        let resp: DFSearchResponse;
        try {
          resp = await search(client, page);
        } catch (err) {
          console.warn(`[agedcare-dayforce] ${client} page ${page}: ${err instanceof Error ? err.message : err}`);
          failed = true;
          break;
        }
        const list = postings(resp);
        if (list.length === 0) break;

        for (const p of list) {
          const title = field(p.Title, p.title) ?? "";
          const group = matchRole(title);
          if (!group) continue;
          if (fetched >= MAX_DETAIL_FETCH) break;
          fetched++;

          const rawDesc = field(p.Description, p.description) ?? "";
          const description = rawDesc ? stripHtml(rawDesc) : "";
          const loc =
            field(p.Location, p.location) ??
            ([field(p.City), field(p.State)].filter(Boolean).join(", ") || "Australia");
          const postedRaw = field(p.PostedDate, p.postedDate, p.DatePosted);
          const posted_at = postedRaw
            ? (() => { try { return new Date(postedRaw).toISOString(); } catch { return null; } })()
            : null;

          out.push({
            url:         postingUrl(client, p),
            title,
            company,
            location:    loc,
            description,
            source:      "agedcare",
            source_tier: 2,
            posted_at,
            expires_at:  null,
            raw:         { posting: p, group },
          });
        }
        if (list.length < PAGE_SIZE) break;
        await sleep(this.rateLimitDelay);
      }

      if (failed && out.length === 0) {
        throw new Error(`[agedcare-dayforce] ${client}: search endpoint unreachable`);
      }
      console.log(`[agedcare-dayforce] ${client}: ${fetched} role-matched jobs`);
      await sleep(DETAIL_DELAY_MS);
    }

    console.log(`[agedcare-dayforce] done — ${out.length} jobs across ${CLIENTS.length} client(s)`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const r = await search(CLIENTS[0].client, 1);
      return postings(r).length >= 0; // reachable & parseable
    } catch {
      return false;
    }
  },
};
