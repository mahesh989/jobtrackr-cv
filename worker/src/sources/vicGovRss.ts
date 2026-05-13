// Victorian Government Careers — careers.vic.gov.au
// RSS feed: https://careers.vic.gov.au/search?q={keywords}&type=rss
// Roles across Victorian Government departments and agencies.

import { makeRssAdapter } from "./rss.js";
import type { SearchProfile } from "./types.js";

export const vicGovRssAdapter = makeRssAdapter({
  name: "vic_gov_rss",
  tier: 1,
  vertical: "general",
  defaultCompany: "Victorian Government",
  defaultLocation: "VIC, Australia",
  buildFeedUrl: (profile: SearchProfile) => {
    const q = encodeURIComponent(profile.keywords.slice(0, 5).join(" "));
    return `https://careers.vic.gov.au/search?q=${q}&type=rss`;
  },
});
