/**
 * POST /api/jobs/[id]/analyze
 *
 * Trigger a CV-tailoring analysis for a specific job. End-to-end:
 *
 *   1. Verify the user owns the job and has an active CV + at least one AI key.
 *   2. Resolve the JD text:
 *        - If job.description >= 2000 chars   → use as-is
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
import { decryptApiKey }             from "@/lib/integrations/crypto";
import { startAnalysis, scrapeJd, CvBackendError } from "@/lib/cvBackend";

// Pipeline calls AI multiple times; keep some headroom for the BackgroundTask
// scheduling on cv-backend (the actual long-running work is on Fly, not here).
export const runtime     = "nodejs";
export const maxDuration = 30;

// Preferred provider order when the user has connected more than one BYOK key.
const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

const JD_FULL_THRESHOLD  = 2000;   // chars — below this we try a fresh scrape
const JD_MIN_USABLE      = 200;    // chars — below this we fail the run

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params;

  // Optional preferred provider sent by AnalyzeJobButton from localStorage.
  let preferredProvider: Provider | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    const raw  = (body as { provider?: string }).provider ?? null;
    if (raw && PROVIDER_PRIORITY.includes(raw as Provider)) {
      preferredProvider = raw as Provider;
    }
  } catch {}

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // ── 1a. Verify the job belongs to a profile owned by this user ───────────
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, location, source, url, description, manual_jd_text")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Ownership: job → profile → user
  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // ── 1b. User must have an active CV ──────────────────────────────────────
  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, cv_text")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!cv) {
    return NextResponse.json(
      { error: "No active CV. Upload a CV in the CV library and mark it active." },
      { status: 422 },
    );
  }
  if (!cv.cv_text || cv.cv_text.trim().length < 50) {
    return NextResponse.json(
      { error: "Active CV has no usable text. Re-upload your CV." },
      { status: 422 },
    );
  }

  // ── 1c. User must have at least one AI key ───────────────────────────────
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, status, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keys ?? []) as Array<{ provider: Provider; encrypted_api_key: string; config: { model?: string } | null }>) {
    keyByProvider.set(row.provider, {
      encrypted: row.encrypted_api_key,
      model:     row.config?.model ?? null,
    });
  }
  // Use the user's preferred provider if it's connected; otherwise fall back
  // to the priority order so there's always a working fallback.
  const chosen = (preferredProvider && keyByProvider.has(preferredProvider))
    ? preferredProvider
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key configured. Add one in Settings → AI keys." },
      { status: 422 },
    );
  }

  const chosenEntry = keyByProvider.get(chosen)!;
  let aiApiKey: string;
  try {
    aiApiKey = decryptApiKey(chosenEntry.encrypted);
  } catch (err) {
    console.error("[/api/jobs/:id/analyze] decrypt failed:", err);
    return NextResponse.json(
      { error: "Could not decrypt your AI key. Re-connect it in Settings → AI keys." },
      { status: 500 },
    );
  }
  const aiModel = chosenEntry.model;

  // ── 1d. Load saved contact details + portfolio projects (optional) ──────
  const { data: prefRow } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  interface Project { name?: string; url?: string; description?: string }
  interface ContactDetails {
    name?: string; phone?: string; email?: string; address?: string;
    linkedin?: string; github?: string; website?: string; portfolio?: string;
    other_label?: string; other_url?: string;
    projects?: Project[];
  }
  const contactDetails =
    (prefRow?.contact_details as ContactDetails | null) ?? null;
  const portfolioProjects = contactDetails?.projects ?? [];

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
    return NextResponse.json({ error: "Failed to create analysis run" }, { status: 500 });
  }

  // Augment the CV text with the user's saved portfolio projects so the
  // tailoring AI considers them even if they're not already in the CV PDF.
  // Appended as a markdown section the AI naturally recognises.
  let cvTextForAnalysis = cv.cv_text;
  if (portfolioProjects.length > 0) {
    const lines = ["", "## Projects"];
    for (const p of portfolioProjects) {
      const titleParts: string[] = [];
      if (p.name) titleParts.push(`**${p.name}**`);
      if (p.url)  titleParts.push(`[${p.url}](${p.url})`);
      if (titleParts.length > 0) lines.push(`- ${titleParts.join(" · ")}`);
      if (p.description) lines.push(`  ${p.description}`);
    }
    cvTextForAnalysis = `${cv.cv_text.trimEnd()}\n${lines.join("\n")}\n`;
  }

  // Drop the bulky 'projects' sub-array before sending — cv-backend only
  // uses contact_details for the contact-line stamp.
  const contactForBackend = contactDetails
    ? Object.fromEntries(Object.entries(contactDetails).filter(([k]) => k !== "projects"))
    : null;

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

  return NextResponse.json({ run_id: newRun.id, provider: chosen });
}
