// Mercury ATS adapter — HTML scraping of *.mercury.com.au career boards.
// Used by AU aged care, hospitality, and community care employers.
// Roubler (workforce management) sometimes shares the same URL pattern.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// Each org specifies its full base URL since some use subdomain, some use path variants.
interface OrgConfig {
  slug: string;
  company: string;
  baseUrl: string;
}

const ORGS: OrgConfig[] = [
  { slug: "arcare",        company: "Arcare Aged Care",           baseUrl: "https://arcare.mercury.com.au" },
  { slug: "opal",          company: "Opal HealthCare",            baseUrl: "https://opal.mercury.com.au" },
  { slug: "douttagalla",   company: "Doutta Galla Aged Services", baseUrl: "https://douttagalla.mercury.com.au" },
  { slug: "benetas",       company: "Benetas",                    baseUrl: "https://benetas.mercury.com.au" },
  { slug: "mecwacare",     company: "mecwacare",                  baseUrl: "https://mecwacare.mercury.com.au" },
  { slug: "eldercare",     company: "Eldercare",                  baseUrl: "https://eldercare.mercury.com.au" },
  { slug: "sccnsw",        company: "Southern Cross Care NSW",    baseUrl: "https://sccnsw.mercury.com.au" },
  { slug: "aveo",          company: "Aveo Group",                 baseUrl: "https://aveo.mercury.com.au" },
  { slug: "anglicancsq",   company: "Anglicare Southern Queensland", baseUrl: "https://anglicancsq.mercury.com.au" },
  { slug: "murrayphn",     company: "Murray Primary Health Network", baseUrl: "https://murrayphn.mercury.com.au" },
];

const TIMEOUT_MS = 15_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

const BLOCK_RE = /<(?:div|li|tr|article)[^>]+class="[^"]*(?:job|vacancy|position)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|tr|article)>/gi;
const TITLE_RE = /<(?:h[1-3]|a)[^>]*class="[^"]*(?:title|job-title|vacancy|position)[^"]*"[^>]*>([^<]{3,120})</i;
const LINK_RE  = /href="(\/(?:jobs|vacancies|careers|apply)[^"]{2,100})"/i;
const LOC_RE   = /class="[^"]*(?:location|suburb|region|city)[^"]*"[^>]*>\s*([^<]{2,80})\s*</i;

interface MercJob { title: string; path: string; location: string }

function parseHtml(html: string): MercJob[] {
  const jobs: MercJob[] = [];
  const blockRe = new RegExp(BLOCK_RE.source, "gi");
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const inner = block[1];
    const titleM = inner.match(TITLE_RE);
    const linkM  = inner.match(LINK_RE) ?? html.slice(block.index, block.index + 600).match(LINK_RE);
    if (!titleM || !linkM) continue;
    jobs.push({
      title:    titleM[1].trim(),
      path:     linkM[1],
      location: inner.match(LOC_RE)?.[1]?.trim() ?? "Australia",
    });
  }
  if (jobs.length === 0) {
    const re = /href="(\/(?:jobs|vacancies|apply)[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      jobs.push({ title: m[2].trim(), path: m[1], location: "Australia" });
    }
  }
  return jobs;
}

async function fetchListings(org: OrgConfig): Promise<string> {
  const res = await fetch(`${org.baseUrl}/`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${org.slug}`);
  return res.text();
}

export const mercuryRoublerAdapter: SourceAdapter = {
  name: "mercury_roubler",
  tier: 3,
  vertical: "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const org of ORGS) {
      let html: string;
      try {
        html = await fetchListings(org);
      } catch (err) {
        console.warn(`[mercury_roubler] ${org.slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!html) continue;

      for (const listing of parseHtml(html)) {
        if (!kwLower.some((kw) => listing.title.toLowerCase().includes(kw))) continue;
        jobs.push({
          url: `${org.baseUrl}${listing.path}`,
          title: listing.title,
          company: org.company,
          location: listing.location,
          description: "",
          source: "mercury_roubler",
          source_tier: 3,
          posted_at: null,
          expires_at: null,
          raw: listing,
        });
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
