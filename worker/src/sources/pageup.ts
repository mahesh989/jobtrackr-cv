// PageUp ATS adapter — *.pageuppeople.com career boards
// Used heavily by AU healthcare, aged care, universities, and large NFPs.
// Approach: fetch listings page HTML → extract job links via regex →
// fetch individual job pages → extract JSON-LD (schema.org JobPosting).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// AU organisations using PageUp. Add slugs as discovered.
// Format: { slug, company } where career board is at {slug}.pageuppeople.com
const ORGS: { slug: string; company: string }[] = [
  { slug: "svha", company: "St Vincent's Health Australia" },
  { slug: "catho", company: "Catholic Healthcare" },
  { slug: "ramsay", company: "Ramsay Health Care" },
  { slug: "calvary", company: "Calvary Health Care" },
  { slug: "regis", company: "Regis Aged Care" },
  { slug: "bupa", company: "Bupa Aged Care" },
  { slug: "japara", company: "Japara Healthcare" },
  { slug: "baptistcare", company: "BaptistCare" },
  { slug: "anglicare", company: "Anglicare" },
  { slug: "bluecare", company: "Blue Care" },
  { slug: "benevolent", company: "The Benevolent Society" },
  { slug: "nswhealthjobs", company: "NSW Health" },
  { slug: "healthscope", company: "Healthscope" },
  { slug: "cabrini", company: "Cabrini Health" },
  { slug: "monash-health", company: "Monash Health" },
  { slug: "alfred", company: "Alfred Health" },
  { slug: "austin", company: "Austin Health" },
  { slug: "mater", company: "Mater Group" },
  { slug: "uniting", company: "Uniting" },
  { slug: "acacia", company: "Acacia Living" },
];

const TIMEOUT_MS = 15_000;
const MAX_JOBS_PER_ORG = 20;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

// Extract href values from anchor tags that look like PageUp job detail links
const JOB_LINK_RE = /href="(\/apply\/[^"]*?\/job[^"]*?)"/gi;

interface JsonLdJobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string } } | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
  url?: string;
}

function extractJsonLd(html: string): JsonLdJobPosting[] {
  const results: JsonLdJobPosting[] = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>)["@type"] === "JobPosting"
        ) {
          results.push(item as JsonLdJobPosting);
        }
      }
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return results;
}

function locationFromJsonLd(jl: JsonLdJobPosting): string {
  const loc = jl.jobLocation;
  if (!loc) return "Australia";
  const addr = Array.isArray(loc) ? loc[0]?.address : loc.address;
  if (!addr) return "Australia";
  const parts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
  return parts.join(", ") || "Australia";
}

async function fetchListingsHtml(slug: string): Promise<string> {
  const res = await fetch(`https://${slug}.pageuppeople.com/apply/listings`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  return res.text();
}

async function fetchJobPage(slug: string, path: string): Promise<string> {
  const url = `https://${slug}.pageuppeople.com${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return "";
  return res.text();
}

export const pageupAdapter: SourceAdapter = {
  name: "pageup",
  tier: 3,
  vertical: "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of ORGS) {
      let listingsHtml: string;
      try {
        listingsHtml = await fetchListingsHtml(slug);
      } catch (err) {
        console.warn(`[pageup] ${slug} listings failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!listingsHtml) continue;

      // Collect unique job detail paths from the listings page
      const paths = new Set<string>();
      let m: RegExpExecArray | null;
      const linkRe = new RegExp(JOB_LINK_RE.source, "gi");
      while ((m = linkRe.exec(listingsHtml)) !== null && paths.size < MAX_JOBS_PER_ORG) {
        paths.add(m[1]);
      }

      if (paths.size === 0) continue;

      await new Promise((r) => setTimeout(r, this.rateLimitDelay));

      for (const path of paths) {
        let jobHtml: string;
        try {
          jobHtml = await fetchJobPage(slug, path);
        } catch {
          continue;
        }
        if (!jobHtml) continue;

        const postings = extractJsonLd(jobHtml);
        for (const p of postings) {
          if (!p.title) continue;
          const text = `${p.title} ${p.description ?? ""}`.toLowerCase();
          if (!kwLower.some((kw) => text.includes(kw))) continue;

          const jobUrl = `https://${slug}.pageuppeople.com${path}`;
          jobs.push({
            url: p.url ?? jobUrl,
            title: p.title,
            company: p.hiringOrganization?.name ?? company,
            location: locationFromJsonLd(p),
            description: p.description ?? "",
            source: "pageup",
            source_tier: 3,
            posted_at: p.datePosted ?? null,
            expires_at: p.validThrough ?? null,
            raw: p,
          });
        }

        await new Promise((r) => setTimeout(r, 800));
      }
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const html = await fetchListingsHtml("svha");
      return html.length > 0;
    } catch {
      return false;
    }
  },
};
