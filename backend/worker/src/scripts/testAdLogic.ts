/**
 * AdLogic adapter test — runs the real adapter (Moran Health Care first).
 * Run locally (residential IP):
 *   cd backend/worker && npx tsx src/scripts/testAdLogic.ts
 */

import { adlogicAdapter } from "../sources/adlogic.js";
import type { SearchProfile } from "../sources/types.js";

const profile: SearchProfile = {
  id: "test", keywords: ["carer"], location: "Australia", visa_filter_mode: "any",
};

console.log("\n=== AdLogic adapter — live test ===\n");
const t0 = Date.now();
const jobs = await adlogicAdapter.fetchJobs(profile);
console.log(`\n--- ${jobs.length} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s ---\n`);

let emptyJD = 0;
for (const j of jobs) if (!j.description || j.description.length < 50) emptyJD++;
console.log(`jobs with empty/thin JD (<50 chars): ${emptyJD}`);

console.log("\n--- sample URLs (open to verify) ---");
for (const j of jobs.slice(0, 8)) console.log(`  ${j.url}`);

console.log("\n--- samples (title | location | JD chars | posted) ---");
for (const j of jobs.slice(0, 12)) {
  console.log(`  ${j.title}  |  ${j.location}  |  ${j.description.length} chars  |  ${j.posted_at ?? "—"}`);
}
console.log("\n=== Done ===");
process.exit(0);
