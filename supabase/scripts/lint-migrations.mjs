#!/usr/bin/env node
/**
 * Migration lint.
 *
 * Migrations in supabase/migrations are applied in filename order by their
 * numeric prefix (001_, 002_, …). Two files sharing a prefix make apply-order
 * ambiguous. This repo has one historical collision (both 027_*) that is
 * already applied in production — rewriting applied migration history is an
 * anti-pattern, so it's grandfathered here. This guard stops NEW collisions.
 *
 * Run: `node supabase/scripts/lint-migrations.mjs`
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

// Known historical collisions — already applied, do not "fix" by renaming.
//   027: 027_add_company_address_to_jobs / 027_cover_letter_variants
//   041: 041_global_ats_thresholds_60_70 / 041_profile_source_selection
const GRANDFATHERED = new Set(["027", "041"]);

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const byPrefix = new Map();
for (const f of files) {
  const m = f.match(/^(\d+)/);
  if (!m) {
    console.error(`✗ migration has no numeric prefix: ${f}`);
    process.exit(1);
  }
  const prefix = m[1];
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(f);
}

const newCollisions = [];
for (const [prefix, group] of byPrefix) {
  if (group.length > 1 && !GRANDFATHERED.has(prefix)) newCollisions.push([prefix, group]);
}

if (newCollisions.length) {
  console.error("\n✗ Duplicate migration version prefixes (apply-order is ambiguous):\n");
  for (const [prefix, group] of newCollisions) {
    console.error(`   ${prefix}: ${group.join(", ")}`);
  }
  console.error("\nGive the new migration the next free number instead.\n");
  process.exit(1);
}

const note = GRANDFATHERED.size ? ` (${[...GRANDFATHERED].join(", ")} grandfathered)` : "";
console.log(`✓ migration lint: ${files.length} migrations, no new prefix collisions${note}.`);
