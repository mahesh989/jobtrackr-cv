// SmartRecruiters adapter — public company postings REST API, no auth required.
// GET https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Filters to AU jobs by countryCode.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// AU companies using SmartRecruiters. Slugs are case-sensitive company identifiers.
// 404s are silently skipped — add slugs as discovered.
const ORGS: { slug: string; company: string }[] = [
  { slug: "MYOB",                     company: "MYOB" },
  { slug: "REAGroup",                  company: "REA Group" },
  { slug: "DomainHoldings",            company: "Domain" },
  { slug: "FlightCentreTravel",        company: "Flight Centre" },
  { slug: "Myer",                      company: "Myer" },
  { slug: "LatitudeFinancialServices", company: "Latitude Financial" },
  { slug: "NIBGroup",                  company: "NIB Health Funds" },
  { slug: "GHD",                       company: "GHD" },
  { slug: "Aurecon",                   company: "Aurecon" },
  { slug: "CIMIC",                     company: "CIMIC Group" },
  { slug: "JBHiFiGroup",               company: "JB Hi-Fi" },
  { slug: "Coles",                     company: "Coles Group" },
  { slug: "AustralianEthical",         company: "Australian Ethical" },
  { slug: "GrainCorp",                 company: "GrainCorp" },
  { slug: "TabcorpHoldings",           company: "Tabcorp" },
];

interface SRLocation {
  country: string;
  countryCode: string;
  city: string;
  region: string;
  remote: boolean;
}

interface SRPosting {
  id: string;
  name: string;
  location: SRLocation;
  releasedDate: string;
  ref: string;
}

interface SRResponse {
  content: SRPosting[];
  totalFound: number;
}

async function fetchPostings(slug: string): Promise<SRPosting[]> {
  const res = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=0`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (res.status === 404 || res.status === 403) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status} (${slug})`);
  return ((await res.json()) as SRResponse).content ?? [];
}

export const smartrecruitersAdapter: SourceAdapter = {
  name: "smartrecruiters",
  tier: 2,
  vertical: "general",
  rateLimitDelay: 400,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of ORGS) {
      let postings: SRPosting[];
      try {
        postings = await fetchPostings(slug);
      } catch (err) {
        console.warn(`[smartrecruiters] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const p of postings) {
        const cc = p.location?.countryCode?.toLowerCase();
        const cn = p.location?.country?.toLowerCase();
        if (cc !== "au" && cn !== "australia") continue;
        if (!kwLower.some((kw) => p.name.toLowerCase().includes(kw))) continue;

        const loc = [p.location.city, p.location.region].filter(Boolean).join(", ") || "Australia";
        jobs.push({
          url: p.ref,
          title: p.name,
          company,
          location: loc,
          description: "",
          source: "smartrecruiters",
          source_tier: 2,
          posted_at: p.releasedDate ?? null,
          expires_at: null,
          raw: p,
        });
      }

      if (postings.length > 0) {
        await new Promise((r) => setTimeout(r, this.rateLimitDelay));
      }
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      await fetchPostings("MYOB");
      return true;
    } catch {
      return false;
    }
  },
};
