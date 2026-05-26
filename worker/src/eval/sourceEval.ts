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

// JD-quality threshold. 2000 chars demands a real job description, not a
// teaser. SEEK/Careerjet enrichment fetches ~3-5k char bodies; Adzuna teasers
// run ~200-1500 chars; Greenhouse/Lever return full JDs inline (~1.5-8k).
const FULL_JD_MIN_CHARS = 2000;

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
  // Adzuna-specific radius (km). Only Adzuna's API uses this; SEEK/Careerjet
  // don't take a radius param. Default 50 — the Adzuna API's own default of
  // ~5 km is the single biggest recall killer for greater-Sydney searches.
  distanceKm?:      number;
  // Optional must-include filter applied locally after fetch. Empty = no
  // filter (trust the source's own server-side matching). When set, a job
  // passes if title+description contains ANY of these phrases. Used to
  // drop noise that survives a broad search like SEEK ranking a truck-driver
  // role for the keyword "Care Worker".
  mustInclude?:     string[];
}

// AU state aliases — used by `normaliseEvalLocation` to strip state suffixes
// so all adapters receive the same bare city. Adzuna's split-on-first-token
// already strips these for its API, but SEEK and Careerjet pass the raw input
// downstream where ", NSW 2000"-style strings hurt recall.
const AU_STATE_RE = new RegExp(
  "[,\\s]+(" + [
    "NSW", "VIC", "QLD", "WA", "SA", "TAS", "NT", "ACT",
    "New South Wales", "Victoria", "Queensland", "Western Australia",
    "South Australia", "Tasmania", "Northern Territory",
    "Australian Capital Territory",
  ].join("|") + ")\\b",
  "i",
);
const AU_POSTCODE_RE = /[,\s]+\d{4}\b/;
const AUSTRALIA_SUFFIX_RE = /[,\s]+australia\s*$/i;

/**
 * Normalise a user-typed location into the bare-city form every adapter
 * handles best. Strips trailing ", Australia", postcodes (4 digits), and
 * state codes/names. "Sydney NSW 2000" → "Sydney". "North Sydney, NSW" →
 * "North Sydney". Multi-word city names are preserved.
 */
export function normaliseEvalLocation(input: string): string {
  let loc = input.trim();
  // Strip trailing " Australia" repeatedly (in case the user wrote it twice).
  while (AUSTRALIA_SUFFIX_RE.test(loc)) loc = loc.replace(AUSTRALIA_SUFFIX_RE, "").trim();
  loc = loc.replace(AU_POSTCODE_RE, "").trim();
  loc = loc.replace(AU_STATE_RE, "").trim();
  // Trailing comma cleanup
  loc = loc.replace(/[,\s]+$/, "").trim();
  return loc;
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
  // For sources whose API reports a global match count (Adzuna's `count`),
  // surface it on the card so the user can see "API thinks N match, we
  // fetched M" — closes the loop on why Adzuna often returns fewer than the
  // website (API does strict AND across `what` words; website is fuzzier).
  api_reported_count?: number;
  // Convenience: free-form note (e.g. "Apify integration missing").
  note?: string;
  // Per-source diagnostics for the beta UI — env vars present, integration
  // state, captured console output. Lets you see WHY a source returned 0.
  diagnostics?: {
    env:         Record<string, boolean>;   // e.g. { ADZUNA_APP_ID: true }
    integration?: {
      provider:    string;
      present:     boolean;
      is_enabled?: boolean;
      status?:     string;
      reason?:     string;                   // why integration was rejected (if rejected)
    };
    logs: string[];                          // console.log/warn/error captured during fetch
  };
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
  //
  // Coverage mode: we run every adapter in their "first run" deep configuration
  // because a beta test wants the biggest haystack, not an incremental top-up.
  //   - Adzuna  → 10 pages (500/keyword)  vs the 4-page incremental default
  //   - Careerjet → 6 pages (300/keyword) vs the 4-page incremental default
  //   - SEEK direct → no change (always 9 pages)
  return {
    id:                randomUUID(),
    keywords:          input.keywords,
    location:          normaliseEvalLocation(input.location),
    visa_filter_mode:  "any",
    working_rights:    "any",
    target_verticals:  [],
    // Date-aware adapter inputs — all three set to the same window so
    // every adapter applies the same recency cutoff.
    adzuna_max_days_old: input.postedWithinDays,
    lookback_days:       input.postedWithinDays,
    is_first_run:        true,
    is_manual_run:       true,
    // Adzuna radius. Default 50 km — Adzuna's own default is ~5 km, which is
    // why bare-city searches return only postings inside the CBD.
    adzuna_distance_km:  input.distanceKm ?? 50,
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

// Env vars each adapter reads. Surfaced in diagnostics so a missing key
// shows up directly in the UI instead of as a generic "0 results".
const SOURCE_ENV_VARS: Record<EvalSourceKey, string[]> = {
  adzuna:      ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
  careerjet:   ["CAREERJET_API_KEY"],
  greenhouse:  [],
  lever:       [],
  seek_direct: [],
  seek_apify:  [],
};

function checkEnv(source: EvalSourceKey): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const k of SOURCE_ENV_VARS[source]) {
    result[k] = !!process.env[k];
  }
  return result;
}

interface IntegrationDiag {
  provider:    string;
  present:     boolean;
  is_enabled?: boolean;
  status?:     string;
  reason?:     string;
}

async function loadApifyIntegrationForEval(userId: string): Promise<{
  token: string | null;
  diag:  IntegrationDiag;
}> {
  const { data: integ } = await db
    .from("user_integrations")
    .select("encrypted_api_key, is_enabled, status, status_reason")
    .eq("user_id", userId)
    .eq("provider", "apify")
    .maybeSingle();

  if (!integ) {
    return {
      token: null,
      diag: { provider: "apify", present: false, reason: "No Apify integration row found — connect a token in Settings." },
    };
  }
  if (!integ.is_enabled) {
    return {
      token: null,
      diag: {
        provider: "apify", present: true, is_enabled: false, status: integ.status as string,
        reason: "Apify integration is disabled — toggle it on in Settings.",
      },
    };
  }
  if (integ.status !== "valid") {
    return {
      token: null,
      diag: {
        provider: "apify", present: true, is_enabled: true, status: integ.status as string,
        reason: `Integration status is "${integ.status}"${integ.status_reason ? ` — ${integ.status_reason}` : ""}.`,
      },
    };
  }
  const token = decryptApiKey(integ.encrypted_api_key as string);
  return {
    token,
    diag: { provider: "apify", present: true, is_enabled: true, status: "valid" },
  };
}

interface AdapterCallResult {
  raw:         RawJob[];
  cost_usd:    number;
  note?:       string;
  integration?: IntegrationDiag;
}

async function callAdapter(
  source:  EvalSourceKey,
  profile: SearchProfile,
  userId:  string,
): Promise<AdapterCallResult> {
  switch (source) {
    case "adzuna":     return { raw: await adzunaAdapter.fetchJobs(profile),     cost_usd: 0 };
    case "careerjet":  return { raw: await careerjetAdapter.fetchJobs(profile),  cost_usd: 0 };
    case "greenhouse": return { raw: await greenhouseAdapter.fetchJobs(profile), cost_usd: 0 };
    case "lever":      return { raw: await leverAdapter.fetchJobs(profile),      cost_usd: 0 };
    case "seek_direct":return { raw: await seekDirectAdapter.fetchJobs(profile), cost_usd: 0 };
    case "seek_apify": {
      const { token, diag } = await loadApifyIntegrationForEval(userId);
      if (!token) {
        return { raw: [], cost_usd: 0, note: diag.reason, integration: diag };
      }
      console.log(`[source-eval] seek_apify — calling actor with token (length=${token.length})`);
      const adapter = createSeekAdapter(token);
      const { jobs, costUsd } = await adapter.fetchJobs(profile);
      return { raw: jobs, cost_usd: costUsd, integration: diag };
    }
  }
}

// Capture console.log/warn/error from inside the adapter call so the UI can
// surface them. We patch globally for the duration of the call — safe inside
// a single bullmq job (concurrency 3 → up to 3 captures interleaved, but each
// log line carries its own job's id from the worker's logger, so we just
// collect everything during this call window and let cross-contamination be
// extremely rare in practice).
function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const originalLog   = console.log;
  const originalWarn  = console.warn;
  const originalError = console.error;
  const push = (level: string, args: unknown[]) => {
    const line = `[${level}] ` + args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    if (logs.length < 200) logs.push(line);
  };
  console.log   = (...args: unknown[]) => { push("log",   args); originalLog(...args); };
  console.warn  = (...args: unknown[]) => { push("warn",  args); originalWarn(...args); };
  console.error = (...args: unknown[]) => { push("error", args); originalError(...args); };
  return fn()
    .then((value) => ({ value, logs }))
    .finally(() => {
      console.log   = originalLog;
      console.warn  = originalWarn;
      console.error = originalError;
    });
}

export async function runSourceEval(input: SourceEvalInput): Promise<SourceEvalResult> {
  const started_at = new Date().toISOString();
  const t0 = Date.now();
  const profile = buildSyntheticProfile(input);

  let raw: RawJob[] = [];
  let cost_usd = 0;
  let note: string | undefined;
  let fetchMs = 0;
  let fetchLogs: string[] = [];
  let integration: IntegrationDiag | undefined;
  const envCheck = checkEnv(input.source);

  try {
    const adapterStart = Date.now();
    const { value: result, logs } = await withCapturedLogs(() =>
      callAdapter(input.source, profile, input.userId)
    );
    fetchMs   = Date.now() - adapterStart;
    raw       = result.raw;
    cost_usd  = result.cost_usd;
    note      = result.note;
    fetchLogs = logs;
    integration = result.integration;
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
      diagnostics: { env: envCheck, integration, logs: [] },
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

  // Stage 3 — normalise + smart filter (always applied)
  //
  // Two-stage matching:
  //   - The user's `keywords` drive what each source SEARCHES for.
  //   - The user's `mustInclude` (optional) is a LOCAL post-fetch filter that
  //     drops noise that slipped through the source's broad search. Jobs pass
  //     if their title+description contains ANY of the mustInclude phrases.
  //
  // If mustInclude is empty we default to filtering by the search `keywords`
  // themselves — same word-boundary matching, just no extra typing. This
  // catches false positives like Adzuna's fuzzy relevance returning a truck-
  // driver posting for `AIN` (the JD has "Maintaining" / "aine@..." but no
  // standalone "ain" — \bain\b correctly drops it).
  //
  // For broader recall, fill the smart filter with variants:
  //   keyword: AIN
  //   smart filter: AIN, Assistant in Nursing, PCA, Care Worker, Care Provider
  const normalised = newRaw.map(normalise);
  const mustIncludeRaw = (input.mustInclude ?? []).filter((s) => s.trim().length > 0);
  const filterPhrases = mustIncludeRaw.length > 0 ? mustIncludeRaw : profile.keywords;
  const keptByKeyword = keywordFilter(normalised, filterPhrases);
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

  // Eval JD-enrichment cap. Production caps every JD enricher at 20 because a
  // real pipeline run has ~10-30 survivors, but the eval can produce 200+ and
  // we want to see actual JD coverage, not a 20-job slice. Beta tool only.
  const EVAL_JD_CAP = 200;

  if (keptByDedup.length > 0) {
    const jdStart = Date.now();
    try {
      if (input.source === "seek_direct") {
        const r = await enrichWithDirectJDs(keptByDedup, EVAL_JD_CAP);
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
          const r = await enrichWithFullJDs(keptByDedup, token, EVAL_JD_CAP);
          enrichedJobs    = r.jobs;
          jdEnrichSummary = { fetched: r.fetched, merged: r.merged, cost_usd: r.costUsd };
          cost_usd += r.costUsd;
        }
      } else if (input.source === "careerjet") {
        const r = await enrichWithCareerjetJDs(keptByDedup, EVAL_JD_CAP);
        enrichedJobs    = r.jobs;
        jdEnrichSummary = { fetched: r.fetched, merged: r.merged, cost_usd: r.costUsd };
        // The enricher returns fetched=0 when all URLs resolved to employer
        // sites (Canva/Arcadis/Okta etc.) — its hostname check rejects them.
        // Surface that explicitly so "Full JD: 0" doesn't look like a bug.
        if (r.fetched === 0 && keptByDedup.length > 0) {
          note = note
            ? `${note}; JD enrichment skipped — Careerjet's tracking URLs resolved to employer sites (not careerjet.com.au), and the enricher only fetches from careerjet.com.au.`
            : `JD enrichment skipped — Careerjet's tracking URLs resolved to employer sites (not careerjet.com.au), and the enricher only fetches from careerjet.com.au. Description is the API teaser (~200-300 chars).`;
        }
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

  // Pull the Adzuna API's reported total `count` out of the captured logs and
  // attach it as a structured field. Lets the UI show "API says N match, we
  // fetched M" without the user having to expand Diagnostics → Logs.
  let apiReportedCount: number | undefined;
  if (input.source === "adzuna") {
    for (const line of fetchLogs) {
      const m = line.match(/api reports total count=(\d+)/);
      if (m) { apiReportedCount = Number(m[1]); break; }
    }
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
    api_reported_count: apiReportedCount,
    note,
    diagnostics: { env: envCheck, integration, logs: fetchLogs },
  };
}
