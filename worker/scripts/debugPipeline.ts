/**
 * Pipeline debug dry-run — shows exactly what gets dropped at each stage and why.
 * Does NOT save anything to the database.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/debugPipeline.ts <profileId>
 *
 * Jora needs the time gate bypassed outside AU hours:
 *   JORA_BYPASS_TIME_GATE=true npx tsx --env-file=.env scripts/debugPipeline.ts <profileId>
 *
 * Limit to specific adapters to go faster:
 *   ADAPTERS=adzuna,greenhouse npx tsx --env-file=.env scripts/debugPipeline.ts <profileId>
 */

import { createHash } from "crypto";
import { db } from "../src/db/client.js";
import { adapters } from "../src/sources/index.js";
import { normalise } from "../src/pipeline/normalise.js";
import { keywordFilter } from "../src/pipeline/keywordFilter.js";
import { postFetchFilter } from "../src/pipeline/postFetchFilter.js";
import type { SearchProfile } from "../src/sources/types.js";
import type { NormalisedJob } from "../src/pipeline/types.js";

const SAMPLE = 8; // how many dropped jobs to show per stage

// ── Load profile ──────────────────────────────────────────────────────────────

const profileId = process.argv[2];
if (!profileId) {
  console.error("Usage: npx tsx scripts/debugPipeline.ts <profileId>");
  process.exit(1);
}

const { data: profileRaw } = await db
  .from("search_profiles")
  .select("id, user_id, keywords, location, visa_filter_mode, working_rights, target_verticals, adzuna_title_keywords, adzuna_exact_phrase, adzuna_any_keywords, adzuna_exclude_keywords, adzuna_salary_min, adzuna_salary_max, adzuna_contract_type, adzuna_hours, adzuna_distance_km, adzuna_max_days_old, exclude_title_keywords")
  .eq("id", profileId)
  .single();

if (!profileRaw) {
  console.error(`Profile ${profileId} not found`);
  process.exit(1);
}

const profile = { ...profileRaw, adzuna_max_days_old: profileRaw.adzuna_max_days_old ?? 14 } as SearchProfile & { user_id: string };

console.log("=".repeat(70));
console.log(`DEBUG PIPELINE DRY-RUN — profile: ${profileId}`);
console.log(`Keywords  : ${profile.keywords.join(", ")}`);
console.log(`Location  : ${profile.location}`);
console.log(`Title must contain: ${(profile as any).adzuna_title_keywords || "(none)"}`);
console.log(`Exclude from title: ${((profile as any).exclude_title_keywords ?? []).join(", ") || "(none)"}`);
console.log(`Lookback  : ${profile.adzuna_max_days_old}d`);
console.log("NOTE: Nothing is saved — read-only diagnostic");
console.log("=".repeat(70));

// ── Adapter filter ────────────────────────────────────────────────────────────

const adapterFilter = process.env.ADAPTERS?.split(",").map(a => a.trim()) ?? null;
const activeAdapters = adapterFilter
  ? adapters.filter(a => adapterFilter.includes(a.name))
  : adapters;

// ── Stage 2: Fetch ────────────────────────────────────────────────────────────

const rawJobs: { job: ReturnType<typeof normalise>, source: string }[] = [];

for (const adapter of activeAdapters) {
  console.log(`\n[fetch] ${adapter.name}...`);
  try {
    const results = await adapter.fetchJobs(profile);
    for (const j of results) rawJobs.push({ job: normalise(j), source: adapter.name });
    console.log(`[fetch] ${adapter.name}: ${results.length} raw`);
  } catch (err) {
    console.error(`[fetch] ${adapter.name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

const allNormalised = rawJobs.map(r => r.job);
console.log(`\n${"─".repeat(70)}`);
console.log(`TOTAL RAW (normalised): ${allNormalised.length}`);

// ── Stage 4b: Keyword filter ──────────────────────────────────────────────────

const afterKeyword = keywordFilter(allNormalised, profile.keywords);
const droppedByKeyword = allNormalised.filter(
  j => !afterKeyword.some(k => k.url === j.url)
);

console.log(`\n${"─".repeat(70)}`);
console.log(`STAGE 4b — KEYWORD FILTER`);
console.log(`  Kept   : ${afterKeyword.length}`);
console.log(`  Dropped: ${droppedByKeyword.length}`);

if (droppedByKeyword.length > 0) {
  console.log(`\n  Sample dropped (first ${Math.min(SAMPLE, droppedByKeyword.length)}):`);
  for (const j of droppedByKeyword.slice(0, SAMPLE)) {
    const descPreview = (j.description ?? "").slice(0, 60).replace(/\n/g, " ");
    console.log(`    [${j.source}] "${j.title}" @ ${j.company}`);
    console.log(`           desc: "${descPreview}"`);
  }

  // Group by source
  const bySource: Record<string, number> = {};
  for (const j of droppedByKeyword) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
  console.log(`\n  By source: ${Object.entries(bySource).map(([s, n]) => `${s}=${n}`).join(", ")}`);
}

// ── Stage 4c: Smart filter ────────────────────────────────────────────────────

const { kept: afterSmart, droppedTitleMissing, droppedTitleExcluded, droppedDescExcluded } =
  postFetchFilter(afterKeyword, profile);

const droppedBySmart = afterKeyword.filter(
  j => !afterSmart.some(k => k.url === j.url)
);

console.log(`\n${"─".repeat(70)}`);
console.log(`STAGE 4c — SMART FILTER`);
console.log(`  Kept              : ${afterSmart.length}`);
console.log(`  Title missing req : ${droppedTitleMissing}`);
console.log(`  Title excluded    : ${droppedTitleExcluded}`);
console.log(`  Desc excluded     : ${droppedDescExcluded}`);

if (droppedBySmart.length > 0) {
  console.log(`\n  Sample dropped (first ${Math.min(SAMPLE, droppedBySmart.length)}):`);
  for (const j of droppedBySmart.slice(0, SAMPLE)) {
    console.log(`    [${j.source}] "${j.title}" @ ${j.company}`);
  }
}

// ── Stage 5+6: Dedup ─────────────────────────────────────────────────────────

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

const hashed = afterSmart.map(j => ({
  ...j,
  url_hash: sha256(j.url),
  content_hash: sha256([j.title, j.company, j.location].join("|").toLowerCase()),
}));

const seenUrl = new Set<string>();
const seenContent = new Set<string>();
const afterDedup: NormalisedJob[] = [];
const droppedL1: NormalisedJob[] = [];
const droppedL2: NormalisedJob[] = [];

for (const j of hashed) {
  if (seenUrl.has(j.url_hash)) {
    droppedL1.push(j);
  } else if (seenContent.has(j.content_hash)) {
    droppedL2.push(j);
  } else {
    seenUrl.add(j.url_hash);
    seenContent.add(j.content_hash);
    afterDedup.push(j);
  }
}

console.log(`\n${"─".repeat(70)}`);
console.log(`STAGE 5+6 — DEDUP (in-batch only, no DB lookup)`);
console.log(`  Kept      : ${afterDedup.length}`);
console.log(`  L1 drops  : ${droppedL1.length}  (exact URL duplicate)`);
console.log(`  L2 drops  : ${droppedL2.length}  (same title+company+location on multiple sources)`);

if (droppedL2.length > 0) {
  console.log(`\n  Sample L2 dropped (same job on multiple sources):`);
  for (const j of droppedL2.slice(0, SAMPLE)) {
    console.log(`    [${j.source}] "${j.title}" @ ${j.company} — ${j.location}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(70)}`);
console.log(`SUMMARY`);
console.log(`  Raw fetched       : ${allNormalised.length}`);
console.log(`  After kw filter   : ${afterKeyword.length}   (dropped ${droppedByKeyword.length})`);
console.log(`  After smart filter: ${afterSmart.length}   (dropped ${droppedBySmart.length})`);
console.log(`  After dedup       : ${afterDedup.length}   (dropped ${droppedL1.length + droppedL2.length})`);
console.log(`  Would be saved    : ${afterDedup.length}`);
console.log("=".repeat(70));
console.log("\nDRY RUN COMPLETE — nothing was saved.");
