// Global job bucket — serve-into-jobs engine (Phase B/C).
//
// Architecture (decision: serve-into-jobs, 2026-06-25):
//   global_jobs (067) is the shared, deduplicated, 30-day canonical bucket.
//   The worker writes scraped survivors into it, then SERVES each profile by
//   materialising its `jobs` rows FROM the bucket — applying the profile's own
//   filters, tier-appropriate JD text, and per-user distance. So the existing
//   31 web read sites and the analyze/applications flows keep reading `jobs`
//   unchanged; profile_jobs (068) is reserved/unused under this model.
//
// Everything here is gated by USE_GLOBAL_BUCKET (default off) and is best-effort
// (try/catch): with the flag off, or before migrations 066-067 are applied, the
// worker behaves exactly as before.

import { db } from "../db/client.js";
import { normaliseCity } from "./normalise/keys.js";
import { applyKeywordFilter } from "./keywordFilter.js";
import { postFetchFilter } from "./postFetchFilter.js";
import { distanceFor, distanceFromCoords, geocodeLocation, type LatLng } from "../lib/distance.js";
import type { NormalisedJob } from "./types.js";
import type { SearchProfile } from "../sources/types.js";
import type { CoverageSlice } from "./coverage.js";

/** Feature flag — bucket write + serve only when explicitly enabled. */
export function bucketEnabled(): boolean {
  return process.env.USE_GLOBAL_BUCKET === "true";
}

/** Days the bucket retains a posting as discoverable (migration plan §10). */
export const BUCKET_RETENTION_DAYS = 30;

type JdAccess = "snippet" | "all" | "unlimited_only";

/**
 * JD access tier for a row (read-time gating contract):
 *   SEEK / Careerjet / board full JDs are free → 'all'.
 *   Adzuna full JD (actor/direct) is unlimited-only → 'unlimited_only'.
 *   Adzuna API snippet → 'snippet'.
 * `adzunaFull` = this run's Adzuna method produced full JDs (adzuna_method === 'direct').
 */
function deriveJdAccess(source: string, adzunaFull: boolean): JdAccess {
  if (source === "adzuna") return adzunaFull ? "unlimited_only" : "snippet";
  return "all";
}

// ── Write: scraped survivors → global_jobs (canonical) ───────────────────────

interface GlobalRow {
  url_hash: string;
  canonical_url: string;
  source: string;
  source_tier: number;
  title: string;
  company: string;
  location: string;
  location_cell: string;
  lat: number | null;
  lng: number | null;
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
 * Upsert scraped survivors into the canonical bucket. Merges matched_keywords
 * across runs/users (the bucket's coarse serve selector must accumulate).
 * Best-effort: returns silently on any error.
 */
export async function upsertGlobalJobs(
  jobs: NormalisedJob[],
  opts: { adzunaFull: boolean },
): Promise<void> {
  if (!bucketEnabled() || jobs.length === 0) return;
  try {
    const now = new Date().toISOString();
    const hashes = Array.from(new Set(jobs.map((j) => j.url_hash)));

    // Merge with existing matched_keywords + reuse already-geocoded coords.
    const existingKw = new Map<string, string[]>();
    const existingCoords = new Map<string, { lat: number | null; lng: number | null }>();
    const { data: existing } = await db
      .from("global_jobs")
      .select("url_hash, matched_keywords, lat, lng")
      .in("url_hash", hashes);
    for (const r of (existing ?? []) as Array<{ url_hash: string; matched_keywords: string[]; lat: number | null; lng: number | null }>) {
      existingKw.set(r.url_hash, r.matched_keywords ?? []);
      existingCoords.set(r.url_hash, { lat: r.lat, lng: r.lng });
    }

    // De-dup incoming by url_hash (keep first — carries winning content).
    const byHash = new Map<string, NormalisedJob>();
    for (const j of jobs) if (!byHash.has(j.url_hash)) byHash.set(j.url_hash, j);

    // Geocode-on-write: geocode ONLY postings that aren't already in the bucket
    // with coords. Done once per posting ever (serial — Nominatim's 1.1s/req
    // policy), then reused by every serve so distance never re-geocodes.
    const coords = new Map<string, LatLng | null>();
    for (const j of byHash.values()) {
      const prior = existingCoords.get(j.url_hash);
      if (prior && prior.lat != null && prior.lng != null) {
        coords.set(j.url_hash, { lat: prior.lat, lng: prior.lng });
      } else {
        coords.set(j.url_hash, j.location ? await geocodeLocation(j.location) : null);
      }
    }

    const rows: GlobalRow[] = Array.from(byHash.values()).map((j) => {
      const jd_access = deriveJdAccess(j.source, opts.adzunaFull);
      const mergedKw = Array.from(
        new Set([...(existingKw.get(j.url_hash) ?? []), ...(j.keywords_matched ?? [])]),
      );
      const c = coords.get(j.url_hash) ?? null;
      return {
        url_hash: j.url_hash,
        canonical_url: j.url,
        source: j.source,
        source_tier: j.source_tier,
        title: j.title,
        company: j.company,
        location: j.location,
        location_cell: normaliseCity(j.location),
        lat: c?.lat ?? null,
        lng: c?.lng ?? null,
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

    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await db
        .from("global_jobs")
        .upsert(batch, { onConflict: "url_hash", ignoreDuplicates: false });
      if (error) {
        console.warn(`[bucket] upsertGlobalJobs skipped — ${error.message}`);
        return;
      }
    }
    console.log(`[bucket] upserted ${rows.length} canonical rows`);
  } catch (err) {
    console.warn(`[bucket] upsertGlobalJobs threw — ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Evict postings older than the 30-day retention from the bucket. Simple under
 * serve-into-jobs: global_jobs is referenced by nothing (per-user state and the
 * analysis_runs FK both live on `jobs`), so a plain DELETE is safe. Uses
 * first_seen_at as the reliable clock (posted_at is often null/relative).
 * Best-effort; runs once per pipeline invocation (indexed, mostly a no-op).
 */
export async function evictStaleBucket(): Promise<void> {
  if (!bucketEnabled()) return;
  try {
    const floor = new Date(Date.now() - BUCKET_RETENTION_DAYS * 86_400_000).toISOString();
    const { error } = await db.from("global_jobs").delete().lt("first_seen_at", floor);
    if (error) console.warn(`[bucket] evictStaleBucket skipped — ${error.message}`);
  } catch (err) {
    console.warn(`[bucket] evictStaleBucket threw — ${err instanceof Error ? err.message : err}`);
  }
}

// ── Serve: bucket → this profile's jobs rows (projection) ────────────────────

interface BucketRow {
  url_hash: string;
  canonical_url: string;
  source: string;
  source_tier: number;
  title: string;
  company: string;
  location: string;
  lat: number | null;
  lng: number | null;
  matched_keywords: string[];
  description_snippet: string | null;
  description_full: string | null;
  jd_access: JdAccess;
  salary_min: number | null;
  salary_max: number | null;
  sponsorship_status: NormalisedJob["sponsorship_status"] | null;
  citizen_pr_only: boolean | null;
  posted_at: string | null;
  expires_at: string | null;
}

/** Choose tier-appropriate JD text. Adzuna full JD is gated to unlimited. */
function projectDescription(row: BucketRow, tier: string): string {
  const full = row.description_full ?? row.description_snippet ?? "";
  const snippet = row.description_snippet ?? full;
  if (row.jd_access === "unlimited_only" && tier !== "unlimited") return snippet;
  return full;
}

/**
 * Serve a profile from the bucket: select the bucket rows for the profile's
 * location-cells within the retention window, apply the profile's keyword /
 * title / description / working-rights filters and per-user distance, and
 * return them as NormalisedJob[] ready for the existing saveJobs() upsert into
 * `jobs`. Tier governs Adzuna full-vs-snippet JD.
 *
 * Returns null (caller keeps the legacy scraped set) on any failure.
 */
export async function serveProfileFromBucket(
  profile: SearchProfile,
  slices: CoverageSlice[],
  opts: { tier: string; homeOrigin: LatLng | null; serveWindowDays?: number },
): Promise<NormalisedJob[] | null> {
  if (!bucketEnabled()) return null;
  try {
    const cells = Array.from(new Set(slices.map((s) => s.location_cell)));
    if (cells.length === 0) return null;
    const windowDays = Math.min(opts.serveWindowDays ?? BUCKET_RETENTION_DAYS, BUCKET_RETENTION_DAYS);
    const floor = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    let query = db
      .from("global_jobs")
      .select("url_hash, canonical_url, source, source_tier, title, company, location, lat, lng, matched_keywords, description_snippet, description_full, jd_access, salary_min, salary_max, sponsorship_status, citizen_pr_only, posted_at, expires_at")
      .eq("is_dead_link", false)
      .eq("is_expired", false)
      .or(`posted_at.gte.${floor},posted_at.is.null`)
      .limit(5000);
    // location_cell '' = all-AU search → don't constrain by cell.
    const realCells = cells.filter((c) => c.length > 0);
    if (realCells.length > 0 && !cells.includes("")) {
      query = query.in("location_cell", realCells);
    }

    const { data, error } = await query;
    if (error) {
      console.warn(`[bucket] serve query skipped — ${error.message}`);
      return null;
    }
    const rows = (data ?? []) as BucketRow[];
    if (rows.length === 0) return [];

    // Map → NormalisedJob with tier-appropriate JD. duplicate_of/repost_of are
    // dropped (they reference global_jobs ids, not jobs ids); the bucket is
    // already deduped so served rows are 'original'.
    const mapped: NormalisedJob[] = rows.map((r) => ({
      url: r.canonical_url,
      url_hash: r.url_hash,
      content_hash: "",
      title: r.title,
      company: r.company,
      location: r.location,
      description: projectDescription(r, opts.tier),
      source: r.source,
      source_tier: r.source_tier,
      posted_at: r.posted_at,
      expires_at: r.expires_at,
      salary_min: r.salary_min ?? undefined,
      salary_max: r.salary_max ?? undefined,
      keywords_matched: r.matched_keywords ?? [],
      dedup_status: "original",
      duplicate_of: null,
      repost_of: null,
      sponsorship_status: r.sponsorship_status ?? "not_mentioned",
      citizen_pr_only: r.citizen_pr_only,
      visa_extracted_text: null,
      distance_km: null,
      distance_method: null,
    }));

    // Replay the profile's filters (same passes as the scrape path).
    let kept = applyKeywordFilter(mapped, profile);
    kept = postFetchFilter(kept, profile).kept;
    if (profile.working_rights === "needs_sponsorship") {
      kept = kept.filter((j) => j.sponsorship_status !== "no" && j.citizen_pr_only !== true);
    }

    // Per-user distance. Uses each posting's STORED lat/lng (geocoded once at
    // write) so no Nominatim geocoding happens here — only the OSRM driving call
    // (no rate gap). Falls back to distanceFor() (geocode + cache) for rows that
    // somehow lack coords.
    if (opts.homeOrigin) {
      const origin = opts.homeOrigin;
      const coordsByHash = new Map(rows.map((r) => [r.url_hash, { lat: r.lat, lng: r.lng }]));
      const out: NormalisedJob[] = [];
      for (const j of kept) {
        const c = coordsByHash.get(j.url_hash);
        let d = null;
        if (c && c.lat != null && c.lng != null) {
          d = await distanceFromCoords(origin, { lat: c.lat, lng: c.lng });
        } else if (j.location) {
          d = await distanceFor(origin, j.location);
        }
        out.push(d ? { ...j, distance_km: d.km, distance_method: d.method } : j);
      }
      kept = out;
    }

    console.log(`[bucket] served ${kept.length}/${rows.length} from bucket (tier=${opts.tier}, window ${windowDays}d)`);
    return kept;
  } catch (err) {
    console.warn(`[bucket] serveProfileFromBucket threw — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
