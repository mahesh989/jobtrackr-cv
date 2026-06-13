// Direct hospital career page adapter — per-site scrapers for hospitals
// where the underlying ATS is not separately addressable.
// Tries JSON-LD extraction first; falls back to anchor scan.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

interface HospitalConfig {
  name: string;
  company: string;
  listingsUrl: string;
  origin: string; // https://domain.com.au — prefix for relative hrefs
  jobPathPattern: RegExp; // path prefix for job detail links
}

const HOSPITALS: HospitalConfig[] = [
  {
    name: "slhd",
    company: "Sydney Local Health District (incl. RPA)",
    listingsUrl: "https://www.slhd.nsw.gov.au/careers/",
    origin: "https://www.slhd.nsw.gov.au",
    jobPathPattern: /\/(?:careers|jobs|apply|vacancies)\//,
  },
  {
    name: "nslhd",
    company: "Northern Sydney Local Health District (incl. RNSH)",
    listingsUrl: "https://www.nslhd.health.nsw.gov.au/Careers/Pages/default.aspx",
    origin: "https://www.nslhd.health.nsw.gov.au",
    jobPathPattern: /\/(?:Careers|jobs|apply)/i,
  },
  {
    name: "rmh",
    company: "The Royal Melbourne Hospital",
    listingsUrl: "https://www.thermh.org.au/work-with-us/careers",
    origin: "https://www.thermh.org.au",
    jobPathPattern: /\/(?:careers|jobs|work-with-us)\//,
  },
  {
    name: "rch",
    company: "The Royal Children's Hospital Melbourne",
    listingsUrl: "https://www.rch.org.au/careers/",
    origin: "https://www.rch.org.au",
    jobPathPattern: /\/(?:careers|jobs|apply)\//,
  },
  {
    name: "metrosouth",
    company: "Metro South Health (incl. Princess Alexandra Hospital)",
    listingsUrl: "https://metrosouth.health.qld.gov.au/careers",
    origin: "https://metrosouth.health.qld.gov.au",
    jobPathPattern: /\/(?:careers|jobs)\//,
  },
  {
    name: "rah",
    company: "Royal Adelaide Hospital (SALHN)",
    listingsUrl: "https://www.sahealth.sa.gov.au/wps/wcm/connect/public+content/sa+health+internet/work+with+us",
    origin: "https://www.sahealth.sa.gov.au",
    jobPathPattern: /\/(?:careers|jobs|work-with-us)\//,
  },
  {
    name: "fiona_stanley",
    company: "Fiona Stanley Hospital (FSH Health Group)",
    listingsUrl: "https://www.fsh.health.wa.gov.au/For-health-professionals/Careers",
    origin: "https://www.fsh.health.wa.gov.au",
    jobPathPattern: /\/(?:Careers|careers|jobs)\//i,
  },
];

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
  if (!addr) return "Australia";
  return [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") || "Australia";
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

export const directHospitalsAdapter: SourceAdapter = {
  name: "direct_hospitals",
  tier: 3,
  vertical: "healthcare",
  rateLimitDelay: 2000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const hospital of HOSPITALS) {
      let html: string;
      try {
        html = await fetchPage(hospital.listingsUrl);
      } catch (err) {
        console.warn(`[direct_hospitals] ${hospital.name}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!html) continue;

      const postings = extractJsonLd(html);
      if (postings.length > 0) {
        for (const p of postings) {
          if (!p.title) continue;
          const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
          if (!kwLower.some((kw) => text.includes(kw))) continue;
          jobs.push({
            url: p.url ?? hospital.listingsUrl,
            title: p.title,
            company: p.hiringOrganization?.name ?? hospital.company,
            location: locationFromJsonLd(p),
            description: p.description ?? "",
            source: "direct_hospitals",
            source_tier: 3,
            posted_at: p.datePosted ?? null,
            expires_at: p.validThrough ?? null,
            raw: p,
          });
        }
      } else {
        // Fallback: scan anchors matching the hospital's job path pattern
        const anchorRe = /href="([^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = anchorRe.exec(html)) !== null) {
          const href = m[1];
          const title = m[2].trim();
          if (!hospital.jobPathPattern.test(href)) continue;
          if (!kwLower.some((kw) => title.toLowerCase().includes(kw))) continue;
          const url = href.startsWith("http") ? href : `${hospital.origin}${href}`;
          jobs.push({
            url,
            title,
            company: hospital.company,
            location: "Australia",
            description: "",
            source: "direct_hospitals",
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
      const html = await fetchPage(HOSPITALS[0].listingsUrl);
      return html.length > 0;
    } catch {
      return false;
    }
  },
};
