// Beta tool — per-source dry-run pipeline evaluator.
//
// Runs ONE source adapter against a synthetic ad-hoc search (free-form
// keywords / location / posted-within window) and reports counts at every
// pipeline stage. Never writes to the jobs table. Used to compare adapter
// coverage and debug source-specific gaps (especially SEEK direct vs Apify).
//
// Pipeline stages mirrored (dry-run):
//   1. Adapter fetch                              → fetched
//   2. URL dedup vs ALL the user's existing jobs  → after_url_dedup
//   3. Keyword filter                             → after_keyword
//   4. Smart filter (no-op in ad-hoc mode)        → after_smart
//   5. Content dedup (L1+L2, in-batch only)       → after_dedup
//   6. JD enrichment (SEEK direct/apify, Careerjet)
//   7. JD-quality count (full vs thin)            → full_jd / thin_jd
//
// Source key → adapter:
//   adzuna       → adzunaAdapter
//   seek_direct  → seekDirectAdapter
//   seek_apify   → createSeekAdapter(token) — requires Apify integration
//   careerjet    → careerjetAdapter
//   greenhouse   → greenhouseAdapter
//   lever        → leverAdapter

import { createHash, randomUUID } from "crypto";
import { db } from "../db/client.js";
import { adzunaAdapter } from "../sources/adzuna.js";
import { careerjetAdapter, enrichWithCareerjetJDs } from "../sources/careerjet.js";
import { greenhouseAdapter } from "../sources/greenhouse.js";
import { leverAdapter } from "../sources/lever.js";
import { seekDirectAdapter, enrichWithDirectJDs } from "../sources/seekDirect.js";
import { createSeekAdapter, enrichWithFullJDs } from "../sources/seek.js";
import type { RawJob, SearchProfile } from "../sources/types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import { normalise, canonicalUrl } from "../pipeline/normalise.js";
import { keywordFilter } from "../pipeline/keywordFilter.js";
import { postFetchFilter } from "../pipeline/postFetchFilter.js";
import { dedup } from "../pipeline/dedup.js";
import { decryptApiKey } from "../lib/crypto.js";

// JD-quality threshold. Adzuna/Greenhouse/Lever return their full JD in the
// adapter response, so a low-ish bar catches teaser-only edge cases without
// being too strict on naturally short postings.
const FULL_JD_MIN_CHARS = 500;

export type EvalSourceKey =
  | "adzuna"
  | "seek_direct"
  | "seek_apify"
  | "careerjet"
  | "greenhouse"
  | "lever";

export interface SourceEvalInput {
  evalId:           string;       // source_eval_runs.id — for writeback
  userId:           string;       // RLS isolation + user-scoped URL dedup
  source:           EvalSourceKey;
  keywords:         string[];
  location:         string;
  postedWithinDays: number;
}

export interface SourceEvalCounts {
  fetched:          number;
  after_url_dedup:  number;
  after_keyword:    number;
  after_smart:      number;
  after_dedup:      number;
  would_save:       number;
  full_jd:          number;
  thin_jd:          number;
}

export interface SourceEvalSample {
  title:     string;
  company:   string;
  location:  string;
  url:       string;
  url_hash:  string;
  posted_at: string | null;
  full_jd:   boolean;
  desc_len:  number;
}

export interface SourceEvalResult {
  status:      "done" | "error";
  error?:      string;
  started_at:  string;
  finished_at: string;
  timing_ms: {
    fetch:     number;
    dedup:     number;
    jd_enrich: number;
  };
  counts:      SourceEvalCounts;
  samples:     SourceEvalSample[];
  // url_hashes of all jobs that survived through after_dedup — used by the
  // start route to compute the cross-source overlap matrix.
  kept_url_hashes: string[];
  // JD enrichment specifics (SEEK + Careerjet only; 0 elsewhere).
  jd_enrich?: {
    fetched: number;
    merged:  number;
    cost_usd: number;
  };
  // Convenience: free-form note (e.g. "Apify integration missing").
  note?: string;
}

function emptyCounts(): SourceEvalCounts {
  return {
    fetched: 0,
    after_url_dedup: 0,
    after_keyword: 0,
    after_smart: 0,
    after_dedup: 0,
    would_save: 0,
    full_jd: 0,
    thin_jd: 0,
  };
}

function buildSyntheticProfile(input: SourceEvalInput): SearchProfile {
  // Synthetic profile feeds every adapter the same shape the orchestrator
  // would. id is a fresh UUID so dedup() doesn't match any real profile's
  // existing rows (we handle URL dedup against the user's full set above).
  return {
    id:                randomUUID(),
    keywords:          input.keywords,
    location:          input.location,
    visa_filter_mode:  "any",
    working_rights:    "any",
    target_verticals:  [],
    // Date-aware adapter inputs — all three set to the same window so
    // every adapter applies the same recency cutoff.
    adzuna_max_days_old: input.postedWithinDays,
    lookback_days:       input.postedWithinDays,
    is_first_run:        false,
    is_manual_run:       true,
    // Smart-filter rules left empty in ad-hoc mode → postFetchFilter is a no-op.
    exclude_title_keywords: [],
    enabled_sources:        null,
    seek_method:            input.source === "seek_apify" ? "actor" : "direct",
  };
}

async function fetchUserUrlHashes(userId: string): Promise<Set<string>> {
  // All url_hashes the user has already saved (any profile). Used to compute
  // after_url_dedup — "how many would actually be new to me."
  const { data: profiles } = await db
    .from("search_profiles")
    .select("id")
    .eq("user_id", userId);
  const profileIds = (profiles ?? []).map((p) => p.id);
  if (profileIds.length === 0) return new Set();

  const { data: rows } = await db
    .from("jobs")
    .select("url_hash")
    .in("profile_id", profileIds);
  return new Set((rows ?? []).map((r) => r.url_hash as string));
}

async function callAdapter(
  source:  EvalSourceKey,
  profile: SearchProfile,
  userId:  string,
): Promise<{ raw: RawJob[]; cost_usd: number; note?: string }> {
  switch (source) {
    case "adzuna":     return { raw: await adzunaAdapter.fetchJobs(profile),     cost_usd: 0 };
    case "careerjet":  return { raw: await careerjetAdapter.fetchJobs(profile),  cost_usd: 0 };
    case "greenhouse": return { raw: await greenhouseAdapter.fetchJobs(profile), cost_usd: 0 };
    case "lever":      return { raw: await leverAdapter.fetchJobs(profile),      cost_usd: 0 };
    case "seek_direct":return { raw: await seekDirectAdapter.fetchJobs(profile), cost_usd: 0 };
    case "seek_apify": {
      // Apify needs the user's encrypted token from user_integrations.
      const { data: integ } = await db
        .from("user_integrations")
        .select("encrypted_api_key, is_enabled, status")
        .eq("user_id", userId)
        .eq("provider", "apify")
        .maybeSingle();
      if (!integ || !integ.is_enabled || integ.status !== "valid") {
        return {
          raw: [],
          cost_usd: 0,
          note: "Apify integration missing or not valid — connect a token in Settings to test seek_apify.",
        };
      }
      const token = decryptApiKey(integ.encrypted_api_key as string);
      const adapter = createSeekAdapter(token);
      const { jobs, costUsd } = await adapter.fetchJobs(profile);
      return { raw: jobs, cost_usd: costUsd };
    }
  }
}

export async function runSourceEval(input: SourceEvalInput): Promise<SourceEvalResult> {
  const started_at = new Date().toISOString();
  const t0 = Date.now();
  const profile = buildSyntheticProfile(input);

  let raw: RawJob[] = [];
  let cost_usd = 0;
  let note: string | undefined;
  let fetchMs = 0;

  try {
    const adapterStart = Date.now();
    const result = await callAdapter(input.source, profile, input.userId);
    fetchMs = Date.now() - adapterStart;
    raw      = result.raw;
    cost_usd = result.cost_usd;
    note     = result.note;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error:  msg,
      started_at,
      finished_at: new Date().toISOString(),
      timing_ms: { fetch: Date.now() - t0, dedup: 0, jd_enrich: 0 },
      counts:  emptyCounts(),
      samples: [],
      kept_url_hashes: [],
    };
  }

  const counts = emptyCounts();
  counts.fetched = raw.length;

  // Stage 2 — URL dedup vs user's existing jobs.
  // Hash with the same canonical form dedup.ts uses.
  const existingHashes = await fetchUserUrlHashes(input.userId);
  const seenHash = new Set<string>();
  const newRaw: RawJob[] = [];
  for (const j of raw) {
    const h = createHash("sha256").update(canonicalUrl(j.url)).digest("hex");
    if (existingHashes.has(h) || seenHash.has(h)) continue;
    seenHash.add(h);
    newRaw.push(j);
  }
  counts.after_url_dedup = newRaw.length;

  // Stage 3 — normalise + keyword filter
  const normalised = newRaw.map(normalise);
  const keptByKeyword = keywordFilter(normalised, profile.keywords);
  counts.after_keyword = keptByKeyword.length;

  // Stage 4 — smart filter (no-op in ad-hoc mode; rules are empty)
  const { kept: keptBySmart } = postFetchFilter(keptByKeyword, profile);
  counts.after_smart = keptBySmart.length;

  // Stage 5 — content dedup (L1 + L2 in-batch only; existing rows for a brand
  // new synthetic profile_id are empty by construction).
  const dedupStart = Date.now();
  const { kept: keptByDedup } = await dedup(keptBySmart, profile.id);
  const dedupMs = Date.now() - dedupStart;
  counts.after_dedup = keptByDedup.length;
  counts.would_save  = keptByDedup.length;

  // Stage 6 — JD enrichment (SEEK direct & apify, Careerjet).
  // For adapters that already return the full JD inline (Adzuna/GH/Lever),
  // we just measure description length against the full-JD threshold.
  let enrichedJobs: NormalisedJob[] = keptByDedup;
  let jdMs = 0;
  let jdEnrichSummary: { fetched: number; merged: number; cost_usd: number } | undefined;

  if (keptByDedup.length > 0) {
    const jdStart = Date.now();
    try {
      if (input.source === "seek_direct") {
        const r = await enrichWithDirectJDs(keptByDedup);
        enrichedJobs    = r.jobs;
        jdEnrichSummary = { fetched: r.fetched, merged: r.merged, cost_usd: r.costUsd };
      } else if (input.source === "seek_apify") {
        // Reuse the user's token from above. Defensive re-fetch is cheap.
        const { data: integ } = await db
          .from("user_integrations")
          .select("encrypted_api_key, is_enabled, status")
          .eq("user_id", input.userId)
          .eq("provider", "apify")
          .maybeSingle();
        if (integ && integ.is_enabled && integ.status === "valid") {
          const token = decryptApiKey(integ.encrypted_api_key as string);
          const r = await enrichWithFullJDs(keptByDedup, token);
          enrichedJobs    = r.jobs;
          jdEnrichSummary = { fetched: r.fetched, merged: r.merged, cost_usd: r.costUsd };
          cost_usd += r.costUsd;
        }
      } else if (input.source === "careerjet") {
        const r = await enrichWithCareerjetJDs(keptByDedup);
        enrichedJobs    = r.jobs;
        jdEnrichSummary = { fetched: r.fetched, merged: r.merged, cost_usd: r.costUsd };
      }
    } catch (err) {
      // JD enrichment failure is non-fatal for the eval — counts are still
      // meaningful, just with thin JDs.
      const msg = err instanceof Error ? err.message : String(err);
      note = note ? `${note}; JD enrich failed: ${msg}` : `JD enrich failed: ${msg}`;
    }
    jdMs = Date.now() - jdStart;
  }

  // JD-quality classification — full if description ≥ threshold.
  for (const j of enrichedJobs) {
    if ((j.description ?? "").length >= FULL_JD_MIN_CHARS) counts.full_jd++;
    else counts.thin_jd++;
  }

  // Pick top-5 samples by description length (most informative for manual
  // verification of SEEK results).
  const samples: SourceEvalSample[] = [...enrichedJobs]
    .sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))
    .slice(0, 5)
    .map((j) => ({
      title:     j.title,
      company:   j.company,
      location:  j.location,
      url:       j.url,
      url_hash:  j.url_hash,
      posted_at: j.posted_at,
      full_jd:   (j.description ?? "").length >= FULL_JD_MIN_CHARS,
      desc_len:  (j.description ?? "").length,
    }));

  return {
    status: "done",
    started_at,
    finished_at: new Date().toISOString(),
    timing_ms: { fetch: fetchMs, dedup: dedupMs, jd_enrich: jdMs },
    counts,
    samples,
    kept_url_hashes: enrichedJobs.map((j) => j.url_hash),
    jd_enrich: jdEnrichSummary,
    note,
  };
}
