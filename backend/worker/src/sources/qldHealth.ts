// QLD Health adapter — SmartJobs Queensland filtered to Queensland Health.
// Complements qldGovRss (which covers all QLD government jobs via RSS) with a
// targeted HTML scrape of SmartJobs scoped to Queensland Health specifically.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

const BASE_URL = "https://smartjobs.qld.gov.au";
const TIMEOUT_MS = 20_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

// SmartJobs Queensland Health specific search — organisation filter.
// Multiple URL patterns tried in order (SmartJobs has changed URL structure over time).
function buildSearchUrls(keywords: string[]): string[] {
  const kw = encodeURIComponent(keywords.slice(0, 3).join(" "));
  return [
    `${BASE_URL}/jobs?keyword=${kw}&category=Health+%26+Medical&organisation=Queensland+Health`,
    `${BASE_URL}/jobs?keyword=${kw}&department=Queensland+Health`,
    `${BASE_URL}/jobs/search?q=${kw}&orgId=QHEALTH`,
  ];
}

interface JsonLdJob {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  url?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string } };
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
    } catch { /* skip */ }
  }
  return results;
}

function locationFromJsonLd(jl: JsonLdJob): string {
  const addr = jl.jobLocation?.address;
  if (!addr) return "Queensland";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Queensland";
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

const QLD_HEALTH_ORG_RE = /queensland\s*health/i;

export const qldHealthAdapter: SourceAdapter = {
  name: "qld_health",
  tier: 4,
  vertical: "healthcare",
  rateLimitDelay: 2000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const url of buildSearchUrls(profile.keywords)) {
      let html: string;
      try {
        html = await fetchHtml(url);
      } catch {
        continue;
      }
      if (!html) continue;

      const postings = extractJsonLd(html);
      if (postings.length > 0) {
        for (const p of postings) {
          if (!p.title) continue;
          // Filter to Queensland Health jobs only
          if (p.hiringOrganization?.name && !QLD_HEALTH_ORG_RE.test(p.hiringOrganization.name)) continue;
          const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
          if (!kwLower.some((kw) => text.includes(kw))) continue;
          jobs.push({
            url: p.url ?? url,
            title: p.title,
            company: p.hiringOrganization?.name ?? "Queensland Health",
            location: locationFromJsonLd(p),
            description: p.description ?? "",
            source: "qld_health",
            source_tier: 4,
            posted_at: p.datePosted ?? null,
            expires_at: p.validThrough ?? null,
            raw: p,
          });
        }
        break; // got results from this URL variant — no need to try others
      }

      // Fallback anchor scan
      const re = /href="(\/jobs\/[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const title = m[2].trim();
        if (!kwLower.some((kw) => title.toLowerCase().includes(kw))) continue;
        jobs.push({
          url: `${BASE_URL}${m[1]}`,
          title,
          company: "Queensland Health",
          location: "Queensland",
          description: "",
          source: "qld_health",
          source_tier: 4,
          posted_at: null,
          expires_at: null,
          raw: {},
        });
      }

      if (jobs.length > 0) break;
      await new Promise((r) => setTimeout(r, this.rateLimitDelay));
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/jobs`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
