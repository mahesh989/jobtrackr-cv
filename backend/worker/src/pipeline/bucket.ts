// Global job bucket — dual-write (Phase B foundation).
//
// Writes the canonical posting to `global_jobs` (migration 067) and a per-user
// link row to `profile_jobs` (migration 068), IN ADDITION to the existing
// per-profile `jobs` upsert. This runs ONLY when USE_GLOBAL_BUCKET=true, and is
// fully best-effort (try/catch): a missing table or any error is logged and
// swallowed so the live pipeline is never affected.
//
// DORMANT by default. Nothing reads global_jobs/profile_jobs yet — the read-path
// switch and the precise snippet-vs-full JD split are deferred to the read-path
// build (so the approximations below are harmless until then). Today's source of
// truth for the UI remains `jobs`.

import { db } from "../db/client.js";
import { normaliseCity } from "./normalise/keys.js";
import type { NormalisedJob } from "./types.js";

/** Feature flag — dual-write to the bucket only when explicitly enabled. */
export function bucketWriteEnabled(): boolean {
  return process.env.USE_GLOBAL_BUCKET === "true";
}

/**
 * JD access tier for a row (read-time gating contract):
 *   SEEK / Careerjet full JDs are free → 'all'.
 *   Adzuna full JD (actor/direct) is an unlimited-only feature → 'unlimited_only'.
 *   Adzuna API snippet → 'snippet'.
 *   Other board sources (greenhouse/RSS/etc.) ship full JDs → 'all'.
 * `adzunaFull` = the run's Adzuna method produced full JDs (profile.adzuna_method === 'direct').
 */
function deriveJdAccess(source: string, adzunaFull: boolean): "snippet" | "all" | "unlimited_only" {
  if (source === "adzuna") return adzunaFull ? "unlimited_only" : "snippet";
  return "all";
}

interface GlobalRow {
  url_hash: string;
  canonical_url: string;
  source: string;
  source_tier: number;
  title: string;
  company: string;
  location: string;
  location_cell: string;
  matched_keywords: string[];
  description_snippet: string | null;
  description_full: string | null;
  jd_access: string;
  salary_min: number | null;
  salary_max: number | null;
  sponsorship_status: string | null;
  citizen_pr_only: boolean | null;
  posted_at: string | null;
  expires_at: string | null;
  last_seen_at: string;
}

/**
 * Dual-write `jobs` -> (global_jobs, profile_jobs). Best-effort; returns silently
 * on any failure. Call AFTER the existing saveJobs() so the legacy path is the
 * source of truth and this is purely additive.
 */
export async function dualWriteBucket(
  jobs: NormalisedJob[],
  profileId: string,
  opts: { adzunaFull: boolean },
): Promise<void> {
  if (!bucketWriteEnabled() || jobs.length === 0) return;
  try {
    const now = new Date().toISOString();

    // ── 1. Merge matched_keywords with any existing bucket rows (the bucket's
    //       coarse serve selector must accumulate across runs/users). ──────────
    const hashes = Array.from(new Set(jobs.map((j) => j.url_hash)));
    const existingKw = new Map<string, string[]>();
    {
      const { data } = await db
        .from("global_jobs")
        .select("url_hash, matched_keywords")
        .in("url_hash", hashes);
      for (const r of (data ?? []) as Array<{ url_hash: string; matched_keywords: string[] }>) {
        existingKw.set(r.url_hash, r.matched_keywords ?? []);
      }
    }

    // De-dup incoming by url_hash (jobs may include possible_duplicate rows;
    // keep the first occurrence which carries the winning content).
    const byHash = new Map<string, NormalisedJob>();
    for (const j of jobs) if (!byHash.has(j.url_hash)) byHash.set(j.url_hash, j);

    const globalRows: GlobalRow[] = Array.from(byHash.values()).map((j) => {
      const jd_access = deriveJdAccess(j.source, opts.adzunaFull);
      const mergedKw = Array.from(
        new Set([...(existingKw.get(j.url_hash) ?? []), ...(j.keywords_matched ?? [])]),
      );
      return {
        url_hash: j.url_hash,
        canonical_url: j.url,
        source: j.source,
        source_tier: j.source_tier,
        title: j.title,
        company: j.company,
        location: j.location,
        location_cell: normaliseCity(j.location),
        matched_keywords: mergedKw,
        description_snippet: j.description ?? null,
        description_full: jd_access === "snippet" ? null : (j.description ?? null),
        jd_access,
        salary_min: j.salary_min ?? null,
        salary_max: j.salary_max ?? null,
        sponsorship_status: j.sponsorship_status ?? null,
        citizen_pr_only: j.citizen_pr_only,
        posted_at: j.posted_at,
        expires_at: j.expires_at,
        last_seen_at: now,
      };
    });

    // ── 2. Upsert canonical rows, return their ids keyed by url_hash. ─────────
    const idByHash = new Map<string, string>();
    const BATCH = 100;
    for (let i = 0; i < globalRows.length; i += BATCH) {
      const batch = globalRows.slice(i, i + BATCH);
      const { data, error } = await db
        .from("global_jobs")
        .upsert(batch, { onConflict: "url_hash", ignoreDuplicates: false })
        .select("id, url_hash");
      if (error) {
        console.warn(`[bucket] global_jobs upsert skipped — ${error.message}`);
        return;
      }
      for (const r of (data ?? []) as Array<{ id: string; url_hash: string }>) {
        idByHash.set(r.url_hash, r.id);
      }
    }

    // ── 3. Upsert per-user link rows. ────────────────────────────────────────
    const profileRows = Array.from(byHash.values())
      .map((j) => {
        const gid = idByHash.get(j.url_hash);
        if (!gid) return null;
        return {
          profile_id: profileId,
          global_job_id: gid,
          keywords_matched: j.keywords_matched ?? [],
          distance_km: j.distance_km,
          distance_method: j.distance_method,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < profileRows.length; i += BATCH) {
      const batch = profileRows.slice(i, i + BATCH);
      const { error } = await db
        .from("profile_jobs")
        .upsert(batch, { onConflict: "profile_id,global_job_id", ignoreDuplicates: false });
      if (error) {
        console.warn(`[bucket] profile_jobs upsert skipped — ${error.message}`);
        return;
      }
    }

    console.log(`[bucket] dual-write ok — ${globalRows.length} global, ${profileRows.length} links`);
  } catch (err) {
    console.warn(`[bucket] dualWriteBucket threw — ${err instanceof Error ? err.message : err}`);
  }
}
