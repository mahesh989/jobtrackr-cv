/**
 * Radancy (TalentBrew) adapter test — runs the real adapter (Bupa AU first).
 * Run locally (residential IP):
 *   cd backend/worker && npx tsx src/scripts/testRadancy.ts
 */

import { radancyAdapter } from "../sources/radancy.js";
import type { SearchProfile } from "../sources/types.js";

const profile: SearchProfile = {
  id: "test", keywords: ["carer"], location: "Australia", visa_filter_mode: "any",
};

console.log("\n=== Radancy adapter — live test ===\n");
const t0 = Date.now();
const jobs = await radancyAdapter.fetchJobs(profile);
console.log(`\n--- ${jobs.length} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s ---\n`);

let emptyJD = 0;
for (const j of jobs) if (!j.description || j.description.length < 50) emptyJD++;
console.log(`jobs with empty/thin JD (<50 chars): ${emptyJD}`);

console.log("\n--- up to 12 samples (title | company | location | JD chars) ---");
for (const j of jobs.slice(0, 12)) {
  console.log(`  ${j.title}  |  ${j.company}  |  ${j.location}  |  ${j.description.length} chars`);
}
console.log("\n=== Done ===");
process.exit(0);
