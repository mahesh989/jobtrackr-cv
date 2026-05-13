// ELMO Talent adapter — *.elmotalent.com.au career boards
// Used by mid-size AU healthcare, aged care, and NFP organisations.
// Approach: fetch listings HTML → extract job data from structured selectors.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// AU organisations using ELMO Talent. Format: { slug, company }.
// Career board URL: https://{slug}.elmotalent.com.au/careers/
const ORGS: { slug: string; company: string }[] = [
  { slug: "brightwater", company: "Brightwater Care Group" },
  { slug: "alliancehealth", company: "Alliance Health" },
  { slug: "centacare", company: "Centacare" },
  { slug: "patientphysician", company: "Patient Physician" },
  { slug: "mcleancare", company: "McLean Care" },
  { slug: "heritage", company: "Heritage Care" },
  { slug: "scalabrini", company: "Scalabrini Village" },
  { slug: "greenacres", company: "Greenacres Disability Services" },
  { slug: "vinnies", company: "St Vincent de Paul Society" },
  { slug: "endeavour", company: "Endeavour Foundation" },
  { slug: "carpentaria", company: "Carpentaria" },
  { slug: "bcs", company: "Broken Hill City Council" },
  { slug: "unisonhousing", company: "Unison Housing" },
  { slug: "nationaldisability", company: "National Disability Services" },
  { slug: "baptistcare-wa", company: "BaptistCare WA" },
];

const TIMEOUT_MS = 15_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

// ELMO listing HTML patterns — jobs are in anchor tags with data attributes or
// class-based selectors. Multiple patterns tried in order.
const JOB_BLOCK_RE = /<(?:div|li|article)[^>]+class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|article)>/gi;
const TITLE_RE = /class="[^"]*(?:title|heading|name)[^"]*"[^>]*>([^<]{3,120})</i;
const LINK_RE = /href="(\/careers\/[^"]+)"/i;
const LOC_RE = /class="[^"]*(?:location|suburb|city)[^"]*"[^>]*>([^<]{2,80})</i;
const CLOSE_RE = /class="[^"]*(?:close|closing|expir)[^"]*"[^>]*>([^<]{4,40})</i;

interface ElmoJob {
  title: string;
  path: string;
  location: string;
  closingDate: string | null;
}

function parseElmoListings(html: string, slug: string): ElmoJob[] {
  const jobs: ElmoJob[] = [];
  const blockRe = new RegExp(JOB_BLOCK_RE.source, "gi");
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const inner = block[1];
    const titleMatch = inner.match(TITLE_RE);
    const linkMatch = inner.match(LINK_RE) ?? html.slice(block.index, block.index + 600).match(LINK_RE);
    if (!titleMatch || !linkMatch) continue;
    jobs.push({
      title: titleMatch[1].trim(),
      path: linkMatch[1],
      location: inner.match(LOC_RE)?.[1]?.trim() ?? "Australia",
      closingDate: inner.match(CLOSE_RE)?.[1]?.trim() ?? null,
    });
  }

  // Fallback: simple anchor scan if block-level parsing found nothing
  if (jobs.length === 0) {
    const anchorRe = /href="(\/careers\/[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      jobs.push({ title: m[2].trim(), path: m[1], location: "Australia", closingDate: null });
    }
  }

  return jobs;
}

async function fetchListings(slug: string): Promise<string> {
  const res = await fetch(`https://${slug}.elmotalent.com.au/careers/`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  return res.text();
}

export const elmoAdapter: SourceAdapter = {
  name: "elmo",
  tier: 3,
  vertical: "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of ORGS) {
      let html: string;
      try {
        html = await fetchListings(slug);
      } catch (err) {
        console.warn(`[elmo] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!html) continue;

      const listings = parseElmoListings(html, slug);
      for (const listing of listings) {
        if (!kwLower.some((kw) => listing.title.toLowerCase().includes(kw))) continue;

        jobs.push({
          url: `https://${slug}.elmotalent.com.au${listing.path}`,
          title: listing.title,
          company,
          location: listing.location,
          description: "",
          source: "elmo",
          source_tier: 3,
          posted_at: null,
          expires_at: listing.closingDate,
          raw: listing,
        });
      }

      await new Promise((r) => setTimeout(r, this.rateLimitDelay));
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const html = await fetchListings("brightwater");
      return html.length > 0;
    } catch {
      return false;
    }
  },
};
