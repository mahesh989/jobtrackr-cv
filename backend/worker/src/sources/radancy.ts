// Radancy (TalentBrew) ATS adapter — aged-care employers on Radancy career sites.
// First tenant: Bupa AU (careers.bupa.com.au) — Bupa's AU aged-care roles live
// here, NOT on its Workday board (bupa.wd3 is UK/global, zero AU jobs).
//
// Radancy/TalentBrew is SEO-driven, so every job DETAIL page embeds a clean
// schema.org JSON-LD JobPosting (full HTML JD + structured address w/ country +
// datePosted) — verified 2026-06-29. The listing renders real /job/ links
// server-side. So: collect job links (paginate via the /search-jobs/results AJAX
// endpoint, fall back to the static page) → role-taxonomy pre-filter on the link
// slug → fetch detail → JSON-LD → full JD.
//
// Job URL shape: /job/{city}/{slug}/{companyId}/{jobId}

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org { host: string; company: string }

const ORGS: Org[] = [
  { host: "careers.bupa.com.au", company: "Bupa Aged Care" },
];

const TIMEOUT_MS      = 15_000;
const RECORDS_PER_PAGE = 15;    // Radancy serves 15/page; asking for 100 returns a degenerate response
const MAX_PAGES        = 40;    // 15 × 40 = 600 safety ceiling (Bupa AU ≈ 269 links / ~18 pages); loop breaks early when a page yields no new links
const DETAIL_DELAY_MS  = 300;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// /job/{city}/{slug}/{companyId}/{jobId}
const JOB_LINK_RE = /\/job\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d+)\/(\d+)/gi;

interface JsonLdJobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }
    | Array<{ address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }>;
}

function firstAddress(jl: JsonLdJobPosting) {
  const loc = jl.jobLocation;
  if (!loc) return undefined;
  return Array.isArray(loc) ? loc[0]?.address : loc.address;
}

function extractJobPosting(html: string): JsonLdJobPosting | null {
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      for (const item of (Array.isArray(data) ? data : [data])) {
        if (item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "JobPosting") {
          return item as JsonLdJobPosting;
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

function slugToTitle(slug: string): string {
  return slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return { status: res.status, body: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

// The /search-jobs/results AJAX endpoint requires the FULL browser query string
// (verified via DevTools "Copy as cURL", 2026-06-29) — SearchType=5 plus the
// distance/sort/facet params. Sending only CurrentPage returns a degenerate
// 3-job response. Only CurrentPage varies per page.
function resultsUrl(host: string, page: number): string {
  const params = new URLSearchParams({
    ActiveFacetID:           "0",
    CurrentPage:             String(page),
    RecordsPerPage:          String(RECORDS_PER_PAGE),
    TotalContentResults:     "",
    Distance:                "50",
    RadiusUnitType:          "0",
    Keywords:                "",
    Location:                "",
    ShowRadius:              "False",
    IsPagination:            "False",
    CustomFacetName:         "",
    FacetTerm:               "",
    FacetType:               "0",
    SearchResultsModuleName: "Search Results",
    SearchFiltersModuleName: "Search Filters",
    SortCriteria:            "0",
    SortDirection:           "0",
    SearchType:              "5",
    PostalCode:              "",
    ResultsType:             "0",
    fc:                      "",
    fl:                      "",
    fcf:                     "",
    afc:                     "",
    afl:                     "",
    afcf:                    "",
    TotalContentPages:       "NaN",
  });
  return `https://${host}/search-jobs/results?${params.toString()}`;
}

// Collect job-detail hrefs across pages. Prefer the /results AJAX endpoint
// (returns rendered job HTML inside a JSON "results" field); fall back to the
// static /search-jobs page (page 1 only).
async function collectLinks(o: Org): Promise<Map<string, { slug: string; path: string }>> {
  const links = new Map<string, { slug: string; path: string }>();   // jobId → {slug,path}

  const harvest = (html: string): number => {
    const before = links.size;
    let m: RegExpExecArray | null;
    const re = new RegExp(JOB_LINK_RE.source, "gi");
    while ((m = re.exec(html)) !== null) {
      const [path, , slug, , jobId] = m;
      if (!links.has(jobId)) links.set(jobId, { slug, path });
    }
    return links.size - before;
  };

  const ajaxHeaders = {
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/json; charset=utf-8",
    Accept: "*/*",
    Referer: `https://${o.host}/search-jobs`,
  };

  for (let page = 1; page <= MAX_PAGES; page++) {
    let body = "";
    try {
      ({ body } = await fetchText(resultsUrl(o.host, page), ajaxHeaders));
    } catch { break; }
    if (!body) break;

    let resultsHtml = body;
    try {
      const j = JSON.parse(body) as { results?: string };
      resultsHtml = j.results ?? "";
    } catch { /* not JSON — treat body as HTML */ }
    if (!resultsHtml) break;

    if (harvest(resultsHtml) === 0) break;   // no new links → done
    await sleep(400);
  }

  // Fallback: static page if the AJAX endpoint yielded nothing.
  if (links.size === 0) {
    try {
      const { body } = await fetchText(`https://${o.host}/search-jobs`);
      harvest(body);
    } catch { /* give up */ }
  }

  return links;
}

export const radancyAdapter: SourceAdapter = {
  name:           "radancy",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1200,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      let links: Map<string, { slug: string; path: string }>;
      try {
        links = await collectLinks(o);
      } catch (err) {
        console.warn(`[radancy] ${o.company}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      // Cheap pre-filter on the slug title to avoid detail fetches for
      // non-care roles (dental, GP, customer service, etc.).
      const candidates = [...links.entries()].filter(([, v]) => matchRole(slugToTitle(v.slug)));
      console.log(`[radancy] ${o.company}: ${links.size} links → ${candidates.length} role-matched → fetching JDs`);

      let added = 0;
      for (const [jobId, { path }] of candidates) {
        const url = `https://${o.host}${path}`;
        let body = "";
        try {
          ({ body } = await fetchText(url));
        } catch { continue; }
        if (!body) continue;

        const jp = extractJobPosting(body);
        if (!jp?.title || !matchRole(jp.title)) continue;

        const addr = firstAddress(jp);
        // Keep AU only (Bupa AU site should be all-AU, but be safe).
        if (addr?.addressCountry && !/austral/i.test(addr.addressCountry)) continue;
        const location = [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(", ") || "Australia";

        out.push({
          url,
          title:       jp.title,
          company:     jp.hiringOrganization?.name ?? o.company,
          location,
          description: jp.description ? stripHtml(jp.description) : "",
          source:      "agedcare",
          source_tier: 3,
          posted_at:   jp.datePosted ?? null,
          expires_at:  jp.validThrough ?? null,
          raw:         { jobId, path, jsonld: jp },
        });
        added++;
        await sleep(DETAIL_DELAY_MS);
      }
      console.log(`[radancy] ${o.company}: ${added} jobs with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[radancy] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { body } = await fetchText(`https://${ORGS[0].host}/search-jobs`);
      return body.includes("/job/");
    } catch {
      return false;
    }
  },
};
