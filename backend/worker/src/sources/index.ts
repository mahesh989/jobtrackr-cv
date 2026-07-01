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
import { agedCareDayforceAdapter } from "./agedCareDayforce.js";
import { avatureAdapter } from "./avature.js";
import { radancyAdapter } from "./radancy.js";
import { successFactorsAdapter } from "./successFactors.js";
import { adlogicAdapter } from "./adlogic.js";
import { clinchAdapter } from "./clinch.js";
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
  // The ONLY validated/working direct aged-care source (7 AU providers, full JD).
  agedCareWorkdayAdapter,

  // Tier 3 — Radancy/TalentBrew (validated 2026-06-29: detail pages carry clean
  // JSON-LD JDs). First tenant: Bupa AU aged care (careers.bupa.com.au).
  radancyAdapter,

  // Tier 3 — Avature (validated 2026-06-29: listing server-renders the full JD
  // inline; no detail fetch). First tenant: Regis Aged Care (regis.avature.net,
  // 120 listed → 59 care roles with full JD).
  avatureAdapter,

  // Tier 2 — Dayforce (validated 2026-06-29: bootstrap a CSRF session via the
  // careers page, then POST jobposting/search — full JD inline. The earlier 403
  // was a wrong body + missing CSRF, NOT Cloudflare). First tenant: Uniting
  // NSW/ACT (unitingaunsw/UNITINGCCS, 146 listed → 66 care roles with full JD).
  agedCareDayforceAdapter,

  // Tier 3 — SuccessFactors (SAP) CSB career sites. Expected: server-rendered
  // /search/?startrow=N listing → JSON-LD detail (like Radancy). First tenant:
  // Australian Unity (careers.australianunity.com.au). ⚠ UNVALIDATED — built from
  // the documented SF CSB pattern; fails safe until the user validates live.
  successFactorsAdapter,

  // Tier 3 — AdLogic (MartianLogic/myRecruitment+) — Next.js board over a public
  // JSON API (/api/search) + full JD from the SSR detail page's __NEXT_DATA__.
  // First tenant: Moran Health Care (careers.morangroup.com.au). Multi-tenant
  // (Maroba + others). Recon'd 2026-07-01; fails safe until validated live.
  adlogicAdapter,

  // PAUSED 2026-06-29 after live validation — these ATSs don't yield full JDs via
  // simple HTTP yet (see docs/aged-care-ats-map.md). Code is kept + exported so
  // re-enabling is a one-line uncomment once their JSON APIs are captured:
  //   pageupAdapter           — modern PageUp is a JS SPA (listing-only, no JD)
  //   scoutTalentAdapter      — likely JS SPA, unvalidated
  //   clinchAdapter           — sitemap+JSON-LD works, but AWS WAF 202-challenges
  //                             bulk detail fetches (needs headless/aws-waf-token).
  //                             High-value: Uniting AgeWell (35 aged-care roles).

  // Tier 3 — headless browser scraping (AU business hours only, max delays)
  // joraAdapter — DISABLED 2026-05-19. Playwright Chromium hangs in
  //   makeBrowser/makeContext/makePage on the 512MB shared-cpu-1x Fly machine
  //   (out-of-memory; no exception, just silent stall). Re-enable by either
  //   `fly scale memory 1024 -a jobtrackr-worker` or migrating the Jora fetch
  //   off Chromium. Tracked in graph.json BUG-5.

  // workdayAdapter,
  // smartrecruitersAdapter,
  // ashbyAdapter,
  // Tier 3 — AU healthcare ATS (HTML/JSON-LD scraping) — still disabled
  // elmoAdapter,
  // jobadderAdapter,
  // mercuryRoublerAdapter,
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
  agedCareDayforceAdapter,
  avatureAdapter,
  radancyAdapter,
  successFactorsAdapter,
  adlogicAdapter,
  clinchAdapter,
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
