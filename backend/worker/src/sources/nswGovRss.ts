// NSW Government Jobs — iworkfor.nsw.gov.au
// RSS feed: https://iworkfor.nsw.gov.au/jobs?keyword={q}&rss=1
// State and local government roles across NSW.

import { makeRssAdapter } from "./rss.js";
import type { SearchProfile } from "./types.js";

export const nswGovRssAdapter = makeRssAdapter({
  name: "nsw_gov_rss",
  tier: 1,
  vertical: "general",
  defaultCompany: "NSW Government",
  defaultLocation: "NSW, Australia",
  buildFeedUrl: (profile: SearchProfile) => {
    const q = encodeURIComponent(profile.keywords.slice(0, 5).join(" "));
    return `https://iworkfor.nsw.gov.au/jobs?keyword=${q}&rss=1`;
  },
});
