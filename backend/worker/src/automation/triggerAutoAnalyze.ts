/**
 * Phase E-1 — Auto-analyze a single job from a worker pipeline run.
 *
 * Mirrors the user-facing /api/jobs/[id]/analyze route logic but runs
 * server-side from the worker, marks the resulting analysis_run row
 * with automation=true, and silently respects the Phase B/C gates:
 *
 *   - Thin-JD (jd_quality='thin') AND no manual_jd_text  → skip, no AI call
 *   - Description too short to be useful                   → skip
 *   - No active CV for the user                            → skip + log
 *   - No valid AI key                                      → skip + log
 *   - cv-backend orchestrator handles the initial-ATS gate internally
 *     (Phase C-3 — stops before tailoring on low-match jobs)
 *
 * Cover-letter generation is intentionally NOT auto-triggered here.
 * That's deferred to Phase E-2 — keeps the user-verification step in
 * the loop per the product principle "user must verify before send".
 *
 * Error policy: any failure here is LOGGED and SKIPPED — the scrape
 * pipeline continues for other jobs. Auto-analyze is best-effort, not
 * a blocker for the user's data flow.
 */

import { db } from "../db/client.js";
import { decryptApiKey } from "../lib/crypto.js";
import { callCvBackend, CvBackendError } from "../lib/cvBackendHmac.js";

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

/**
 * Resolve the platform-wide AI provider/key/model (platform_ai_settings,
 * migration 060) — the post-BYOK model. Mirrors the web layer's
 * getActiveAiCredentials() so auto-analyze uses the SAME platform key as the
 * manual "Analyze" button. Returns null when no active+valid provider is set.
 */
async function getPlatformAiCredentials(): Promise<{ provider: Provider; apiKey: string; model: string | null } | null> {
  const { data } = await db
    .from("platform_ai_settings")
    .select("provider, encrypted_api_key, model, status")
    .eq("is_active", true)
    .maybeSingle();
  if (!data?.encrypted_api_key || data.status !== "valid") return null;
  try {
    return {
      provider: data.provider as Provider,
      apiKey:   decryptApiKey(data.encrypted_api_key as string),
      model:    (data.model as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

const JD_MIN_USABLE = 1000;  // chars — below this, JD is too thin for reliable AI analysis. Aligned to MANUAL_JD_MIN_CHARS + jd_quality classifier (migration 062). Was 1400, was 2000.
const JD_RICH_MIN   = 600;   // chars — matches Migration 032 jd_quality='rich' threshold

interface ProfileThresholds {
  user_id: string;
  // Per-vertical ATS cutoffs: healthcare/nursing profiles get 55/65, everything
  // else the global 60/70. Mirrors frontend/web/src/lib/atsThresholds.ts (worker is a
  // separate package, so the small resolver is duplicated, not imported).
  target_verticals?: string[] | null;
}

const GLOBAL_THRESHOLDS = { initial: 60, final: 70 };
const VERTICAL_THRESHOLDS: Record<string, { initial: number; final: number }> = {
  healthcare: { initial: 55, final: 65 },
};

function resolveThresholds(verticals?: string[] | null): { initial: number; final: number } {
  for (const v of verticals ?? []) {
    const hit = VERTICAL_THRESHOLDS[v];
    if (hit) return hit;
  }
  return GLOBAL_THRESHOLDS;
}

/**
 * Try to auto-analyze one job. Returns the analysis_run row id on success,
 * or null on any skip/error condition (always logged).
 */
export async function triggerAutoAnalyze(
  jobId:   string,
  profile: ProfileThresholds,
): Promise<string | null> {
  const th = resolveThresholds(profile.target_verticals);

  // ── 1. Fetch the job + check JD quality ─────────────────────────────────
  const { data: job, error: jobErr } = await db
    .from("jobs")
    .select("id, profile_id, title, company, location, source, url, description, manual_jd_text, jd_quality")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr || !job) {
    console.warn(`[auto-analyze] ${jobId}: job not found — skipping`);
    return null;
  }

  const manualJd    = (job.manual_jd_text ?? "").trim();
  const description = (job.description ?? "").trim();
  const hasManualJd = manualJd.length >= JD_MIN_USABLE;

  // Phase C-3 thin-JD pre-check — saves 4-5 AI calls per stub listing
  if ((job.jd_quality === "thin" || description.length < JD_MIN_USABLE) && !hasManualJd) {
    console.log(`[auto-analyze] ${jobId}: skipped (thin JD, no manual paste)`);
    return null;
  }

  // Use the richest JD we have. Skip cv-backend scrape calls in auto-mode
  // to avoid spending another HTTP call — the manual /analyze route does
  // that fallback for users, but auto-mode is best-effort.
  const jdText = hasManualJd ? manualJd : description;
  if (jdText.length < JD_MIN_USABLE) {
    console.log(`[auto-analyze] ${jobId}: skipped (JD < ${JD_MIN_USABLE} chars)`);
    return null;
  }

  // ── 2. Skip if a non-stale analysis_run already exists ───────────────────
  // Auto-analyze fires on EVERY scrape success — without this guard, a
  // re-run would create duplicate analysis_runs for jobs that were already
  // analyzed (auto or manual) since the last scrape.
  const { data: existingRun } = await db
    .from("analysis_runs")
    .select("id")
    .eq("user_id", profile.user_id)
    .eq("job_id", jobId)
    .eq("is_stale", false)
    .limit(1)
    .maybeSingle();

  if (existingRun) {
    console.log(`[auto-analyze] ${jobId}: skipped (non-stale run ${existingRun.id} already exists)`);
    return null;
  }

  // ── 3. Resolve active CV + PLATFORM AI key (post-BYOK; service-role DB) ────
  const [{ data: cv }, creds] = await Promise.all([
    db.from("cv_versions").select("id, cv_text")
      .eq("user_id", profile.user_id).eq("is_active", true).maybeSingle(),
    getPlatformAiCredentials(),
  ]);

  if (!cv?.cv_text || cv.cv_text.trim().length < 50) {
    console.warn(`[auto-analyze] ${jobId}: user ${profile.user_id} has no usable active CV — skipping`);
    return null;
  }

  // Platform provider must be configured by an admin (mirrors the web route's
  // "No AI provider configured" guard). BYOK is gone — no per-user key lookup.
  if (!creds) {
    console.warn(`[auto-analyze] ${jobId}: no active platform AI provider configured — skipping`);
    return null;
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;
  const aiModel  = creds.model;

  // ── 4. Mark prior stale-flagged-false runs as stale (defensive — should be
  // covered by step 2's idempotency check, but matches the web route's pattern) ─
  await db
    .from("analysis_runs")
    .update({ is_stale: true })
    .eq("user_id", profile.user_id)
    .eq("job_id", jobId)
    .eq("is_stale", false);

  // ── 5. Insert the new run row ────────────────────────────────────────────
  const { data: newRun, error: insertErr } = await db
    .from("analysis_runs")
    .insert({
      user_id:       profile.user_id,
      job_id:        jobId,
      cv_version_id: cv.id,
      jd_text:       jdText,
      status:        "pending",
      ai_provider:   chosen,
      ai_model:      aiModel,
      // `automation: true` is also set by cv-backend's orchestrator at
      // run-start (so it's recorded even when the user hits the manual
      // override path later via re-run). Setting it here too is belt-and-
      // braces for cases where cv-backend fails to start.
      automation:    true,
    })
    .select("id")
    .single();

  if (insertErr || !newRun) {
    console.error(`[auto-analyze] ${jobId}: failed to insert run row — ${insertErr?.message}`);
    return null;
  }

  // ── 6. Fire cv-backend /internal/analyze (HMAC + automation flag) ───────
  // Payload mirrors what the web layer sends, plus automation:true so the
  // orchestrator can branch (Phase E-2 will use this to chain cover-letter
  // generation; for now it's purely informational + recorded on the row).
  try {
    await callCvBackend("/internal/analyze", {
      run_id:            newRun.id,
      user_id:           profile.user_id,
      cv_version_id:     cv.id,
      jd_text:           jdText,
      jd_source_url:     job.url,
      jd_meta:           {
        title:    job.title,
        company:  job.company,
        location: job.location,
        source:   job.source,
      },
      cv_text:           cv.cv_text,
      ai_provider:       chosen,
      ai_api_key:        aiApiKey,
      ai_model:          aiModel,
      contact_details:   null,
      // Per-vertical ATS cutoffs: healthcare/nursing = 55/65, else 60/70.
      // cv-backend already honours these payload params — no pipeline change.
      min_initial_ats:   th.initial,
      min_final_ats:     th.final,
      skip_initial_gate: false,
      automation:        true,
    });
  } catch (err) {
    console.error(
      `[auto-analyze] ${jobId}: cv-backend rejected:`,
      err instanceof CvBackendError ? `${err.status}: ${JSON.stringify(err.detail)}` : String(err),
    );
    // Mark the run failed so the user doesn't see a forever-pending row.
    await db
      .from("analysis_runs")
      .update({
        status:        "failed",
        error_message: err instanceof CvBackendError
          ? `auto-analyze: cv-backend ${err.status}`
          : "auto-analyze: cv-backend unreachable",
      })
      .eq("id", newRun.id);
    return null;
  }

  return newRun.id as string;
}

/**
 * Auto-analyze a batch of jobs sequentially (one-at-a-time) so we don't
 * burst hit cv-backend / the AI provider. Auto-analyze is fire-and-
 * forget at the cv-backend side (returns 202 immediately) so this is
 * mostly bounded by the JS-side DB queries — ~500ms per job typical.
 *
 * Returns the count of successfully kicked-off runs (NOT the count of
 * pipeline completions — those happen async on cv-backend).
 */
export async function autoAnalyzeBatch(
  jobIds:  string[],
  profile: ProfileThresholds,
): Promise<{ triggered: number; skipped: number }> {
  if (jobIds.length === 0) return { triggered: 0, skipped: 0 };

  console.log(`[auto-analyze] ${profile.user_id}: starting batch of ${jobIds.length} jobs`);
  let triggered = 0;
  let skipped   = 0;
  for (const jobId of jobIds) {
    const runId = await triggerAutoAnalyze(jobId, profile);
    if (runId) triggered++;
    else       skipped++;
  }
  console.log(`[auto-analyze] ${profile.user_id}: done — triggered ${triggered}, skipped ${skipped}`);
  return { triggered, skipped };
}

// JD_RICH_MIN is exported for tests / future tuning (referenced indirectly
// via jd_quality column populated by Migration 032).
export const _JD_RICH_MIN_FOR_TESTS = JD_RICH_MIN;
