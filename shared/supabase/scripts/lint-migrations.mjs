#!/usr/bin/env node
/**
 * Migration lint.
 *
 * Migrations in supabase/migrations are applied in filename order by their
 * numeric prefix (001_, 002_, …). Two files sharing a prefix make apply-order
 * ambiguous. This guard stops collisions. (The pre-squash history, including
 * its two grandfathered collisions, lives untouched in migrations/archive/.)
 *
 * Run: `node supabase/scripts/lint-migrations.mjs`
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

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
  if (group.length > 1) newCollisions.push([prefix, group]);
}

if (newCollisions.length) {
  console.error("\n✗ Duplicate migration version prefixes (apply-order is ambiguous):\n");
  for (const [prefix, group] of newCollisions) {
    console.error(`   ${prefix}: ${group.join(", ")}`);
  }
  console.error("\nGive the new migration the next free number instead.\n");
  process.exit(1);
}

console.log(`✓ migration lint: ${files.length} migrations, no prefix collisions.`);
