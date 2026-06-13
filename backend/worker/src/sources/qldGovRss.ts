// Queensland Government SmartJobs — smartjobs.qld.gov.au
// RSS feed: https://smartjobs.qld.gov.au/jobtools/jncustomsearch.jobsearch?in_rssFeed=1&in_jobtitlename={q}
// State government jobs across Queensland departments and agencies.

import { makeRssAdapter } from "./rss.js";
import type { SearchProfile } from "./types.js";

export const qldGovRssAdapter = makeRssAdapter({
  name: "qld_gov_rss",
  tier: 1,
  vertical: "general",
  defaultCompany: "Queensland Government",
  defaultLocation: "QLD, Australia",
  buildFeedUrl: (profile: SearchProfile) => {
    const q = encodeURIComponent(profile.keywords.slice(0, 5).join(" "));
    return `https://smartjobs.qld.gov.au/jobtools/jncustomsearch.jobsearch?in_rssFeed=1&in_jobtitlename=${q}`;
  },
});
