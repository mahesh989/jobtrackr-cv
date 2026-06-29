// Avature ATS adapter — aged-care providers on Avature career sites.
// Boards live at https://{tenant}.avature.net/{site}/ with a SearchJobs listing
// and JobDetail pages. Most Avature sites embed schema.org JobPosting JSON-LD on
// detail pages (for SEO), so we use the same generic JSON-LD extraction as the
// PageUp/Scout Talent adapters + the shared role-taxonomy title filter.
//
// ⚠ NOT yet validated (egress-blocked here). Fail-safe: HTTP/parse problems
// yield [] → the orchestrator skips the source. Avature listing/detail URL
// shapes vary by tenant; validate per provider (see docs/aged-care-ats-map.md).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org {
  tenant:  string;            // {tenant}.avature.net
  site:    string;            // path segment, e.g. "careers"
  company: string;
  listing?: string;           // override listing path
}

const ORGS: Org[] = [
  { tenant: "regis", site: "careers", company: "Regis Aged Care", listing: "/careers/SearchJobs/" }, // researched 2026-06-29
];

const TIMEOUT_MS       = 15_000;
const MAX_JOBS_PER_ORG = 40;
const DETAIL_DELAY_MS  = 600;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function origin(o: Org): string { return `https://${o.tenant}.avature.net`; }
function listingUrl(o: Org): string { return `${origin(o)}${o.listing ?? `/${o.site}/SearchJobs/`}`; }

// Avature job-detail links: .../careers/JobDetail/{slug}/{id} (sometimes /Job/).
const JOB_LINK_RE = /href="((?:https?:\/\/[^"]+)?\/[^"]*\/(?:JobDetail|Job)\/[^"]+)"/gi;

interface JsonLdJobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string } }
    | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
  url?: string;
}

function extractJsonLd(html: string): JsonLdJobPosting[] {
  const results: JsonLdJobPosting[] = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      for (const item of (Array.isArray(data) ? data : [data])) {
        if (item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "JobPosting") {
          results.push(item as JsonLdJobPosting);
        }
      }
    } catch { /* malformed — skip */ }
  }
  return results;
}

function locationFromJsonLd(jl: JsonLdJobPosting): string {
  const loc = jl.jobLocation;
  if (!loc) return "Australia";
  const addr = Array.isArray(loc) ? loc[0]?.address : loc.address;
  if (!addr) return "Australia";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Australia";
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const avatureAdapter: SourceAdapter = {
  name:           "avature",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const jobs: RawJob[] = [];

    for (const o of ORGS) {
      let listing: string;
      try {
        listing = await fetchText(listingUrl(o));
      } catch (err) {
        console.warn(`[avature] ${o.company}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!listing) continue;

      const links = new Set<string>();
      let m: RegExpExecArray | null;
      const re = new RegExp(JOB_LINK_RE.source, "gi");
      while ((m = re.exec(listing)) !== null && links.size < MAX_JOBS_PER_ORG) {
        links.add(m[1].startsWith("http") ? m[1] : `${origin(o)}${m[1]}`);
      }
      if (links.size === 0) continue;

      await sleep(this.rateLimitDelay);

      let added = 0;
      for (const url of links) {
        let body: string;
        try { body = await fetchText(url); } catch { continue; }
        if (!body) continue;

        for (const p of extractJsonLd(body)) {
          if (!p.title || !matchRole(p.title)) continue;
          jobs.push({
            url:         p.url ?? url,
            title:       p.title,
            company:     p.hiringOrganization?.name ?? o.company,
            location:    locationFromJsonLd(p),
            description: p.description ? stripHtml(p.description) : "",
            source:      "agedcare",
            source_tier: 3,
            posted_at:   p.datePosted ?? null,
            expires_at:  p.validThrough ?? null,
            raw:         p,
          });
          added++;
        }
        await sleep(DETAIL_DELAY_MS);
      }
      console.log(`[avature] ${o.company}: ${added} role-matched jobs`);
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      return (await fetchText(listingUrl(ORGS[0]))).length > 0;
    } catch {
      return false;
    }
  },
};
