// APS Jobs Board — apsjobs.gov.au
// RSS feed: https://www.apsjobs.gov.au/s/rss?q={keywords}
// Federal public sector jobs across all APS agencies.

import { makeRssAdapter } from "./rss.js";
import type { SearchProfile } from "./types.js";

export const apsJobsRssAdapter = makeRssAdapter({
  name: "aps_jobs_rss",
  tier: 1,
  vertical: "general",
  defaultCompany: "Australian Public Service",
  defaultLocation: "Australia (Federal)",
  buildFeedUrl: (profile: SearchProfile) => {
    const q = encodeURIComponent(profile.keywords.slice(0, 5).join(" OR "));
    return `https://www.apsjobs.gov.au/s/rss?q=${q}`;
  },
});
