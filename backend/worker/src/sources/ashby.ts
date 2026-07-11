// Ashby ATS adapter — public GraphQL API, no auth required.
// POST https://jobs.ashbyhq.com/api/non-user-graphql
// Used by AU tech/scale-up companies. All listed orgs are AU-based so no location filter needed.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// AU companies using Ashby. Slug = organizationHostedJobsPageName.
const ORGS: { slug: string; company: string }[] = [
  { slug: "dovetail",           company: "Dovetail" },
  { slug: "safetyculture",      company: "SafetyCulture" },
  { slug: "buildkite",          company: "Buildkite" },
  { slug: "assembly-payments",  company: "Assembly Payments" },
  { slug: "judo-bank",          company: "Judo Bank" },
  { slug: "beforepay",          company: "Beforepay" },
  { slug: "swyftx",             company: "Swyftx" },
  { slug: "plenti",             company: "Plenti" },
  { slug: "humanitix",          company: "Humanitix" },
  { slug: "eucalyptus",         company: "Eucalyptus" },
  { slug: "finder",             company: "Finder" },
  { slug: "acorns-australia",   company: "Raiz Invest" },
  { slug: "priceline",          company: "Priceline Pharmacy" },
  { slug: "healthengine",       company: "HealthEngine" },
];

const GQL_QUERY = `
query JobBoard($organizationHostedJobsPageName: String!) {
  jobBoard: publishedJobBoard(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings {
      id
      title
      isRemote
      employmentType
      departmentName
      publishedDate
      jobUrl
      locationName
    }
  }
}`.trim();

interface AshbyJob {
  id: string;
  title: string;
  isRemote: boolean;
  employmentType: string;
  departmentName: string;
  publishedDate: string;
  jobUrl: string;
  locationName: string | null;
}

interface AshbyResponse {
  data?: { jobBoard?: { jobPostings?: AshbyJob[] } | null };
  errors?: { message: string }[];
}

async function fetchJobs(slug: string): Promise<AshbyJob[]> {
  const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      operationName: "JobBoard",
      variables: { organizationHostedJobsPageName: slug },
      query: GQL_QUERY,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${slug})`);
  const data = (await res.json()) as AshbyResponse;
  if (data.errors?.length) return [];
  return data.data?.jobBoard?.jobPostings ?? [];
}

export const ashbyAdapter: SourceAdapter = {
  name: "ashby",
  tier: 2,
  vertical: "tech",
  rateLimitDelay: 400,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const kwLower = profile.keywords.map((k) => k.toLowerCase());
    const jobs: RawJob[] = [];

    for (const { slug, company } of ORGS) {
      let postings: AshbyJob[];
      try {
        postings = await fetchJobs(slug);
      } catch (err) {
        console.warn(`[ashby] ${slug}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const p of postings) {
        if (!kwLower.some((kw) => p.title.toLowerCase().includes(kw))) continue;

        jobs.push({
          url: p.jobUrl,
          title: p.title,
          company,
          location: p.isRemote ? "Remote / Australia" : (p.locationName ?? "Australia"),
          description: "",
          source: "ashby",
          source_tier: 2,
          posted_at: p.publishedDate ?? null,
          expires_at: null,
          ...(p.employmentType && { employment_types_raw: [p.employmentType] }),
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
      await fetchJobs("dovetail");
      return true;
    } catch {
      return false;
    }
  },
};
