/**
 * POST /api/jobs/[id]/analyze/[run_id]/resume
 *
 * Resume a run that stopped at the initial-ATS gate. Unlike the main
 * /analyze route, this does NOT create a new run — it re-triggers the SAME
 * run row so cv-backend can reuse the already-saved jd_analysis /
 * cv_jd_matching / ats_scoring results and continue from
 * input_recommendations onward (saving the two early AI calls).
 *
 *   1. Verify the user owns the job and the run stopped at the gate.
 *   2. Load the CV text used by the run + decrypt the same-provider AI key.
 *   3. Reset the four skipped downstream steps to 'pending', status='running'.
 *   4. POST signed /internal/analyze with resume=true + the existing run_id.
 *   5. Return { run_id } (unchanged — the browser stays on the same page).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { startAnalysis, CvBackendError } from "@/lib/cvBackend";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

export const runtime     = "nodejs";
export const maxDuration = 30;

// The downstream steps the gate early-stop marks 'skipped' — reset to pending.
const DOWNSTREAM_STEPS = [
  "input_recommendations",
  "keyword_feasibility",
  "ai_recommendations",
  "tailored_cv",
] as const;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; run_id: string }> },
) {
  const { id: jobId, run_id: runId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = await rateLimit(`analyze:${user.id}`, 20, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const admin = createAdminClient();

  // ── 1. Load the run + verify it stopped at the initial gate ──────────────
  const { data: run, error: runErr } = await admin
    .from("analysis_runs")
    .select("id, job_id, user_id, status, step_status, cv_version_id, jd_text, ai_provider, ai_model")
    .eq("id", runId)
    .eq("job_id", jobId)
    .maybeSingle();

  if (runErr) {
    console.error("[/api/jobs/:id/analyze/:run_id/resume] run lookup failed:", runErr.message);
    return NextResponse.json({ error: "Could not load the run." }, { status: 500 });
  }
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // ── Ownership: job → profile → user ──────────────────────────────────────
  const { data: job } = await admin
    .from("jobs")
    .select("profile_id, title, company, location, source, url")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Only gate-stopped runs are resumable: completed + tailored_cv skipped.
  const stepStatus = (run.step_status ?? {}) as Record<string, string>;
  if (run.status !== "completed" || stepStatus.tailored_cv !== "skipped") {
    return NextResponse.json(
      { error: "This run can't be resumed — it didn't stop at the initial gate." },
      { status: 409 },
    );
  }

  // ── 2a. Load the CV text the run used (not the currently-active CV, so the
  //        cached matching stays consistent). Projects now live per-CV in the
  //        CV text itself, so no portfolio merge is needed. ─────────────────
  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, cv_text")
    .eq("id", run.cv_version_id)
    .maybeSingle();
  if (!cv?.cv_text || cv.cv_text.trim().length < 50) {
    return NextResponse.json(
      { error: "The CV used for this run is no longer available. Re-run the analysis instead." },
      { status: 422 },
    );
  }

  const { data: prefRow } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  interface ContactDetails {
    name?: string; phone?: string; email?: string; address?: string;
    linkedin?: string; github?: string; website?: string; portfolio?: string;
    other_label?: string; other_url?: string;
  }
  const contactDetails    = (prefRow?.contact_details as ContactDetails | null) ?? null;
  const cvTextForAnalysis = cv.cv_text;
  const contactForBackend = (contactDetails as Record<string, unknown> | null) ?? null;

  // ── 2b. Resolve the platform AI provider/key/model ────────────────────────
  // Resuming re-uses whatever provider+model is currently active (an admin
  // may have switched providers since the run originally started).
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

  // ── 3. Reset the skipped steps + flip the run back to running ─────────────
  const resetSteps = { ...stepStatus };
  for (const s of DOWNSTREAM_STEPS) resetSteps[s] = "pending";
  await admin
    .from("analysis_runs")
    .update({ status: "running", step_status: resetSteps, error_message: null })
    .eq("id", runId);

  // ── 4. Hand off to cv-backend (same run_id, resume=true) ─────────────────
  try {
    await startAnalysis({
      run_id:          runId,
      user_id:         user.id,
      cv_version_id:   run.cv_version_id,
      jd_text:         run.jd_text,
      jd_source_url:   (job.url as string | null) ?? null,
      jd_meta:         {
        title:    job.title,
        company:  job.company,
        location: job.location,
        source:   job.source,
      },
      cv_text:         cvTextForAnalysis,
      ai_provider:     chosen,
      ai_api_key:      aiApiKey,
      ai_model:        aiModel,
      contact_details: contactForBackend,
      resume:            true,
      skip_initial_gate: true,
    });
  } catch (err) {
    console.error("[/api/jobs/:id/analyze/:run_id/resume] cv-backend rejected:", err);
    // Revert to the gate-stopped state so the banner re-appears.
    await admin
      .from("analysis_runs")
      .update({ status: "completed", step_status: stepStatus })
      .eq("id", runId);
    return NextResponse.json(
      {
        error: err instanceof CvBackendError
          ? "Could not resume analysis. Try again in a moment."
          : "cv-backend unreachable — try again.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ run_id: runId, provider: chosen });
}
