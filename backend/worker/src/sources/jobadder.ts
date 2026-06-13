// JobAdder ATS adapter — HTML scraping of public career boards.
// Career boards at https://{slug}.jobadder.com/
// Used by AU healthcare staffing agencies and recruitment firms.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// AU recruitment/staffing agencies using JobAdder white-label boards.
const ORGS: { slug: string; company: string }[] = [
  { slug: "chandlermacleod",  company: "Chandler Macleod" },
  { slug: "programmed",       company: "Programmed" },
  { slug: "drakeintl",        company: "Drake International" },
  { slug: "hendercare",       company: "HenderCare" },
  { slug: "agedcarejobs",     company: "Aged Care Jobs" },
  { slug: "peoplescout",      company: "PeopleScout" },
  { slug: "hoban",            company: "HOBAN Recruitment" },
  { slug: "westaff",          company: "Westaff" },
  { slug: "talentpath",       company: "Talent Path" },
  { slug: "empowered",        company: "Empowered Staffing" },
  { slug: "medirecruit",      company: "MediRecruit" },
  { slug: "acacia-connect",   company: "Acacia Connect" },
  { slug: "ohsolutions",      company: "OH Solutions" },
  { slug: "tradewind",        company: "Tradewind Australia" },
  { slug: "placementpartners", company: "Placement Partners" },
];

const TIMEOUT_MS = 15_000;
const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

// Patterns to extract job blocks from JobAdder HTML
const BLOCK_RE = /<(?:div|li|article)[^>]+class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|article)>/gi;
const TITLE_RE = /<(?:h[1-3]|a)[^>]*class="[^"]*(?:title|job-name|position)[^"]*"[^>]*>([^<]{3,120})</i;
const LINK_RE  = /href="(\/(?:jobs|vacancies|job)[^"]{2,100})"/i;
const LOC_RE   = /class="[^"]*(?:location|suburb|city|region)[^"]*"[^>]*>\s*([^<]{2,80})\s*</i;

interface JaJob { title: string; path: string; location: string }

function parseHtml(html: string): JaJob[] {
  const jobs: JaJob[] = [];
  const blockRe = new RegExp(BLOCK_RE.source, "gi");
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const inner = block[1];
    const titleM = inner.match(TITLE_RE);
    const linkM  = inner.match(LINK_RE) ?? html.slice(block.index, block.index + 800).match(LINK_RE);
    if (!titleM || !linkM) continue;
    jobs.push({
      title:    titleM[1].trim(),
      path:     linkM[1],
      location: inner.match(LOC_RE)?.[1]?.trim() ?? "Australia",
    });
  }
  // Fallback: anchor scan when block-level extraction finds nothing
  if (jobs.length === 0) {
    const re = /href="(\/(?:jobs|vacancies)[^"]+)"[^>]*>\s*([^<]{5,120})\s*<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      jobs.push({ title: m[2].trim(), path: m[1], location: "Australia" });
    }
  }
  return jobs;
}

async function fetchListings(slug: string): Promise<string> {
  const res = await fetch(`https://${slug}.jobadder.com/`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  return res.text();
}

export const jobadderAdapter: SourceAdapter = {
  name: "jobadder",
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
        console.warn(`[jobadder] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!html) continue;

      for (const listing of parseHtml(html)) {
        if (!kwLower.some((kw) => listing.title.toLowerCase().includes(kw))) continue;
        jobs.push({
          url: `https://${slug}.jobadder.com${listing.path}`,
          title: listing.title,
          company,
          location: listing.location,
          description: "",
          source: "jobadder",
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
      const html = await fetchListings("chandlermacleod");
      return html.length > 0;
    } catch {
      return false;
    }
  },
};
