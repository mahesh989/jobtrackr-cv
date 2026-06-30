// Scout Talent ATS adapter — AU aged care, NFP, and community services.
// Scout Talent is confirmed heavily used across NFP aged care. Client boards
// are reached at https://{slug}.scouttalent.com.au/ (override via `domain`).
// Tries JSON-LD (schema.org JobPosting) extraction first; falls back to anchor
// scan. Role-taxonomy title filter (shared with the other aged-care adapters).
//
// ⚠ slug/domain list is researched, NOT yet validated (egress-blocked here).
// Fail-safe: HTTP/parse problems yield [] → orchestrator skips the source.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml } from "./agedCareRoles.js";

interface OrgConfig {
  slug: string;
  company: string;
  domain?: string; // override when not {slug}.scouttalent.com.au
}

// AU organisations using Scout Talent. Add slugs as discovered.
const ORGS: OrgConfig[] = [
  { slug: "cocqld",           company: "Churches of Christ Queensland" },
  { slug: "unitingcareqld",   company: "UnitingCare Queensland" },
  { slug: "catholiccare",     company: "CatholicCare" },
  { slug: "hbfhealth",        company: "HBF Health" },
  { slug: "ozcare",           company: "Ozcare" },
  { slug: "anglicancare",     company: "Anglican Care" },
  { slug: "missionaustralia", company: "Mission Australia" },
  { slug: "salvationarmy",    company: "The Salvation Army Australia" },
  { slug: "acap",             company: "ACAP" },
  { slug: "baptistcarent",    company: "BaptistCare NT" },
  { slug: "lifeline",         company: "Lifeline Australia" },
  { slug: "rspcaqld",         company: "RSPCA Queensland" },
  { slug: "wesleymission",    company: "Wesley Mission" },
];

const TIMEOUT_MS = 15_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

interface JsonLdJob {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  url?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string } } | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
}

function extractJsonLd(html: string): JsonLdJob[] {
  const results: JsonLdJob[] = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "JobPosting") {
          results.push(item as JsonLdJob);
        }
      }
    } catch { /* malformed — skip */ }
  }
  return results;
}

function locationFromJsonLd(jl: JsonLdJob): string {
  const loc = jl.jobLocation;
  if (!loc) return "Australia";
  const addr = Array.isArray(loc) ? loc[0]?.address : (loc as { address?: { addressLocality?: string; addressRegion?: string } }).address;
  if (!addr) return "Australia";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Australia";
}

function orgDomain(org: OrgConfig): string {
  return org.domain ?? `${org.slug}.scouttalent.com.au`;
}

async function fetchListings(org: OrgConfig): Promise<string> {
  const res = await fetch(`https://${orgDomain(org)}/`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${org.slug}`);
  return res.text();
}

export const scoutTalentAdapter: SourceAdapter = {
  name: "scout_talent",
  tier: 3,
  vertical: "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const jobs: RawJob[] = [];

    for (const org of ORGS) {
      let html: string;
      try {
        html = await fetchListings(org);
      } catch (err) {
        console.warn(`[scout_talent] ${org.slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!html) continue;

      const domain = orgDomain(org);
      const postings = extractJsonLd(html);

      if (postings.length > 0) {
        for (const p of postings) {
          if (!p.title || !matchRole(p.title)) continue;
          jobs.push({
            url: p.url ?? `https://${domain}/`,
            title: p.title,
            company: p.hiringOrganization?.name ?? org.company,
            location: locationFromJsonLd(p),
            description: p.description ? stripHtml(p.description) : "",
            source: "agedcare",
            source_tier: 3,
            posted_at: p.datePosted ?? null,
            expires_at: p.validThrough ?? null,
            raw: p,
          });
        }
      } else {
        // Fallback: scan for job detail anchor links
        const re = /href="(\/(?:jobs|vacancies|apply)[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          const title = m[2].trim();
          if (!matchRole(title)) continue;
          jobs.push({
            url: `https://${domain}${m[1]}`,
            title,
            company: org.company,
            location: "Australia",
            description: "",
            source: "agedcare",
            source_tier: 3,
            posted_at: null,
            expires_at: null,
            raw: {},
          });
        }
      }

      await new Promise((r) => setTimeout(r, this.rateLimitDelay));
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const html = await fetchListings(ORGS[0]);
      return html.length > 0;
    } catch {
      return false;
    }
  },
};
