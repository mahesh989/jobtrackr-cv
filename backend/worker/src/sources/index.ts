import { adzunaAdapter } from "./adzuna.js";
import { careerjetAdapter } from "./careerjet.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { agedCareWorkdayAdapter } from "./agedCareWorkday.js";
import { agedCareDayforceAdapter } from "./agedCareDayforce.js";
import { avatureAdapter } from "./avature.js";
import { radancyAdapter } from "./radancy.js";
import { successFactorsAdapter } from "./successFactors.js";
import { adlogicAdapter } from "./adlogic.js";
import type { SourceAdapter } from "./types.js";

// Active adapters in tier order (tier 1 first, lowest rateLimitDelay first within tier).
// Add new adapters here — no other pipeline changes required.
export const adapters: SourceAdapter[] = [
  // Tier 1 — free public APIs
  adzunaAdapter,
  careerjetAdapter,    // Tier 1 — free v4 API (snippet listings). Full JDs are
                       // enriched later (stage 7c) via the careerjet-jd-fetcher
                       // actor on survivors, when CAREERJET_ACTOR_ID is set.

  // Tier 2 — AU tech/enterprise ATS (public JSON, no auth)
  greenhouseAdapter,
  leverAdapter,

  // Tier 2 — AU aged-care employers on Workday (public CXS JSON, no auth).
  agedCareWorkdayAdapter,

  // Tier 3 — Radancy/TalentBrew (validated 2026-06-29: detail pages carry clean
  // JSON-LD JDs). First tenant: Bupa AU aged care (careers.bupa.com.au).
  radancyAdapter,

  // Tier 3 — Avature (validated 2026-06-29: listing server-renders the full JD
  // inline; no detail fetch). First tenant: Regis Aged Care (regis.avature.net,
  // 120 listed → 59 care roles with full JD).
  avatureAdapter,

  // Tier 2 — Dayforce (validated 2026-06-29). First tenant: Uniting
  // NSW/ACT (unitingaunsw/UNITINGCCS, 146 listed → 66 care roles with full JD).
  agedCareDayforceAdapter,

  // Tier 3 — SuccessFactors (SAP) CSB career sites. ⚠ UNVALIDATED — built from
  // the documented SF CSB pattern; fails safe until the user validates live.
  successFactorsAdapter,

  // Tier 3 — AdLogic (MartianLogic/myRecruitment+). Recon'd 2026-07-01;
  // fails safe until validated live.
  adlogicAdapter,
];

export {
  adzunaAdapter,
  careerjetAdapter,
  greenhouseAdapter,
  leverAdapter,
  agedCareWorkdayAdapter,
  agedCareDayforceAdapter,
  avatureAdapter,
  radancyAdapter,
  successFactorsAdapter,
  adlogicAdapter,
};
export type { SourceAdapter, RawJob, SearchProfile } from "./types.js";
