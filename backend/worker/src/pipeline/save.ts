// Stage 12 — Idempotent upsert into Supabase
// Conflict on (profile_id, url_hash) → update mutable fields only
import { db } from "../db/client.js";
import type { NormalisedJob } from "./types.js";
import { checkExpiry } from "./expiry.js";

export interface SaveResult {
  saved: number;
  errors: number;
  bySource: Record<string, number>;
  /** Phase E-1 — IDs of the upserted rows (both new + re-touched).
   *  The worker's auto-analyze step filters this list to only
   *  newly-discovered jobs (no prior analysis_run) before queuing. */
  savedIds: string[];
}

export async function saveJobs(
  jobs: NormalisedJob[],
  profileId: string
): Promise<SaveResult> {
  if (jobs.length === 0) return { saved: 0, errors: 0, bySource: {}, savedIds: [] };

  const bySource: Record<string, number> = {};
  for (const j of jobs) bySource[j.source] = (bySource[j.source] ?? 0) + 1;

  const rows = jobs.map((job) => {
    const { is_expired, expires_at } = checkExpiry(job);
    return {
      profile_id: profileId,
      url_hash: job.url_hash,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      source: job.source,
      source_tier: job.source_tier,
      posted_at: job.posted_at,
      expires_at,
      is_expired,
      dedup_status: job.dedup_status,
      duplicate_of: job.duplicate_of,
      repost_of: job.repost_of,
      keywords_matched: job.keywords_matched,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      sponsorship_status: job.sponsorship_status,
      citizen_pr_only: job.citizen_pr_only,
      visa_extracted_text: job.visa_extracted_text,
      distance_km: job.distance_km,
      distance_method: job.distance_method,
    };
  });

  // Upsert in batches of 100 to avoid payload size limits
  const BATCH = 100;
  let saved = 0;
  let errors = 0;
  const savedIds: string[] = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error, count, data } = await db
      .from("jobs")
      .upsert(batch, {
        onConflict: "profile_id,url_hash",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      console.error("[save] upsert batch error:", error.message);
      errors += batch.length;
    } else {
      saved += count ?? batch.length;
      for (const row of (data ?? []) as Array<{ id: string }>) {
        savedIds.push(row.id);
      }
    }
  }

  return { saved, errors, bySource, savedIds };
}
