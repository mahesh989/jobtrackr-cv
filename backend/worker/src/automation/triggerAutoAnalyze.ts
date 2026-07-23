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
import { geocodeLocation, haversineKm, type LatLng } from "../lib/distance.js";
import { reserveTailoredCv, linkCvUsageEvent, releaseCvUsageEvent } from "./billing.js";

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
const AUTO_ANALYZE_MAX_KM = 30;  // auto-analyze only jobs within this distance of home; farther = manual-only

// Referees are single-sourced from the ACTIVE CV's structured_cv (the review
// form is the only referee editor — see Fix 2, docs/design.md). The profile
// store (user_preferences.contact_details.references) keeps only `mode`.
// Mirror of this splice also lives in
// frontend/web/src/app/api/jobs/[id]/analyze/route.ts (separate package, no
// shared import) — keep both in sync.
function spliceStructuredReferees(
  contactDetails: Record<string, unknown> | null,
  structuredCv: unknown,
): Record<string, unknown> | null {
  const refs = (structuredCv as { references?: unknown[] } | null)?.references;
  if (!Array.isArray(refs) || refs.length === 0) return contactDetails; // legacy fallback — leave untouched
  const existingMode = (contactDetails?.references as { mode?: string } | undefined)?.mode ?? "details";
  const referees = refs.slice(0, 3).map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      name:      typeof rec.name === "string" ? rec.name : "",
      job_title: typeof rec.job_title === "string" ? rec.job_title : "",
      company:   typeof rec.company === "string" ? rec.company : "",
      email:     typeof rec.email === "string" ? rec.email : "",
    };
  });
  return { ...(contactDetails ?? {}), references: { mode: existingMode, referees } };
}

interface ProfileThresholds {
  user_id: string;
  // Per-vertical ATS cutoffs: healthcare/nursing profiles get 40/60, everything
  // else the global 60/70. Mirrors frontend/web/src/lib/atsThresholds.ts (worker is a
  // separate package, so the small resolver is duplicated, not imported).
  target_verticals?: string[] | null;
  // Geocoded search-profile location (profile.location). Lets the distance gate
  // measure intent-distance for inter-city searches, not just distance from home.
  // null when the profile has no location or it couldn't be geocoded.
  searchOrigin?: LatLng | null;
}

const GLOBAL_THRESHOLDS = { initial: 60, final: 70 };
// Keyed by BOTH vertical identifiers. effectiveVerticals prefers the My CV
// role_family ("nursing", from contact_details.role_families) over the
// search-profile sourcing vertical ("healthcare", from target_verticals), so
// keying only "healthcare" silently fell back to 60/70 for nursing CVs (the
// "57% stopped at the 60% gate" bug). Kept in sync with web atsThresholds.ts.
const VERTICAL_THRESHOLDS: Record<string, { initial: number; final: number }> = {
  healthcare: { initial: 40, final: 60 },
  nursing:    { initial: 40, final: 60 },
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
  // ── 1. Fetch the job + check JD quality ─────────────────────────────────
  const { data: job, error: jobErr } = await db
    .from("jobs")
    .select("id, profile_id, title, company, location, source, url, description, manual_jd_text, jd_quality, distance_km, dedup_status")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr || !job) {
    console.warn(`[auto-analyze] ${jobId}: job not found — skipping`);
    return null;
  }

  // Cross-source weak duplicate (same title + company, different city — kept in
  // the feed with a Hide pill, see dedup.ts L2-weak). Auto-analyzing it would
  // spawn a second analysis_run and burn a CV credit for what is almost
  // certainly the same role. Skip here so only ONE of the pair auto-analyzes;
  // the user can still hit manual Analyze on the flagged twin if they want it.
  if ((job as { dedup_status?: string | null }).dedup_status === "possible_duplicate") {
    console.log(`[auto-analyze] ${jobId}: skipped (possible_duplicate — manual analysis still available)`);
    return null;
  }

  // Distance gate (auto-mode only). Auto-analyze a job when it is within
  // AUTO_ANALYZE_MAX_KM of EITHER home (distance_km, driving distance) OR the
  // SEARCH profile's location (straight-line). A deliberate inter-city search —
  // home far from the searched city — still auto-analyzes jobs near the search
  // location, because the user clearly intended to look there. This saves AI
  // spend on genuinely out-of-range jobs (far from both home and the search
  // centre) while honouring the search's geographic intent.
  //
  // `distance_km` is from home (null if no home address / un-geocoded).
  // searchKm is derived from the job's location string against the geocoded
  // search origin (cached within the run). When BOTH are null there is no
  // geographic signal at all → skip (manual Analyze still works).
  const homeKm = (job as { distance_km: number | null }).distance_km;
  let searchKm: number | null = null;
  if (profile.searchOrigin && job.location) {
    const hit = await geocodeLocation(job.location); // cached — warmed by serve
    if (hit) searchKm = haversineKm(profile.searchOrigin, hit);
  }
  const dists = [homeKm, searchKm].filter((d): d is number => d != null);
  const nearestKm = dists.length ? Math.min(...dists) : null;
  if (nearestKm == null || nearestKm > AUTO_ANALYZE_MAX_KM) {
    const why = nearestKm == null
      ? "no home/search distance (un-geocoded)"
      : `nearest ${nearestKm.toFixed(1)}km > ${AUTO_ANALYZE_MAX_KM}km `
        + `(home ${homeKm ?? "n/a"}, search ${searchKm?.toFixed(1) ?? "n/a"})`;
    console.log(`[auto-analyze] ${jobId}: skipped (${why} — manual analysis still available)`);
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
  // Option A: prefer the canonical normalized_cv_text (clean ### Employer |
  // Location skeleton) over raw cv_text — same source-of-truth the manual route
  // uses. Raw cv_text's plain-text layout mis-parses into phantom roles
  // (Moran vs Uniting incident 2026-06-26), so auto must match manual here.
  const [{ data: cv }, creds] = await Promise.all([
    db.from("cv_versions")
      .select("id, cv_text, normalized_cv_text, structured_cv, structured_cv_status")
      .eq("user_id", profile.user_id).eq("is_active", true).maybeSingle(),
    getPlatformAiCredentials(),
  ]);

  // structured_cv is the source of truth; normalized_cv_text is a rendered cache
  // that can drift stale/empty (composer then fabricates Experience/Education —
  // Moran "[Institution Name]" incident). When a parsed structured_cv exists,
  // re-render from it and self-heal the cache; any failure falls back to the
  // stored cache, then raw cv_text. Mirrors the manual analyze route.
  let normalizedText = cv?.normalized_cv_text ?? null;
  const structured = (cv as { structured_cv?: unknown } | null)?.structured_cv;
  const hasParsedStructured =
    (cv?.structured_cv_status === "parsed" || cv?.structured_cv_status === "verified") &&
    structured !== null && typeof structured === "object" &&
    Array.isArray((structured as { experience?: unknown }).experience);
  if (cv && hasParsedStructured) {
    try {
      const rendered = await callCvBackend<{ normalized_cv_text: string }>(
        "/internal/render-canonical-cv",
        { structured_cv: structured },
      );
      const fresh = (rendered.normalized_cv_text ?? "").trim();
      if (fresh.length >= 50) {
        if (fresh !== (normalizedText ?? "").trim()) {
          await db.from("cv_versions").update({ normalized_cv_text: fresh }).eq("id", cv.id);
        }
        normalizedText = fresh;
      }
    } catch (err) {
      console.warn(`[auto-analyze] ${jobId}: canonical re-render failed, using stored CV text — ${String(err)}`);
    }
  }

  const cvTextForAnalysis =
    normalizedText && normalizedText.trim().length >= 50
      ? normalizedText
      : (cv?.cv_text ?? "");
  if (!cv || cvTextForAnalysis.trim().length < 50) {
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

  // Role vertical = the user's ONE global choice from My CV
  // (contact_details.role_families, "applies to all CVs"). Authoritative for
  // role-family routing AND ATS thresholds. The per-search-profile
  // target_verticals is a legacy fallback only. Loaded here (after the cheap
  // skip-checks) so skipped jobs don't pay for the query.
  const { data: prefRow } = await db
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", profile.user_id)
    .maybeSingle();
  const myCvFamilies = (
    (prefRow?.contact_details as { role_families?: string[] | null } | null)?.role_families ?? []
  ).filter(Boolean);
  const effectiveVerticals = myCvFamilies.length > 0 ? myCvFamilies : (profile.target_verticals ?? []);
  const th = resolveThresholds(effectiveVerticals);

  // ── 3b. Billing choke point — reserve a tailored-CV credit ───────────────
  // Auto-analyze produces a tailored CV, so it must count against the user's CV
  // quota exactly like the manual Analyze button (mirrors consumeTailoredCv).
  // Over cap / read-only → skip this job silently (no run, no AI spend). The
  // pending reservation is linked to the run below and committed/voided by the
  // analysis_runs status trigger.
  const cvGate = await reserveTailoredCv(profile.user_id, jobId);
  if (!cvGate.allowed) {
    console.log(`[auto-analyze] ${jobId}: skipped (CV quota: ${cvGate.reason ?? "denied"})`);
    return null;
  }
  const usageEventId = cvGate.eventId;

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
    // No run row → free the reservation (the status trigger can't void it).
    if (usageEventId) await releaseCvUsageEvent(usageEventId);
    return null;
  }

  // Link the reservation to the run so the analysis_runs status trigger commits
  // it on 'completed' / voids it on 'failed' (same as the manual route).
  if (usageEventId) await linkCvUsageEvent(usageEventId, newRun.id);

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
      cv_text:           cvTextForAnalysis,
      ai_provider:       chosen,
      ai_api_key:        aiApiKey,
      ai_model:          aiModel,
      // Stamp contact line + Registration & Licences + Availability from the
      // user's profile, same as the manual route. cv-backend uses
      // payload.contact_details ONLY (no DB fallback) — passing null here left
      // auto-analyzed CVs with no contact line, credentials, or availability.
      // Reuses prefRow loaded above for the vertical. Referees are spliced in
      // from the active CV's structured_cv (single source of truth — Fix 2).
      contact_details:   spliceStructuredReferees(
        (prefRow?.contact_details as Record<string, unknown> | null) ?? null,
        (cv as { structured_cv?: unknown } | null)?.structured_cv,
      ),
      // Explicit role vertical from My CV — drives the role-family pack so
      // auto-analyze matches the user's selection instead of JD auto-detection.
      target_vertical:   effectiveVerticals[0] ?? null,
      // Per-vertical ATS cutoffs: healthcare/nursing = 40/60, else 60/70.
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

