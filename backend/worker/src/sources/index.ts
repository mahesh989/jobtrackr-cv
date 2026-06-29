import { adzunaAdapter } from "./adzuna.js";
import { careerjetAdapter } from "./careerjet.js";
import { apsJobsRssAdapter } from "./apsJobsRss.js";
import { nswGovRssAdapter } from "./nswGovRss.js";
import { vicGovRssAdapter } from "./vicGovRss.js";
import { qldGovRssAdapter } from "./qldGovRss.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { joraAdapter } from "./jora.js";
import { workdayAdapter } from "./workday.js";
import { agedCareWorkdayAdapter } from "./agedCareWorkday.js";
import { smartrecruitersAdapter } from "./smartrecruiters.js";
import { ashbyAdapter } from "./ashby.js";
import { pageupAdapter } from "./pageup.js";
import { elmoAdapter } from "./elmo.js";
import { jobadderAdapter } from "./jobadder.js";
import { mercuryRoublerAdapter } from "./mercuryRoubler.js";
import { scoutTalentAdapter } from "./scoutTalent.js";
import { directHospitalsAdapter } from "./directHospitals.js";
import { nswHealthAdapter } from "./nswHealth.js";
import { vicHealthAdapter } from "./vicHealth.js";
import { qldHealthAdapter } from "./qldHealth.js";
import { saHealthAdapter } from "./saHealth.js";
import { waHealthAdapter } from "./waHealth.js";
import type { SourceAdapter } from "./types.js";

// Active adapters in tier order (tier 1 first, lowest rateLimitDelay first within tier).
// Add new adapters here — no other pipeline changes required.
export const adapters: SourceAdapter[] = [
  // Tier 1 — free public APIs
  // Note: apsJobsRssAdapter, nswGovRssAdapter, vicGovRssAdapter, qldGovRssAdapter removed —
  // none of these gov sites expose working RSS feeds (Salesforce/403/HTML-only).
  adzunaAdapter,
  careerjetAdapter,    // Tier 1 — free v4 API (snippet listings). Full JDs are
                       // enriched later (stage 7c) via the careerjet-jd-fetcher
                       // actor on survivors, when CAREERJET_ACTOR_ID is set.

  // Tier 2 — AU tech/enterprise ATS (public JSON, no auth)
  greenhouseAdapter,
  leverAdapter,

  // Tier 2 — AU aged-care employers on Workday (public CXS JSON, no auth).
  // vertical=healthcare → only runs for profiles targeting healthcare.
  agedCareWorkdayAdapter,

  // Tier 3 — headless browser scraping (AU business hours only, max delays)
  // joraAdapter — DISABLED 2026-05-19. Playwright Chromium hangs in
  //   makeBrowser/makeContext/makePage on the 512MB shared-cpu-1x Fly machine
  //   (out-of-memory; no exception, just silent stall). Re-enable by either
  //   `fly scale memory 1024 -a jobtrackr-worker` or migrating the Jora fetch
  //   off Chromium. Tracked in graph.json BUG-5.

  // workdayAdapter,
  // smartrecruitersAdapter,
  // ashbyAdapter,
  // Tier 3 — AU healthcare ATS (HTML/JSON-LD scraping)
  // pageupAdapter,
  // elmoAdapter,
  // jobadderAdapter,
  // mercuryRoublerAdapter,
  // scoutTalentAdapter,
  // directHospitalsAdapter,
  // Tier 4 — State health portals
  // nswHealthAdapter,
  // vicHealthAdapter,
  // qldHealthAdapter,
  // saHealthAdapter,
  // waHealthAdapter,
];

export {
  adzunaAdapter,
  careerjetAdapter,
  apsJobsRssAdapter,
  nswGovRssAdapter,
  vicGovRssAdapter,
  qldGovRssAdapter,
  greenhouseAdapter,
  leverAdapter,
  joraAdapter,
  workdayAdapter,
  agedCareWorkdayAdapter,
  smartrecruitersAdapter,
  ashbyAdapter,
  pageupAdapter,
  elmoAdapter,
  jobadderAdapter,
  mercuryRoublerAdapter,
  scoutTalentAdapter,
  directHospitalsAdapter,
  nswHealthAdapter,
  vicHealthAdapter,
  qldHealthAdapter,
  saHealthAdapter,
  waHealthAdapter,
};
export type { SourceAdapter, RawJob, SearchProfile } from "./types.js";
