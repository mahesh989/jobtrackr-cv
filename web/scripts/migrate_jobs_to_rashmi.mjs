/**
 * One-time job migration script
 *
 * Copies unique within-25km jobs from maheshtwari99@gmail.com
 * to rashmipoudel756@gmail.com into a new profile "Transferred jobs".
 *
 * What it does:
 *   1. Finds all of mahesh's jobs where distance_km <= 25 and not dismissed
 *   2. Deduplicates within mahesh (same URL across multiple profiles → keep latest)
 *   3. Removes any URL already present in rashmi's account (by url_hash)
 *   4. Creates a new inactive profile "Transferred jobs" on rashmi's account
 *   5. Inserts the unique jobs into that profile (no analysis results, fresh seen/applied state)
 *
 * Prerequisites:
 *   - NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set
 *     (either in .env.local or as environment variables)
 *   - The distance filter only works if mahesh's search profiles have a home address
 *     set (search_profiles.home_lat/home_lng) so the worker has populated distance_km.
 *     If distance_km is NULL on most jobs, see the "null distance" note printed at runtime.
 *
 * Usage:
 *   # Dry run first (shows counts, samples 5 jobs — no writes):
 *   node scripts/migrate_jobs_to_rashmi.mjs --dry-run
 *
 *   # Live run:
 *   node scripts/migrate_jobs_to_rashmi.mjs
 *
 *   # Skip distance filter (transfer ALL unique jobs regardless of distance):
 *   node scripts/migrate_jobs_to_rashmi.mjs --no-distance-filter
 *
 * After running:
 *   - Log in as rashmipoudel756@gmail.com
 *   - Go to /dashboard/profiles — you'll see "Transferred jobs" (inactive)
 *   - Rename it, activate it, or browse the jobs
 *   - To remove it: delete the profile from the UI (cascades jobs too)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const FROM_EMAIL      = "maheshtwari99@gmail.com";
const TO_EMAIL        = "rashmipoudel756@gmail.com";
const NEW_PROFILE_NAME = "Transferred jobs";
const MAX_DISTANCE_KM  = 25;

const DRY_RUN            = process.argv.includes("--dry-run");
const NO_DISTANCE_FILTER = process.argv.includes("--no-distance-filter");

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnvFile(filePath) {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, "")];
        })
    );
  } catch {
    return {};
  }
}

const envFile = loadEnvFile(join(__dirname, "../.env.local"));

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL  || envFile.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || envFile.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌  Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  console.error("    Set them in web/.env.local or as environment variables.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg, err) {
  console.error(`❌  ${msg}`, err?.message ?? "");
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN (no writes) ===" : "=== LIVE RUN ===");
  console.log(`Distance filter: ${NO_DISTANCE_FILTER ? "OFF (all jobs)" : `<= ${MAX_DISTANCE_KM} km`}`);
  console.log("");

  // 1. Resolve user IDs
  const [{ data: fromUser, error: e1 }, { data: toUser, error: e2 }] = await Promise.all([
    admin.from("users").select("id, email").eq("email", FROM_EMAIL).single(),
    admin.from("users").select("id, email").eq("email", TO_EMAIL).single(),
  ]);
  if (e1 || !fromUser) die(`Source user not found: ${FROM_EMAIL}`, e1);
  if (e2 || !toUser)   die(`Target user not found: ${TO_EMAIL}`, e2);
  console.log(`Source: ${fromUser.email}  (${fromUser.id})`);
  console.log(`Target: ${toUser.email}  (${toUser.id})`);

  // 2. Source profiles
  const { data: fromProfilesRaw } = await admin
    .from("search_profiles").select("id, name").eq("user_id", fromUser.id);
  const fromProfiles   = fromProfilesRaw ?? [];
  const fromProfileIds = fromProfiles.map((p) => p.id);
  console.log(`\nSource profiles (${fromProfiles.length}): ${fromProfiles.map((p) => p.name).join(", ") || "(none)"}`);

  if (fromProfileIds.length === 0) { console.log("No source profiles — nothing to migrate."); return; }

  // 3. Fetch source jobs
  let jobQuery = admin.from("jobs")
    .select("*")
    .in("profile_id", fromProfileIds)
    .is("dismissed_at", null);

  if (!NO_DISTANCE_FILTER) {
    jobQuery = jobQuery.lte("distance_km", MAX_DISTANCE_KM);
  }

  const { data: rawFromJobs, error: jobErr } = await jobQuery;
  if (jobErr) die("Failed to fetch source jobs", jobErr);

  const fromJobs = rawFromJobs ?? [];
  const nullDistCount = fromJobs.filter((j) => j.distance_km == null).length;

  console.log(`\nSource jobs matching filter: ${fromJobs.length}`);

  if (!NO_DISTANCE_FILTER && fromJobs.length === 0) {
    console.log(
      "\n⚠  Zero jobs matched the distance filter. This usually means mahesh's search profiles\n" +
      "   don't have a home address set, so the worker never populated distance_km.\n\n" +
      "   Options:\n" +
      "   a) Set a home address in /dashboard/settings/profile for mahesh's account and\n" +
      "      wait for the next worker run (or re-run manually) to populate distance_km.\n" +
      "   b) Run with --no-distance-filter to transfer ALL unique jobs regardless of distance.\n"
    );
    return;
  }

  if (nullDistCount > 0 && !NO_DISTANCE_FILTER) {
    console.log(`   ℹ  ${nullDistCount} jobs have null distance_km and are excluded by the filter.`);
  }

  // Dedup within source: same url_hash across multiple profiles → keep latest
  const sourceByHash = new Map();
  for (const j of fromJobs) {
    const existing = sourceByHash.get(j.url_hash);
    if (!existing || new Date(j.created_at) > new Date(existing.created_at)) {
      sourceByHash.set(j.url_hash, j);
    }
  }
  console.log(`After dedup within source: ${sourceByHash.size} unique jobs`);

  // 4. Target user's existing url_hashes (all profiles)
  const { data: toProfilesRaw } = await admin
    .from("search_profiles").select("id").eq("user_id", toUser.id);
  const toProfileIds = (toProfilesRaw ?? []).map((p) => p.id);

  let existingHashes = new Set();
  if (toProfileIds.length > 0) {
    // Fetch in pages if rashmi has many jobs
    let page = 0;
    const PAGE = 1000;
    while (true) {
      const { data: chunk } = await admin.from("jobs")
        .select("url_hash")
        .in("profile_id", toProfileIds)
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (!chunk || chunk.length === 0) break;
      chunk.forEach((j) => existingHashes.add(j.url_hash));
      if (chunk.length < PAGE) break;
      page++;
    }
  }
  console.log(`Rashmi's existing url_hashes: ${existingHashes.size}`);

  // 5. Final list: unique to source, not in target
  const toInsert = [...sourceByHash.values()].filter((j) => !existingHashes.has(j.url_hash));
  console.log(`\nJobs to transfer: ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("All of mahesh's nearby jobs already exist in rashmi's account. Nothing to do.");
    return;
  }

  // Print sample
  console.log("\nSample (first 8):");
  toInsert.slice(0, 8).forEach((j) =>
    console.log(`  • ${j.title} @ ${j.company} [${j.location}] — ${j.distance_km != null ? j.distance_km.toFixed(1) + "km" : "dist?"} — ${j.source}`)
  );
  if (toInsert.length > 8) console.log(`  … and ${toInsert.length - 8} more`);

  if (DRY_RUN) {
    console.log("\n✅  Dry run complete — no data written. Run without --dry-run to execute.");
    return;
  }

  // 6. Create new profile for rashmi
  const { data: newProfile, error: profErr } = await admin
    .from("search_profiles")
    .insert({ user_id: toUser.id, name: NEW_PROFILE_NAME, is_active: false })
    .select()
    .single();
  if (profErr || !newProfile) die("Failed to create profile", profErr);
  console.log(`\n✅  Created profile "${NEW_PROFILE_NAME}" — ID: ${newProfile.id} (inactive)`);

  // 7. Batch-insert jobs
  // Columns that must NOT be copied from source (reset to fresh/neutral values,
  // or GENERATED ALWAYS columns that Postgres computes automatically).
  const SKIP = new Set([
    "id",           // auto-generated
    "profile_id",   // set to new profile
    "seen_at",      // fresh
    "applied_at",   // fresh
    "dismissed_at", // fresh
    "duplicate_of", // profile-specific
    "repost_of",    // profile-specific
    "created_at",   // use DB default (now())
    "updated_at",   // use DB default
    "has_email",    // GENERATED ALWAYS AS (contact_email IS NOT NULL) — cannot insert manually
  ]);

  const BATCH = 100;
  let inserted = 0;
  let errors   = 0;

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map((j) => {
      const row = { profile_id: newProfile.id, dedup_status: "original" };
      for (const [k, v] of Object.entries(j)) {
        if (!SKIP.has(k) && v !== undefined) row[k] = v;
      }
      return row;
    });

    const { error: insertErr } = await admin.from("jobs").insert(batch);
    if (insertErr) {
      console.error(`\n  ⚠ Batch error at offset ${i}: ${insertErr.message}`);
      errors++;
    } else {
      inserted += batch.length;
      process.stdout.write(`\r  Inserted ${inserted}/${toInsert.length}...`);
    }
  }

  console.log(`\n\n✅  Done!`);
  console.log(`   ${inserted} jobs inserted into "${NEW_PROFILE_NAME}" on ${TO_EMAIL}`);
  if (errors > 0) console.log(`   ⚠  ${errors} batch(es) failed — check output above`);
  console.log(`\n   Next steps:`);
  console.log(`   1. Log in as ${TO_EMAIL}`);
  console.log(`   2. Go to /dashboard/profiles`);
  console.log(`   3. You'll see "${NEW_PROFILE_NAME}" (inactive) — rename and activate when ready`);
  console.log(`   4. To undo: delete the "${NEW_PROFILE_NAME}" profile (cascades all its jobs)`);
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
