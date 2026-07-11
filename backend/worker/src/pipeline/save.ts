// Stage 12 — Idempotent upsert into Supabase
// Conflict on (profile_id, url_hash) → update mutable fields only
import { db } from "../db/client.js";
import type { NormalisedJob } from "./types.js";
import { checkExpiry } from "./expiry.js";
import { bestApplicationEmail } from "../ai/jdFacts.js";

export interface SaveResult {
  saved: number;
  errors: number;
  bySource: Record<string, number>;
  /** Phase E-1 — IDs of the upserted rows (both new + re-touched).
   *  The worker's auto-analyze step filters this list to only
   *  newly-discovered jobs (no prior analysis_run) before queuing. */
  savedIds: string[];
}

// Columns added by migration 080. Stripped and retried when the upsert fails
// with "column not found" so the pipeline keeps saving before the migration
// is applied (graceful-degradation convention, same as 079).
const M080_COLUMNS = [
  "employment_types",
  "employment_source",
  "work_rights_requirement",
  "extracted_emails",
  "salary_period",
  "closing_date",
  "shift_patterns",
  "is_agency",
] as const;

function isMissingColumnError(message: string): boolean {
  return /column|PGRST204/i.test(message) && /find|exist|schema/i.test(message);
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
      setting_category: job.setting_category,
      setting_confidence: job.setting_confidence,
      setting_evidence: job.setting_evidence,
      distance_km: job.distance_km,
      distance_method: job.distance_method,
      // JD facts (migration 080) — stripped on retry pre-migration.
      employment_types: job.employment_types,
      employment_source: job.employment_source,
      work_rights_requirement: job.work_rights_requirement,
      extracted_emails: job.extracted_emails,
      salary_period: job.salary_period,
      closing_date: job.closing_date,
      shift_patterns: job.shift_patterns,
      is_agency: job.is_agency,
    };
  });

  // Upsert in batches of 100 to avoid payload size limits
  const BATCH = 100;
  let saved = 0;
  let errors = 0;
  const savedIds: string[] = [];
  let m080Available = true;

  for (let i = 0; i < rows.length; i += BATCH) {
    let batch: Array<Record<string, unknown>> = rows.slice(i, i + BATCH);
    if (!m080Available) batch = batch.map(stripM080);

    let { error, count, data } = await db
      .from("jobs")
      .upsert(batch, {
        onConflict: "profile_id,url_hash",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error && m080Available && isMissingColumnError(error.message)) {
      console.warn(`[save] migration 080 columns missing (${error.message}) — retrying without them`);
      m080Available = false;
      batch = batch.map(stripM080);
      ({ error, count, data } = await db
        .from("jobs")
        .upsert(batch, { onConflict: "profile_id,url_hash", ignoreDuplicates: false })
        .select("id"));
    }

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

  // contact_email autofill — best-effort second pass. contact_email is the
  // user-editable/automation address (015/031): the upsert above must never
  // touch it, so a manual value can't be clobbered by a re-scrape. Instead,
  // fill it ONLY where it's still null, from a high-confidence
  // application-kind extracted email. The .is() guard makes this write-once.
  const withEmail = jobs
    .map((j) => ({ url_hash: j.url_hash, email: bestApplicationEmail(j.extracted_emails ?? []) }))
    .filter((e): e is { url_hash: string; email: string } => e.email !== null);
  if (withEmail.length > 0) {
    let filled = 0;
    for (const e of withEmail) {
      const { error: uErr, count: uCount } = await db
        .from("jobs")
        .update({ contact_email: e.email }, { count: "exact" })
        .eq("profile_id", profileId)
        .eq("url_hash", e.url_hash)
        .is("contact_email", null);
      if (!uErr) filled += uCount ?? 0;
    }
    if (filled > 0) console.log(`[save] contact_email autofilled on ${filled} job(s) from JD application emails`);
  }

  return { saved, errors, bySource, savedIds };
}

function stripM080(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const c of M080_COLUMNS) delete out[c];
  return out;
}
