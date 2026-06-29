/**
 * Avature adapter test — runs the real adapter (Regis Aged Care first).
 * Run locally (residential IP):
 *   cd backend/worker && npx tsx src/scripts/testAvature.ts
 */

import { avatureAdapter } from "../sources/avature.js";
import type { SearchProfile } from "../sources/types.js";

const profile: SearchProfile = {
  id: "test", keywords: ["carer"], location: "Australia", visa_filter_mode: "any",
};

console.log("\n=== Avature adapter — live test ===\n");
const t0 = Date.now();
const jobs = await avatureAdapter.fetchJobs(profile);
console.log(`\n--- ${jobs.length} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s ---\n`);

let emptyJD = 0;
for (const j of jobs) if (!j.description || j.description.length < 50) emptyJD++;
console.log(`jobs with empty/thin JD (<50 chars): ${emptyJD}`);

console.log("\n--- up to 15 samples (title | location | JD chars | expires) ---");
for (const j of jobs.slice(0, 15)) {
  console.log(`  ${j.title}  |  ${j.location}  |  ${j.description.length} chars  |  ${j.expires_at ?? "—"}`);
}
console.log("\n=== Done ===");
process.exit(0);
