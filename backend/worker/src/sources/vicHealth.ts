// VIC Health adapter — careers.healthvic.gov.au (Jobs Victoria Health portal).
// Covers Victorian public hospitals, health services, and ambulance services.
// JSON-LD extraction primary; falls back to anchor scan.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

const BASE_URL = "https://careers.healthvic.gov.au";
const TIMEOUT_MS = 20_000;
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
    } catch { /* skip */ }
  }
  return results;
}

function locationFromJsonLd(jl: JsonLdJob): string {
  const loc = jl.jobLocation;
  if (!loc) return "Victoria";
  const addr = Array.isArray(loc) ? loc[0]?.address : (loc as { address?: { addressLocality?: string; addressRegion?: string } }).address;
  if (!addr) return "Victoria";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Victoria";
}

function buildSearchUrl(keywords: string[]): string {
  const q = keywords.slice(0, 3).join(" ");
  return `${BASE_URL}/job-board/search?query=${encodeURIComponent(q)}`;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

export const vicHealthAdapter: SourceAdapter = {
  name: "vic_health",
  tier: 4,
  vertical: "healthcare",
  rateLimitDelay: 2000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    const url = buildSearchUrl(profile.keywords);
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`[vic_health] ${err instanceof Error ? err.message : err}`);
      return [];
    }
    if (!html) return [];

    const postings = extractJsonLd(html);
    if (postings.length > 0) {
      for (const p of postings) {
        if (!p.title) continue;
        const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
        if (!kwLower.some((kw) => text.includes(kw))) continue;
        jobs.push({
          url: p.url ?? url,
          title: p.title,
          company: p.hiringOrganization?.name ?? "VIC Health",
          location: locationFromJsonLd(p),
          description: p.description ?? "",
          source: "vic_health",
          source_tier: 4,
          posted_at: p.datePosted ?? null,
          expires_at: p.validThrough ?? null,
          raw: p,
        });
      }
    } else {
      // Fallback: look for job detail anchor links
      const re = /href="(\/job-board\/[^"]+|\/jobs\/[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const title = m[2].trim();
        if (!kwLower.some((kw) => title.toLowerCase().includes(kw))) continue;
        jobs.push({
          url: `${BASE_URL}${m[1]}`,
          title,
          company: "VIC Health",
          location: "Victoria",
          description: "",
          source: "vic_health",
          source_tier: 4,
          posted_at: null,
          expires_at: null,
          raw: {},
        });
      }
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/job-board`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
