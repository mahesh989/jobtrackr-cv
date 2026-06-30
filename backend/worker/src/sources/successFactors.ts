// SuccessFactors (SAP) ATS adapter — aged-care employers on SuccessFactors
// "Career Site Builder" (CSB) career sites. First tenant: Australian Unity
// (careers.australianunity.com.au).
//
// Why SuccessFactors is a PRIME target: it's one of the most common enterprise
// ATSs in AU, so ONE adapter unlocks MANY aged-care providers (the same leverage
// Workday gave us). Adding a provider = one row in ORGS (after the 2-curl recon).
//
// Expected shape (RECON before trusting — see docs/aged-care-scraping-handoff.md):
//   CSB sites server-render the job list and, like Radancy/Avature, embed a clean
//   schema.org JSON-LD JobPosting on each DETAIL page (CSB adds it for SEO). So:
//     1. LIST   GET /search/?q=&startrow=N  (25/page; paginate via startrow)
//               → server-rendered HTML with /job/{slug}/{id} links
//     2. DETAIL GET {job link}
//               → <script type="application/ld+json"> "@type":"JobPosting" → full JD
//   Approach mirrors radancy.ts: collect links → role-taxonomy pre-filter on the
//   de-slugged path → fetch detail → JSON-LD JD → AU-country filter.
//
// Bot layer: CSB sits behind Imperva (visid_incap/incap_ses) — the SAME passive
// layer we beat on Bupa/Radancy with a realistic UA and no cookie. If a SEQUENCE
// of fetches starts returning challenge interstitials (like Clinch's AWS WAF),
// this adapter will need a cookie bootstrap or headless path; until then plain
// fetch + browser UA is expected to pass (validate live).
//
// ⚠ UNVALIDATED as of 2026-06-30 — built from the documented SF CSB pattern, not
// yet confirmed against Australian Unity. The user must run the recon + test
// (testSuccessFactors.ts) on a residential IP before this is trusted. Fails safe
// (returns [] / throws → orchestrator skips), so enabling cannot break runs.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org { host: string; company: string }

const ORGS: Org[] = [
  { host: "careers.australianunity.com.au", company: "Australian Unity" }, // ⚠ UNVALIDATED
];

const TIMEOUT_MS   = 15_000;
const PAGE_SIZE    = 25;    // CSB default block size; paginate via ?startrow=
const MAX_PAGES    = 40;    // 25 × 40 = 1000 safety ceiling; loop breaks early when a page yields no new links
const DETAIL_DELAY_MS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// CSB job-detail links: /job/{location-slug}/{title-slug}/{jobId}/ (trailing
// slash optional). The trailing numeric id is the stable de-dupe key. We tolerate
// 2–4 path segments after /job/ so URL-shape variance across tenants doesn't
// drop jobs; the JSON-LD title is the authoritative role re-check below.
const JOB_LINK_RE = /\/job\/([A-Za-z0-9][A-Za-z0-9\-/_]*?\/\d+)\/?/gi;
const JOB_ID_RE   = /\/(\d+)\/?$/;

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

function addrCountry(a?: { addressCountry?: string | { name?: string } }): string {
  if (!a?.addressCountry) return "";
  return typeof a.addressCountry === "string" ? a.addressCountry : a.addressCountry.name ?? "";
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
    } catch { /* skip malformed JSON-LD */ }
  }
  return null;
}

// "/job/Sydney-NSW-Australia/Registered-Nurse/12345/" → "Sydney NSW Australia
// Registered Nurse 12345" — a superset to role-filter on cheaply before spending
// a detail fetch. Location slugs never match the role taxonomy, so this is
// effectively a title pre-filter that's robust to CSB URL-shape differences.
function pathToWords(path: string): string {
  return path.replace(/^\/job\//i, "").replace(/[/_-]+/g, " ").trim();
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/json",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return { status: res.status, body: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

function searchUrl(host: string, startrow: number): string {
  const params = new URLSearchParams({
    q: "",
    sortColumn: "referencedate",
    sortDirection: "desc",
    startrow: String(startrow),
  });
  return `https://${host}/search/?${params.toString()}`;
}

// Collect job-detail links across pages. jobId (trailing number) → path.
async function collectLinks(o: Org): Promise<Map<string, string>> {
  const links = new Map<string, string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    let body = "";
    try {
      ({ body } = await fetchText(searchUrl(o.host, page * PAGE_SIZE), {
        Referer: `https://${o.host}/search/`,
      }));
    } catch { break; }
    if (!body) break;

    const before = links.size;
    let m: RegExpExecArray | null;
    const re = new RegExp(JOB_LINK_RE.source, "gi");
    while ((m = re.exec(body)) !== null) {
      const path = `/job/${m[1]}`;
      const id = JOB_ID_RE.exec(path)?.[1];
      if (id && !links.has(id)) links.set(id, path);
    }
    if (links.size === before) break;   // no new links on this page → done
    await sleep(400);
  }

  return links;
}

export const successFactorsAdapter: SourceAdapter = {
  name:           "successfactors",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1200,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      let links: Map<string, string>;
      try {
        links = await collectLinks(o);
      } catch (err) {
        console.warn(`[successfactors] ${o.company}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      // Cheap pre-filter on the de-slugged path to skip detail fetches for
      // non-care roles (finance, IT, customer service, etc.).
      const candidates = [...links.entries()].filter(([, path]) => matchRole(pathToWords(path)));
      console.log(`[successfactors] ${o.company}: ${links.size} links → ${candidates.length} role-matched → fetching JDs`);

      let added = 0;
      for (const [jobId, path] of candidates) {
        const url = `https://${o.host}${path}`;
        let body = "";
        try {
          ({ body } = await fetchText(url));
        } catch { continue; }
        if (!body) continue;

        const jp = extractJobPosting(body);
        if (!jp?.title || !matchRole(jp.title)) continue;

        const addr = firstAddress(jp);
        // Keep AU only (Australian Unity is AU-only, but be safe for future tenants).
        const country = addrCountry(addr);
        if (country && !/austral/i.test(country)) continue;
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
      console.log(`[successfactors] ${o.company}: ${added} jobs with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[successfactors] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { body } = await fetchText(searchUrl(ORGS[0].host, 0));
      return body.includes("/job/");
    } catch {
      return false;
    }
  },
};
