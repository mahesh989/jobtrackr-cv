/**
 * POST /api/jobs/[id]/analyze
 *
 * Trigger a CV-tailoring analysis for a specific job. End-to-end:
 *
 *   1. Verify the user owns the job and has an active CV + at least one AI key.
 *   2. Resolve the JD text:
 *        - If job.description >= 1000 chars   → use as-is
 *        - Otherwise                          → call cv-backend /internal/scrape-jd
 *      If both attempts yield < 200 chars     → 422 with a clear error.
 *   3. Mark any prior non-stale analysis_runs for (user, job) as stale.
 *   4. INSERT a new analysis_runs row (status=pending).
 *   5. Decrypt the user's AI key in memory (server-side only).
 *   6. POST signed request to cv-backend /internal/analyze.
 *   7. Return { run_id } so the browser can navigate to the live view.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { startAnalysis, scrapeJd, CvBackendError, renderCanonicalCv } from "@/lib/cv/backend";
import type { StructuredCv } from "@/lib/cv/backend";
import { rateLimit, RATE_LIMIT_MESSAGE }            from "@/lib/rateLimit";
import { consumeTailoredCv, linkUsageEvent, releaseUsageEvent } from "@/lib/billing/entitlements";
import { resolveThresholds } from "@/lib/atsThresholds";
import { MANUAL_JD_MIN_CHARS } from "@/features/jobs/lib/jobFilters";
import { emitEvent } from "@/lib/admin/events";

// Pipeline calls AI multiple times; keep some headroom for the BackgroundTask
// scheduling on cv-backend (the actual long-running work is on Fly, not here).
export const runtime     = "nodejs";
export const maxDuration = 30;

const JD_FULL_THRESHOLD  = 1000;   // chars — below this we try a fresh scrape. Aligned to MANUAL_JD_MIN_CHARS + jd_quality classifier (migration 062). Was 1400, was 2000.
const JD_MIN_USABLE      = 200;    // chars — below this we fail the run

// Referees are single-sourced from the ACTIVE CV's structured_cv (the review
// form is the only referee editor — see Fix 2, docs/design.md). The profile
// store (user_preferences.contact_details.references) keeps only `mode`.
// Mirror of this splice also lives in
// backend/worker/src/automation/triggerAutoAnalyze.ts (separate package, no
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params;

  // ── Phase C-3 override flag ─────────────────────────────────────────────
  // ?override=thin_jd       — bypass the thin-JD pre-check (run anyway
  //                            even when description is too short)
  // ?override=initial_gate  — pass skip_initial_gate=true to cv-backend,
  //                            forcing tailoring even on low initial ATS
  // ?override=all           — both
  const overrideRaw = req.nextUrl.searchParams.get("override");
  const override = overrideRaw === "thin_jd" || overrideRaw === "initial_gate" || overrideRaw === "all"
    ? overrideRaw
    : null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: each analysis triggers a multi-call AI pipeline (BYOK) + scrape.
  const rl = await rateLimit(`analyze:${user.id}`, 20, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const admin = createAdminClient();

  // ── 1a. Verify the job belongs to a profile owned by this user ───────────
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, location, source, url, description, manual_jd_text, jd_quality")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // ── Phase C-3 thin-JD pre-check (zero AI cost) ───────────────────────────
  // Block analysis at the API layer when the JD is too thin AND the user
  // hasn't manually pasted one. Saves the full 4-5-call pipeline on stub
  // listings. Override via ?override=thin_jd or ?override=all when the
  // user wants to attempt analysis anyway.
  const hasManualJd = !!(job.manual_jd_text && (job.manual_jd_text as string).trim().length >= MANUAL_JD_MIN_CHARS);
  if (job.jd_quality === "thin" && !hasManualJd && override !== "thin_jd" && override !== "all") {
    return NextResponse.json(
      {
        error:       "This job's description is too short to analyse. Click Edit JD on the row and paste the full job description.",
        action:      "paste_jd",
        jd_quality:  job.jd_quality,
      },
      { status: 422 },
    );
  }

  // Ownership: job → profile → user. We also read target_verticals to resolve
  // per-vertical ATS cutoffs (healthcare/nursing = 40/60, everything else
  // 60/70). The orchestrator already accepts min_initial_ats/min_final_ats —
  // we only pass different VALUES here; no pipeline change.
  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id, target_verticals")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  // Role vertical is the user's ONE global choice from My CV
  // ("What roles are you applying for?" → contact_details.role_families),
  // which "applies to all CVs". It is authoritative for both role-family
  // routing and ATS thresholds. The per-search-profile target_verticals is a
  // legacy fallback only (kept so old profiles without a My CV selection still
  // run). Fetched once here and reused for the contact-line stamp below.
  const { data: prefRow } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const contactDetails =
    (prefRow?.contact_details as import("@/lib/types").ContactDetails | null) ?? null;
  const profileVerticals =
    (profile as { target_verticals?: string[] | null }).target_verticals ?? [];
  const myCvFamilies = (contactDetails?.role_families ?? []).filter(Boolean);
  const effectiveVerticals = myCvFamilies.length > 0 ? myCvFamilies : profileVerticals;
  if (effectiveVerticals.length === 0) {
    return NextResponse.json(
      { error: "No role type selected. Open Profile and choose a role type (e.g. Healthcare / Nursing, Tech) before running analysis." },
      { status: 422 },
    );
  }
  const thresholds = resolveThresholds(effectiveVerticals);

  // ── 1b. User must have an active CV ──────────────────────────────────────
  // Prefer the user-verified `normalized_cv_text` (rendered from the review
  // form's structured_cv) over the raw `cv_text`. Consistency story: every
  // analysis run reads the same canonical skeleton, regardless of how the
  // original CV was laid out. Falls back to `cv_text` for legacy CVs OR
  // when migration 059 (the column itself) hasn't been applied yet.
  // Fetch cv_text AND normalized_cv_text in ONE query. Previously normalized
  // was a SEPARATE query wrapped in a silent try/catch — a transient failure on
  // that second query silently degraded analysis to raw cv_text, whose
  // plain-text layout mis-parses into phantom roles (Moran vs Uniting incident
  // 2026-06-26). One query = no separate failure point. Pre-059 fallback
  // (column absent) re-selects cv_text only.
  type CvRow = {
    id: string;
    cv_text: string | null;
    normalized_cv_text?: string | null;
    structured_cv?: unknown;
    structured_cv_status?: string | null;
  };
  let cv: CvRow | null = null;
  const full = await admin
    .from("cv_versions")
    .select("id, cv_text, normalized_cv_text, structured_cv, structured_cv_status")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (full.error && /normalized_cv_text|structured_cv|column/i.test(full.error.message)) {
    const legacy = await admin
      .from("cv_versions")
      .select("id, cv_text")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    cv = (legacy.data as CvRow | null);
  } else {
    cv = (full.data as CvRow | null);
  }
  if (!cv) {
    return NextResponse.json(
      { error: "No active CV. Upload a CV in the CV library and mark it active." },
      { status: 422 },
    );
  }

  // The structured_cv is the source of truth (the review form edits it).
  // normalized_cv_text is only a rendered cache of it and CAN DRIFT stale/empty
  // — e.g. the structured_cv was fixed but the cache was never re-rendered, so
  // the composer received a hollow CV and fabricated Experience/Education from
  // its prompt template (the Moran "[Institution Name]" incident). So when a
  // parsed structured_cv exists, RE-RENDER from it here and treat that as
  // authoritative; self-heal the stored cache. Any render failure falls back to
  // the stored normalized_cv_text, then raw cv_text — never blocks analysis.
  let normalizedText = cv.normalized_cv_text ?? null;
  const structured = cv.structured_cv;
  const hasParsedStructured =
    (cv.structured_cv_status === "parsed" || cv.structured_cv_status === "verified") &&
    structured !== null &&
    typeof structured === "object" &&
    Array.isArray((structured as { experience?: unknown }).experience);
  if (hasParsedStructured) {
    try {
      const rendered = await renderCanonicalCv({ structured_cv: structured as StructuredCv });
      const fresh = (rendered.normalized_cv_text ?? "").trim();
      if (fresh.length >= 50) {
        const wasStale = fresh !== (normalizedText ?? "").trim();
        normalizedText = fresh;
        if (wasStale) {
          // Best-effort self-heal so the next run + other read paths match.
          try {
            await admin
              .from("cv_versions")
              .update({ normalized_cv_text: fresh })
              .eq("id", cv.id);
          } catch { /* column absent (pre-059) or write denied — ignore */ }
        }
      }
    } catch {
      // cv-backend render-canonical-cv failed — keep the stored cache below.
    }
  }
  const cvTextSource =
    typeof normalizedText === "string" && normalizedText.trim().length >= 50
      ? normalizedText
      : cv.cv_text;
  if (!cvTextSource || cvTextSource.trim().length < 50) {
    return NextResponse.json(
      { error: "Active CV has no usable text. Re-upload your CV." },
      { status: 422 },
    );
  }

  // ── 1c. Platform AI provider must be configured by an admin ──────────────
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;
  const aiModel  = creds.model;

  // ── 1c-bis. Billing gate: reserve a tailored-CV credit ───────────────────
  // A tailored CV is the 2nd-last pipeline step ("analysis"). Reserve here so
  // we fail fast (no JD scrape, no AI spend) when over cap or read-only. The
  // reservation is linked to the run row below and committed/voided by the
  // analysis_runs trigger on completion/failure. Released inline on the early
  // 422/500 paths before a run row exists.
  const cvGate = await consumeTailoredCv(user.id, jobId);
  if (!cvGate.allowed) {
    return NextResponse.json(
      { error: "Tailored CV limit reached", reason: cvGate.reason, action: "upgrade" },
      { status: 402 },
    );
  }
  const usageEventId = cvGate.eventId ?? null;
  const release = async () => { if (usageEventId) await releaseUsageEvent(usageEventId); };

  // Contact details (loaded above for the role vertical) also stamp the CV's
  // contact line. Portfolio projects now live per-CV in structured_cv.projects
  // (rendered into normalized_cv_text by cv-backend), so no separate merge.

  // ── 2. Resolve JD text ────────────────────────────────────────────────────
  // Priority order:
  //   1. manual_jd_text   (user-curated, used as-is if ≥ JD_MIN_USABLE)
  //   2. description       (raw scrape, used if ≥ JD_FULL_THRESHOLD)
  //   3. scrape via cv-backend (when raw is too thin)
  const manualJd     = (job.manual_jd_text ?? "").trim();
  const description  = (job.description ?? "").trim();
  let jdText         = "";
  let jdSourceUrl    = job.url as string | null;

  if (manualJd.length >= JD_MIN_USABLE) {
    jdText = manualJd;
  } else {
    jdText = description;
    if (jdText.length < JD_FULL_THRESHOLD && job.url) {
      try {
        const scraped = await scrapeJd(job.url);
        if (scraped.jd_text && scraped.jd_text.length > jdText.length) {
          jdText      = scraped.jd_text;
          jdSourceUrl = scraped.source_url;
        }
      } catch (err) {
        // Scrape failures aren't fatal if we have *some* description already.
        console.warn("[/api/jobs/:id/analyze] scrape failed:", err);
      }
    }
  }

  if (jdText.length < JD_MIN_USABLE) {
    await release(); // no run row will be created — free the reservation now
    return NextResponse.json(
      { error: "Could not get enough job description text to analyse. The listing may have expired or require login to view." },
      { status: 422 },
    );
  }

  // ── 3. Mark prior runs as stale ──────────────────────────────────────────
  await admin
    .from("analysis_runs")
    .update({ is_stale: true })
    .eq("user_id", user.id)
    .eq("job_id", jobId)
    .eq("is_stale", false);

  // ── 4. Create the new run row (pending) ──────────────────────────────────
  const { data: newRun, error: insertErr } = await admin
    .from("analysis_runs")
    .insert({
      user_id:       user.id,
      job_id:        jobId,
      cv_version_id: cv.id,
      jd_text:       jdText,
      status:        "pending",
      ai_provider:   chosen,
      ai_model:      aiModel,
    })
    .select("id")
    .single();

  if (insertErr || !newRun) {
    console.error("[/api/jobs/:id/analyze] insert run failed:", insertErr?.message);
    await release(); // no run row → free the reservation
    return NextResponse.json({ error: "Failed to create analysis run" }, { status: 500 });
  }

  // Link the reservation to the run so the analysis_runs trigger can commit it
  // on 'completed' or void it on 'failed'.
  if (usageEventId) await linkUsageEvent(usageEventId, newRun.id);

  // Projects are already in the CV text (rendered from structured_cv), so no
  // separate merge is needed.
  const cvTextForAnalysis = cvTextSource;

  // cv-backend only uses contact_details for the contact-line stamp.
  // Splice in the active CV's structured referees (single source of truth —
  // Fix 2); falls back to the legacy profile-store referees when the
  // structured_cv has none.
  const contactForBackend = spliceStructuredReferees(
    (contactDetails as Record<string, unknown> | null) ?? null,
    cv.structured_cv,
  );

  // ── 5–6. Hand off to cv-backend (HMAC-signed) ────────────────────────────
  try {
    await startAnalysis({
      run_id:         newRun.id,
      user_id:        user.id,
      cv_version_id:  cv.id,
      jd_text:        jdText,
      jd_source_url:  jdSourceUrl,
      jd_meta:        {
        title:    job.title,
        company:  job.company,
        location: job.location,
        source:   job.source,
      },
      cv_text:        cvTextForAnalysis,
      ai_provider:    chosen,
      ai_api_key:     aiApiKey,
      ai_model:       aiModel,
      contact_details: contactForBackend,
      // Per-vertical ATS cutoffs: healthcare/nursing = 40/60, else global 60/70.
      // The orchestrator already honours these payload params — no pipeline change.
      min_initial_ats: thresholds.initial,
      min_final_ats:   thresholds.final,
      // Phase C-3 — override forces tailoring even if initial gate fails.
      skip_initial_gate: override === "initial_gate" || override === "all",
      // Pass the explicit vertical so cv-backend skips auto-detection.
      target_vertical: effectiveVerticals[0] ?? null,
    });
  } catch (err) {
    console.error("[/api/jobs/:id/analyze] cv-backend rejected:", err);
    // Best-effort: mark the run failed so the user sees a clear state.
    await admin
      .from("analysis_runs")
      .update({
        status:        "failed",
        error_message: err instanceof CvBackendError
          ? `cv-backend ${err.status}`
          : "cv-backend unreachable — try again",
      })
      .eq("id", newRun.id);
    return NextResponse.json(
      { error: "Could not start analysis. Try again in a moment." },
      { status: 502 },
    );
  }

  // Emit activity event (fire-and-forget — never blocks the response).
  void emitEvent({
    userId: user.id,
    eventType: "analysis_started",
    metadata: { run_id: newRun.id, job_id: jobId, provider: chosen, model: aiModel ?? undefined },
  });

  return NextResponse.json({ run_id: newRun.id, provider: chosen });
}
