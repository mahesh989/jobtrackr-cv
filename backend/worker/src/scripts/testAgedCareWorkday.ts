/**
 * Aged-care Workday adapter test — runs the REAL adapter against all configured
 * tenants and reports what it would feed the pipeline. Run locally (residential
 * IP = no blocking; the Fly egress and the Claude web sandbox may differ).
 *
 * Usage:
 *   cd backend/worker
 *   npx tsx src/scripts/testAgedCareWorkday.ts
 *
 * What it checks per tenant:
 *   - list endpoint reachable + returns jobs
 *   - role-taxonomy title filter is selecting sensible roles
 *   - detail fetch returns a real, non-empty JD
 *   - AU filtering working (no overseas locations leaking through)
 */

import { agedCareWorkdayAdapter } from "../sources/agedCareWorkday.js";
import type { SearchProfile } from "../sources/types.js";

// Minimal profile — the adapter ignores keywords (it uses its own role taxonomy)
// but SearchProfile requires these fields.
const profile: SearchProfile = {
  id:               "test",
  keywords:         ["nurse"],
  location:         "Australia",
  visa_filter_mode: "any",
};

console.log("\n=== Aged-care Workday adapter — live test ===\n");

const t0 = Date.now();
const jobs = await agedCareWorkdayAdapter.fetchJobs(profile);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n--- ${jobs.length} jobs in ${secs}s ---\n`);

// Per-company breakdown
const byCompany = new Map<string, number>();
const byGroup   = new Map<string, number>();
let emptyJD = 0;
let nonAU   = 0;
const overseas: string[] = [];
// Flag only KNOWN-overseas locations. Most AU jobs are bare suburbs (e.g.
// "Castle Hill", "Glebe") that no AU regex can reliably whitelist, so requiring
// an AU token produces false positives. Detecting clearly-overseas tokens is the
// meaningful signal (e.g. Bupa UK / AgeCare Canada leakage).
const NON_AU = /\b(london|united kingdom|england|scotland|wales|ireland|dublin|canada|alberta|ontario|calgary|toronto|new zealand|auckland|wellington|singapore|manila|philippines|india|bangalore|mumbai|usa|united states|spain|madrid|poland|chile)\b/i;

for (const j of jobs) {
  byCompany.set(j.company, (byCompany.get(j.company) ?? 0) + 1);
  const group = (j.raw as { group?: string })?.group ?? "?";
  byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
  if (!j.description || j.description.length < 50) emptyJD++;
  if (j.location && NON_AU.test(j.location)) { nonAU++; overseas.push(`${j.company}: ${j.location}`); }
}

console.log("By company:");
for (const [c, n] of [...byCompany.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(3)}  ${c}`);
}
console.log("\nBy role group:");
for (const [g, n] of byGroup.entries()) console.log(`  ${n.toString().padStart(3)}  ${g}`);

console.log(`\nQuality flags:`);
console.log(`  jobs with empty/thin JD (<50 chars): ${emptyJD}`);
console.log(`  jobs with a KNOWN-overseas location:  ${nonAU}  ${nonAU > 0 ? "⚠ AU filter leak" : "✓"}`);
if (overseas.length) console.log("   " + overseas.slice(0, 10).join("\n   "));

console.log("\n--- 8 sample URLs (open these to verify the link works) ---");
for (const j of jobs.slice(0, 8)) console.log(`  ${j.url}`);

console.log("\n--- 8 samples (title | company | location | JD chars) ---");
for (const j of jobs.slice(0, 8)) {
  console.log(`  ${j.title}  |  ${j.company}  |  ${j.location}  |  ${j.description.length} chars`);
}

console.log("\n=== Done ===");
process.exit(0);
