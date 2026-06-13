// WA Health adapter — Western Australia Health careers via jobs.wa.gov.au.
// WA Health is one of the largest single employers in WA.
// Primary source: jobs.wa.gov.au filtered to WA Health / Health sector.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

const TIMEOUT_MS = 20_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

function buildSearchUrls(keywords: string[]): string[] {
  const kw = encodeURIComponent(keywords.slice(0, 3).join(" "));
  return [
    // WA Government Jobs portal — health sector filter
    `https://www.jobs.wa.gov.au/jobtools/jncustomsearch.jobsearch?in_organid=14&in_keywords=${kw}`,
    // Alternative URL format
    `https://www.jobs.wa.gov.au/jobs?keywords=${kw}&category=Health`,
    // WA Health own careers page
    `https://www.healthywa.wa.gov.au/Articles/F_I/Jobs-at-WA-Health`,
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
  if (!addr) return "Western Australia";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Western Australia";
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

const WA_HEALTH_RE = /\bwa\s*health\b|\bwestern\s*australia.{0,15}health\b|\bhealth\s+wa\b/i;

export const waHealthAdapter: SourceAdapter = {
  name: "wa_health",
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
          const org = p.hiringOrganization?.name ?? "";
          if (org && !WA_HEALTH_RE.test(org)) continue;
          const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
          if (!kwLower.some((kw) => text.includes(kw))) continue;
          jobs.push({
            url: p.url ?? url,
            title: p.title,
            company: org || "WA Health",
            location: locationFromJsonLd(p),
            description: p.description ?? "",
            source: "wa_health",
            source_tier: 4,
            posted_at: p.datePosted ?? null,
            expires_at: p.validThrough ?? null,
            raw: p,
          });
        }
        if (jobs.length > 0) break;
      }

      // Fallback anchor scan
      const origin = (() => { try { return new URL(url).origin; } catch { return "https://www.jobs.wa.gov.au"; } })();
      const re = /href="(\/(?:jobs|jobtools|jobsearch)[^"]{3,})"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const title = m[2].trim();
        if (!kwLower.some((kw) => title.toLowerCase().includes(kw))) continue;
        jobs.push({
          url: `${origin}${m[1]}`,
          title,
          company: "WA Health",
          location: "Western Australia",
          description: "",
          source: "wa_health",
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
      const res = await fetch("https://www.jobs.wa.gov.au/", {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
