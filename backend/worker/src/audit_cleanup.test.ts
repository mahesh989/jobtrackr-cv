/**
 * Audit-cleanup verification tests.
 *
 * Ensures the over-engineering audit didn't break active exports or leave
 * dangling references to deleted modules.
 */
import { describe, it, expect } from "vitest";

// ── 1. Active source adapters ────────────────────────────────────────────────

import {
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
  adapters,
} from "./sources/index.js";
import type { SourceAdapter } from "./sources/types.js";

describe("sources/index — active adapters", () => {
  const expectedNames = [
    "adzuna",
    "careerjet",
    "greenhouse",
    "lever",
    "aged_care_workday",
    "aged_care_dayforce",
    "avature",
    "radancy",
    "successfactors",  // adapter.name may differ in casing
    "adlogic",
  ];

  it("exports exactly 10 adapters in the adapters[] array", () => {
    expect(adapters).toHaveLength(10);
  });

  it("every adapter in adapters[] has name, tier, vertical, fetchJobs, isHealthy", () => {
    for (const a of adapters) {
      expect(typeof a.name).toBe("string");
      expect(typeof a.tier).toBe("number");
      expect(typeof a.vertical).toBe("string");
      expect(typeof a.fetchJobs).toBe("function");
      expect(typeof a.isHealthy).toBe("function");
    }
  });

  it("each named export is the same object as its entry in adapters[]", () => {
    const namedExports: SourceAdapter[] = [
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
    ];
    for (const exp of namedExports) {
      expect(adapters).toContain(exp);
    }
  });
});

// ── 2. Deleted adapters are gone ─────────────────────────────────────────────

describe("sources/index — deleted adapters are gone", () => {
  it("adapters array contains no disabled sources", () => {
    const names = adapters.map((a) => a.name.toLowerCase());
    const deleted = [
      "jora", "workday", "clinch", "smartrecruiters", "ashby",
      "pageup", "elmo", "jobadder", "mercury_roubler", "direct_hospitals",
      "nsw_health", "vic_health", "qld_health", "sa_health", "wa_health",
      "scout_talent", "aps_jobs_rss", "nsw_gov_rss", "vic_gov_rss", "qld_gov_rss",
    ];
    for (const d of deleted) {
      expect(names).not.toContain(d);
    }
  });
});

// ── 3. Deleted AI modules are gone ───────────────────────────────────────────

import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("deleted AI modules — scorer, cache, costCap, linkValidator", () => {
  const deleted = ["scorer.ts", "cache.ts", "costCap.ts", "linkValidator.ts"];
  for (const file of deleted) {
    it(`${file} no longer exists`, () => {
      expect(existsSync(resolve(__dirname, "ai", file))).toBe(false);
    });
  }
});

// ── 4. Deleted source adapter files are gone ─────────────────────────────────

describe("deleted source adapters — files removed", () => {
  const deletedFiles = [
    "./sources/jora.js",
    "./sources/workday.js",
    "./sources/clinch.js",
    "./sources/smartrecruiters.js",
    "./sources/ashby.js",
    "./sources/pageup.js",
    "./sources/elmo.js",
    "./sources/jobadder.js",
    "./sources/mercuryRoubler.js",
    "./sources/directHospitals.js",
    "./sources/nswHealth.js",
    "./sources/vicHealth.js",
    "./sources/qldHealth.js",
    "./sources/saHealth.js",
    "./sources/waHealth.js",
    "./sources/scoutTalent.js",
    "./sources/apsJobsRss.js",
    "./sources/nswGovRss.js",
    "./sources/vicGovRss.js",
    "./sources/qldGovRss.js",
  ];

  for (const file of deletedFiles) {
    it(`${file.split("/").pop()} should not be importable`, async () => {
      await expect(import(file)).rejects.toThrow();
    });
  }
});

// ── 5. Live AI modules still work ────────────────────────────────────────────

describe("live AI modules — still importable", () => {
  it("visaExtractor is still importable", async () => {
    const mod = await import("./ai/visaExtractor.js");
    expect(typeof mod.extractVisaInfo).toBe("function");
  });

  it("settingClassifier is still importable", async () => {
    const mod = await import("./ai/settingClassifier.js");
    expect(typeof mod.classifySettings).toBe("function");
  });

  it("jdFacts is still importable", async () => {
    const mod = await import("./ai/jdFacts.js");
    expect(typeof mod.extractEmploymentTypes).toBe("function");
  });
});

// ── 6. Deleted scripts are gone ──────────────────────────────────────────────

describe("deleted scripts — no longer exist", () => {
  const deletedScripts = [
    "./scripts/testSeek.js",
    "./scripts/testSeekDirect.js",
    "./scripts/testRadancy.js",
    "./scripts/testClinch.js",
    "./scripts/probeClinch.js",
    "./scripts/testAvature.js",
    "./scripts/testDayforce.js",
    "./scripts/testSuccessFactors.js",
    "./scripts/testAdLogic.js",
    "./scripts/testAgedCareWorkday.js",
    "./scripts/testRun.js",
    "./scripts/enqueueRun.js",
    "./scripts/fetchApifyLog.js",
    "./scripts/backfillBucket.js",
    "./scripts/backfillSettings.js",
  ];

  for (const file of deletedScripts) {
    it(`${file.split("/").pop()} should not be importable`, async () => {
      await expect(import(file)).rejects.toThrow();
    });
  }
});
