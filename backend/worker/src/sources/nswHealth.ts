// NSW Health adapter — targets eRecruit portal and iWorkForNSW health category.
// NSW Health is the largest healthcare employer in AU. Primary ATS: eRecruit (PeopleSoft).
// PeopleSoft is JavaScript-rendered; this adapter scrapes the static HTML fallback and
// also queries iWorkForNSW with a health/medical category filter.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

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
  if (!addr) return "New South Wales";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "New South Wales";
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

// iWorkForNSW search page — static HTML filtered to health sector
// Category param 8 corresponds to "Health & Medical" on iWorkForNSW.
function buildIworkforUrl(keywords: string[]): string {
  const kw = keywords.slice(0, 3).join(" ");
  return `https://iworkfor.nsw.gov.au/jobs?keyword=${encodeURIComponent(kw)}&categories=Health+%26+Medical&agencies=NSW+Health`;
}

// NSW Health eRecruit: static careers page (links out to eRecruit for applications)
const EREC_CAREERS_URL = "https://erecruit.health.nsw.gov.au";

export const nswHealthAdapter: SourceAdapter = {
  name: "nsw_health",
  tier: 4,
  vertical: "healthcare",
  rateLimitDelay: 2000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    // Source 1: NSW Health eRecruit portal (may be SSR-limited)
    try {
      const html = await fetchHtml(EREC_CAREERS_URL);
      for (const p of extractJsonLd(html)) {
        if (!p.title) continue;
        const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
        if (!kwLower.some((kw) => text.includes(kw))) continue;
        jobs.push({
          url: p.url ?? EREC_CAREERS_URL,
          title: p.title,
          company: p.hiringOrganization?.name ?? "NSW Health",
          location: locationFromJsonLd(p),
          description: p.description ?? "",
          source: "nsw_health",
          source_tier: 4,
          posted_at: p.datePosted ?? null,
          expires_at: p.validThrough ?? null,
          raw: p,
        });
      }
    } catch (err) {
      console.warn(`[nsw_health] eRecruit: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((r) => setTimeout(r, this.rateLimitDelay));

    // Source 2: iWorkForNSW filtered search
    try {
      const url = buildIworkforUrl(profile.keywords);
      const html = await fetchHtml(url);

      // Extract any JSON-LD jobs on the search page
      for (const p of extractJsonLd(html)) {
        if (!p.title) continue;
        const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
        if (!kwLower.some((kw) => text.includes(kw))) continue;
        jobs.push({
          url: p.url ?? url,
          title: p.title,
          company: p.hiringOrganization?.name ?? "NSW Health",
          location: locationFromJsonLd(p),
          description: p.description ?? "",
          source: "nsw_health",
          source_tier: 4,
          posted_at: p.datePosted ?? null,
          expires_at: p.validThrough ?? null,
          raw: p,
        });
      }

      // Fallback anchor scan for job links on the listing page
      if (jobs.length === 0) {
        const re = /href="(\/jobs\/[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          const title = m[2].trim();
          if (!kwLower.some((kw) => title.toLowerCase().includes(kw))) continue;
          jobs.push({
            url: `https://iworkfor.nsw.gov.au${m[1]}`,
            title,
            company: "NSW Health",
            location: "New South Wales",
            description: "",
            source: "nsw_health",
            source_tier: 4,
            posted_at: null,
            expires_at: null,
            raw: {},
          });
        }
      }
    } catch (err) {
      console.warn(`[nsw_health] iWorkForNSW: ${err instanceof Error ? err.message : err}`);
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(EREC_CAREERS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok || res.status === 302; // eRecruit often redirects
    } catch {
      return false;
    }
  },
};
