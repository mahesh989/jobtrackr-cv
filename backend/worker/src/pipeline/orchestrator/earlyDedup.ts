import { createHash } from "crypto";
import { db } from "../../db/client.js";
import type { RawJob } from "../../sources/types.js";
import { canonicalUrl } from "../normalise.js";

/**
 * Stages 3 + 3b - early URL-hash dedup against rows this profile already has,
 * then against the user's SIBLING profiles (a job already seen in another
 * profile of the same user is dropped; profiles act as filter views).
 *
 * HASH DIVERGENCE - INTENTIONAL, DO NOT "FIX" HERE.
 * This stage hashes sha256(canonicalUrl(url)) - case-PRESERVING - while
 * dedup.ts computeHashes (whose output is what actually reaches jobs.url_hash
 * via saveJobs) hashes sha256(canonicalUrl(url).toLowerCase()). For URLs with
 * uppercase path/query chars (Avature, SuccessFactors) the two disagree, so
 * these lookups silently miss. Unifying them would CHANGE PRODUCTION BEHAVIOUR
 * (cross-profile dedup would start working and jobs would vanish from
 * profiles) and is tracked separately. Kept verbatim on purpose.
 */
export async function earlyDedup(
  rawJobs: RawJob[],
  profileId: string,
  userId: string,
): Promise<{ jobs: RawJob[]; dropped: number }> {
  let dropped = 0;
  // Stage 3: L1 early URL dedup
  // Hash the canonical URL (same transform dedup.ts uses) so the DB lookup
  // actually matches rows saved by previous runs.
  const rawHashes = new Set<string>();
  const uniqueRawJobs: RawJob[] = [];
  const hashedRawJobs = rawJobs.map(job => {
    return { job, hash: createHash("sha256").update(canonicalUrl(job.url)).digest("hex") };
  });

  // Batch query DB for these hashes — CHUNKED. A single .in() with ~1000
  // 64-char hashes builds a ~64KB GET querystring, past PostgREST/proxy URL
  // limits; the request degraded into a multi-minute stall and then failed
  // silently (data=null → "0 duplicates removed" even when dupes existed).
  // 150 hashes/chunk keeps each URL ~10KB; chunks run in parallel.
  const t3 = Date.now();
  const urlHashesToQuery = hashedRawJobs.map(h => h.hash);
  const HASH_CHUNK = 150;
  const chunks: string[][] = [];
  for (let i = 0; i < urlHashesToQuery.length; i += HASH_CHUNK) {
    chunks.push(urlHashesToQuery.slice(i, i + HASH_CHUNK));
  }
  const existingHashSet = new Set<string>();
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      db.from("jobs").select("url_hash").eq("profile_id", profileId).in("url_hash", chunk),
    ),
  );
  for (const { data, error } of chunkResults) {
    if (error) {
      // Non-fatal: missing early dedup just means L2 catches the dupes later.
      console.warn(`[pipeline] stage 3 — L1 hash lookup chunk failed: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) existingHashSet.add((row as { url_hash: string }).url_hash);
  }
  console.log(`[pipeline] stage 3 — L1 hash lookup: ${chunks.length} chunk(s) in ${Date.now() - t3}ms`);

  let earlyL1Dropped = 0;
  for (const { job, hash } of hashedRawJobs) {
    if (existingHashSet.has(hash) || rawHashes.has(hash)) {
      earlyL1Dropped++;
    } else {
      rawHashes.add(hash);
      uniqueRawJobs.push(job);
    }
  }

  dropped += earlyL1Dropped;
  console.log(`[pipeline] stage 3 — L1 early drop: ${earlyL1Dropped} duplicates removed, ${uniqueRawJobs.length} remaining`);

  // Stage 3b — cross-profile dedup (skip)
  // If a URL already exists in ANY other profile of the same user, drop it
  // entirely from this profile's feed. Profiles act as filter views: a job
  // a user has already seen elsewhere should not reappear in another profile.
  const newRawJobs: RawJob[] = [];

  const { data: siblingProfiles } = await db
    .from("search_profiles")
    .select("id")
    .eq("user_id", userId)
    .neq("id", profileId);

  const siblingIds = (siblingProfiles ?? []).map((p) => p.id);

  if (siblingIds.length > 0 && uniqueRawJobs.length > 0) {
    const hashByJob = uniqueRawJobs.map((j) => ({
      job:  j,
      hash: createHash("sha256").update(canonicalUrl(j.url)).digest("hex"),
    }));

    const { data: existingRows } = await db
      .from("jobs")
      .select("url_hash")
      .in("profile_id", siblingIds)
      .in("url_hash", hashByJob.map((x) => x.hash));

    const seenInSiblings = new Set(
      (existingRows ?? []).map((r) => r.url_hash as string)
    );

    let droppedCrossProfile = 0;
    for (const { job, hash } of hashByJob) {
      if (seenInSiblings.has(hash)) {
        droppedCrossProfile++;
      } else {
        newRawJobs.push(job);
      }
    }

    dropped += droppedCrossProfile;
    console.log(
      `[pipeline] stage 3b — cross-profile dedup: ${droppedCrossProfile} dropped ` +
      `(already in sibling profile), ${newRawJobs.length} remain`
    );
  } else {
    newRawJobs.push(...uniqueRawJobs);
    if (siblingIds.length === 0) {
      console.log(`[pipeline] stage 3b — first profile for user, no cross-profile dedup`);
    }
  }

  return { jobs: newRawJobs, dropped };
}
