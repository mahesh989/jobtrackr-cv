// Aged-care direct-from-employer adapter — providers on the Dayforce ATS.
// First tenant: Uniting NSW/ACT (jobs.dayforcehcm.com, namespace unitingaunsw,
// board UNITINGCCS).
//
// Dayforce's candidate-portal search API is public BUT sits behind a CSRF gate
// (next-auth) + Cloudflare bot-management cookies. Validated 2026-06-29: a plain
// server request works once you BOOTSTRAP a session — GET the careers page to
// pick up the __Host-next-auth.csrf-token + __cf_bm cookies, then POST the
// search with the matching x-csrf-token header. No Cloudflare JS challenge / no
// cf_clearance / no TLS impersonation needed (the earlier 403 was a wrong body +
// missing CSRF, not a real block).
//
//   GET  /en-AU/{namespace}/{board}            → cookies incl. csrf token
//   POST /api/geo/{namespace}/jobposting/search → { jobPostings[], maxCount, offset, count }
//
// searchText:"" returns every posting (full jobDescription inline) → role-filter
// by title. 25 postings per response; paginate via paginationStart.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

// client = the {namespace} in the portal URL; board = the candidate-site code
// (jobBoardCode). Both come from the portal URL: /en-AU/{namespace}/{board}.
const CLIENTS: { namespace: string; board: string; company: string }[] = [
  { namespace: "unitingaunsw", board: "UNITINGCCS", company: "Uniting NSW/ACT" }, // ✅ validated 2026-06-29
  // Opal HealthCare is also on Dayforce (namespace opalhealthcare) but its
  // jobBoardCode is unknown — capture it from the portal URL before adding.
];

const PAGE_SIZE  = 25;    // server-fixed page size (response.count)
const MAX_PAGES  = 40;    // 25 × 40 = 1000 safety ceiling
const PAGE_DELAY = 400;
const TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface DFLocation { formattedAddress?: string }
interface DFPosting {
  jobPostingId?: number | string;
  jobReqId?: number | string;
  jobTitle?: string;
  jobDescription?: string;
  postingStartTimestampUTC?: string | null;
  postingExpiryTimestampUTC?: string | null;
  postingLocations?: DFLocation[];
}
interface DFResponse {
  jobPostings?: DFPosting[];
  maxCount?: number;
  offset?: number;
  count?: number;
}

interface Session { cookie: string; csrf: string }

// GET the careers page to obtain a CSRF token + Cloudflare/session cookies.
// Returns null on any failure (caller skips the tenant).
async function bootstrap(namespace: string, board: string): Promise<Session | null> {
  const res = await fetch(`https://jobs.dayforcehcm.com/en-AU/${namespace}/${board}?searchText=`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-AU,en;q=0.9" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  await res.text();

  const jar: Record<string, string> = {};
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const pair = sc.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  jar["NamespaceCookie"] = namespace;

  const csrfRaw = jar["__Host-next-auth.csrf-token"];
  if (!csrfRaw) return null;
  // Cookie value is "<token>|<hash>" (URL-encoded %7C); x-csrf-token = <token>.
  const csrf = decodeURIComponent(csrfRaw).split("|")[0];
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return { cookie, csrf };
}

async function search(namespace: string, board: string, sess: Session, paginationStart: number): Promise<DFResponse> {
  const res = await fetch(`https://jobs.dayforcehcm.com/api/geo/${namespace}/jobposting/search`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-AU,en;q=0.9",
      Origin: "https://jobs.dayforcehcm.com",
      Referer: `https://jobs.dayforcehcm.com/en-AU/${namespace}/${board}`,
      "X-CSRF-Token": sess.csrf,
      Cookie: sess.cookie,
    },
    body: JSON.stringify({
      clientNamespace: namespace,
      jobBoardCode:    board,
      cultureCode:     "en-AU",
      searchText:      "",
      distanceUnit:    1,
      paginationStart,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if ([400, 401, 403, 404, 410].includes(res.status)) return {};
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return (await res.json()) as DFResponse;
}

function isoOrNull(ts?: string | null): string | null {
  if (!ts) return null;
  try { return new Date(ts).toISOString(); } catch { return null; }
}

export const agedCareDayforceAdapter: SourceAdapter = {
  name:           "agedcare_dayforce",
  tier:           2,
  vertical:       "healthcare",
  rateLimitDelay: 400,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const { namespace, board, company } of CLIENTS) {
      let sess: Session | null;
      try {
        sess = await bootstrap(namespace, board);
      } catch (err) {
        console.warn(`[agedcare-dayforce] ${company}: bootstrap failed — ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!sess) {
        console.warn(`[agedcare-dayforce] ${company}: no CSRF session (skipped)`);
        continue;
      }

      let listed = 0;
      let matched = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        let resp: DFResponse;
        try {
          resp = await search(namespace, board, sess, page * PAGE_SIZE);
        } catch (err) {
          console.warn(`[agedcare-dayforce] ${company} offset ${page * PAGE_SIZE}: ${err instanceof Error ? err.message : err}`);
          break;
        }
        const list = resp.jobPostings ?? [];
        if (list.length === 0) break;
        listed += list.length;

        for (const p of list) {
          const title = p.jobTitle ?? "";
          if (!matchRole(title)) continue;

          const location = p.postingLocations?.[0]?.formattedAddress || "Australia";
          out.push({
            url:         `https://jobs.dayforcehcm.com/en-AU/${namespace}/${board}/jobs/${p.jobPostingId ?? ""}`,
            title,
            company,
            location,
            description: p.jobDescription ? stripHtml(p.jobDescription) : "",
            source:      "agedcare",
            source_tier: 2,
            posted_at:   isoOrNull(p.postingStartTimestampUTC),
            expires_at:  isoOrNull(p.postingExpiryTimestampUTC),
            raw:         { jobPostingId: p.jobPostingId, jobReqId: p.jobReqId },
          });
          matched++;
        }

        const offset = resp.offset ?? page * PAGE_SIZE;
        const total  = resp.maxCount ?? 0;
        if (offset + list.length >= total) break;   // reached the end
        await sleep(PAGE_DELAY);
      }

      console.log(`[agedcare-dayforce] ${company}: ${listed} listed → ${matched} role-matched with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[agedcare-dayforce] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const sess = await bootstrap(CLIENTS[0].namespace, CLIENTS[0].board);
      if (!sess) return false;
      const r = await search(CLIENTS[0].namespace, CLIENTS[0].board, sess, 0);
      return (r.jobPostings?.length ?? 0) >= 0;
    } catch {
      return false;
    }
  },
};
