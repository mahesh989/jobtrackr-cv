/**
 * Test a single adapter in isolation — no DB, no BullMQ, no AI, no dedup.
 * Runs the adapter's fetchJobs() directly and prints raw results.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/testAdapter.ts jora
 *   npx tsx --env-file=.env scripts/testAdapter.ts adzuna
 *   npx tsx --env-file=.env scripts/testAdapter.ts greenhouse
 *
 * Jora time-gate bypass (runs outside AU business hours):
 *   JORA_BYPASS_TIME_GATE=true npx tsx --env-file=.env scripts/testAdapter.ts jora
 */

import { adapters } from "../src/sources/index.js";
import type { SearchProfile } from "../src/sources/types.js";

// ── Minimal test profile ───────────────────────────────────────────────────────
const TEST_PROFILE: SearchProfile = {
  id: "test-adapter",
  keywords: ["data analyst", "business analyst"],
  location: "Sydney",
  adzuna_max_days_old: 14,
};

// ── Main ──────────────────────────────────────────────────────────────────────

const targetName = process.argv[2];
if (!targetName) {
  console.error("Usage: npx tsx scripts/testAdapter.ts <adapter-name>");
  console.error(`Available: ${adapters.map((a) => a.name).join(", ")}`);
  process.exit(1);
}

const adapter = adapters.find((a) => a.name === targetName);
if (!adapter) {
  console.error(`Unknown adapter: "${targetName}"`);
  console.error(`Available: ${adapters.map((a) => a.name).join(", ")}`);
  process.exit(1);
}

console.log("=".repeat(60));
console.log(`Adapter test: ${adapter.name} (tier ${adapter.tier})`);
console.log(`Keywords:     ${TEST_PROFILE.keywords.join(", ")}`);
console.log(`Location:     ${TEST_PROFILE.location}`);
console.log("=".repeat(60));

// Health check
const healthy = await adapter.isHealthy();
console.log(`\nHealth check: ${healthy ? "✓ OK" : "✗ UNHEALTHY"}`);
if (!healthy) {
  console.error("Adapter failed health check — aborting.");
  process.exit(1);
}

// Fetch
console.log("\nFetching jobs...\n");
const start = Date.now();
const jobs = await adapter.fetchJobs(TEST_PROFILE);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log("\n" + "=".repeat(60));
console.log(`Results: ${jobs.length} jobs in ${elapsed}s`);
console.log("=".repeat(60));

if (jobs.length === 0) {
  console.log("No jobs returned.");
  if (targetName === "jora") {
    const h = new Date().getUTCHours();
    if (h < 0 || h > 5) {
      console.log(`\nHint: current UTC hour is ${h} — outside run window (0–5).`);
      console.log("Run with JORA_BYPASS_TIME_GATE=true to bypass.");
    }
  }
  process.exit(0);
}

// Print table
const cols = ["title", "company", "location", "source"] as const;
console.log("\n" + cols.map((c) => c.padEnd(30)).join(" | "));
console.log("-".repeat(130));
for (const j of jobs.slice(0, 20)) {
  console.log(
    [j.title, j.company, j.location, j.source]
      .map((v) => (v ?? "").slice(0, 29).padEnd(30))
      .join(" | ")
  );
}
if (jobs.length > 20) console.log(`  … and ${jobs.length - 20} more`);

// Sample full record
console.log("\n── Sample job (full record) ──");
console.log(JSON.stringify(jobs[0], null, 2));

process.exit(0);
