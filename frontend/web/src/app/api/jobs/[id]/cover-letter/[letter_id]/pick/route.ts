/**
 * POST /api/jobs/[id]/cover-letter/[letter_id]/pick
 *
 * Confirm the user's chosen opening paragraph variant. Stores the chosen
 * opener and discarded variants, then triggers cv-backend to generate
 * P2-4 from the chosen opener (BackgroundTask).
 *
 * Request body:
 *   { variant_id: string }  — the "id" field of the chosen OpeningVariant
 *
 * Preconditions (reject with 409 if not met):
 *   - cover_letters row exists, belongs to this user + job, status = 'picking'
 *
 * Responses:
 *   200  { letter_id }
 *   400  Missing/invalid variant_id
 *   401  Unauthorized
 *   403  Letter not owned by this user
 *   404  Letter not found or wrong job
 *   409  Letter is not in 'picking' state (already generating/completed/failed)
 *   500  DB or internal error
 *   502  cv-backend trigger failed
 */

import { NextRequest, NextResponse }    from "next/server";
import { createAdminClient }             from "@/lib/supabase/admin";
import { getActiveAiCredentials }        from "@/lib/ai/activeProvider";
import { generateCoverLetter, CvBackendError, OpeningVariant } from "@/lib/cv/backend";
import type { ToneTarget }              from "@/lib/types";
import { withUser } from "@/lib/api-utils";

// Local type for the cover_letters columns we read in this route.
// opening_variants is not yet in the generated Supabase types (migration 027
// applied manually); the explicit cast below keeps TypeScript happy.
interface PickLetter {
  user_id:           string;
  job_id:            string;
  status:            string;
  opening_variants:  OpeningVariant[] | null;
  company_hook_text: string | null;
  tone_target:       string | null;
  ai_provider:       string;
  story_id:          string | null;
  quality_flags:     Record<string, unknown>;
}

export const runtime     = "nodejs";
export const maxDuration = 30;  // cv-backend returns 202 immediately

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; letter_id: string }> }, { user }) => {
  const { id: jobId, letter_id: letterId } = await params;

  // ── 1. Auth ────────────────────────────────────────────────────────────────

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: { variant_id?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body handled below */ }

  const variantId = typeof body.variant_id === "string" ? body.variant_id.trim() : "";
  if (!variantId) {
    return NextResponse.json({ error: "variant_id is required." }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── 3. Fetch the letter (ownership + status guard) ─────────────────────────
  const { data: rawLetter, error: fetchErr } = await admin
    .from("cover_letters")
    .select(
      "id, user_id, job_id, status, opening_variants, " +
      "company_hook_text, tone_target, ai_provider, story_id, quality_flags",
    )
    .eq("id", letterId)
    .eq("job_id", jobId)
    .maybeSingle();

  // Cast: opening_variants is not in the generated types until migration 027
  // is reflected in the Supabase type generation.
  const letter = rawLetter as unknown as PickLetter | null;

  if (fetchErr) {
    console.error("[POST /pick] DB fetch error:", fetchErr.message);
    return NextResponse.json({ error: "Failed to fetch cover letter." }, { status: 500 });
  }
  if (!letter) {
    return NextResponse.json({ error: "Cover letter not found." }, { status: 404 });
  }
  if (letter.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (letter.status !== "picking") {
    return NextResponse.json(
      { error: `Letter is in '${letter.status}' state — cannot pick an opener now.` },
      { status: 409 },
    );
  }

  // ── 4. Find chosen variant; compute discarded ──────────────────────────────
  const allVariants = (letter.opening_variants ?? []) as OpeningVariant[];
  const chosen = allVariants.find((v) => v.id === variantId);
  if (!chosen) {
    return NextResponse.json(
      { error: `Variant '${variantId}' not found in this letter's opening options.` },
      { status: 400 },
    );
  }
  const discarded = allVariants.filter((v) => v.id !== variantId);

  // ── 5. Resolve prerequisites (CV, voice) ────────────────────────────────────
  const [
    { data: cvRow },
    { data: voiceRow },
  ] = await Promise.all([
    admin
      .from("cv_versions")
      .select("cv_text")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle(),

    admin
      .from("voice_profiles")
      .select("fingerprint, voice_sample_raw")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (!cvRow?.cv_text) {
    return NextResponse.json(
      { error: "Active CV not found — prerequisites changed since variants were generated." },
      { status: 422 },
    );
  }
  if (!voiceRow?.fingerprint || !voiceRow?.voice_sample_raw) {
    return NextResponse.json(
      { error: "Voice profile not found — prerequisites changed since variants were generated." },
      { status: 422 },
    );
  }

  // ── 5b. Resolve platform AI provider/key/model ──────────────────────────────
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const aiProvider = creds.provider;
  const aiApiKey   = creds.apiKey;

  // ── 6. Resolve story and JD ────────────────────────────────────────────────
  // Read story via story_id FK (may be NULL if stories were re-extracted).
  // Fall back to first story in the batch if FK is stale.
  let topStory: Record<string, unknown> | null = null;
  if (letter.story_id) {
    const { data: storyRow } = await admin
      .from("stories")
      .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
      .eq("id", letter.story_id as string)
      .maybeSingle();
    if (storyRow) topStory = storyRow as Record<string, unknown>;
  }
  if (!topStory) {
    // story_id FK went NULL (re-extraction deleted old stories). Use latest batch.
    const { data: tsRow } = await admin
      .from("stories")
      .select("extraction_timestamp")
      .eq("user_id", user.id)
      .order("extraction_timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tsRow) {
      const { data: storyRows } = await admin
        .from("stories")
        .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
        .eq("user_id", user.id)
        .eq("extraction_timestamp", tsRow.extraction_timestamp)
        .limit(1);
      if (storyRows && storyRows.length > 0) topStory = storyRows[0] as Record<string, unknown>;
    }
  }
  // topStory may legitimately stay null (CV yielded no stories) — cv-backend
  // accepts story: null and draws the letter's substance from the CV text.

  // Resolve JD text: prefer job.manual_jd_text, fall back to latest completed run.
  const { data: jobRow } = await admin
    .from("jobs")
    .select("manual_jd_text, description, title, company")
    .eq("id", jobId)
    .maybeSingle();

  const manualJd = (jobRow?.manual_jd_text ?? "").trim();
  let jdText = manualJd.length >= 50 ? manualJd : "";
  if (!jdText) {
    const { data: runRow } = await admin
      .from("analysis_runs")
      .select("jd_text")
      .eq("job_id", jobId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    jdText = (runRow?.jd_text ?? "").trim();
  }
  if (!jdText) {
    return NextResponse.json(
      { error: "No JD text available — analyse the job first or add a manual JD." },
      { status: 422 },
    );
  }

  // ── 7. Persist pick + advance status to 'pending' ─────────────────────────
  const { error: patchErr } = await admin
    .from("cover_letters")
    .update({
      chosen_opening:     chosen.text,
      discarded_openings: discarded,
      status:             "pending",
    })
    .eq("id", letterId);

  if (patchErr) {
    console.error("[POST /pick] DB patch error:", patchErr.message);
    return NextResponse.json({ error: "Failed to save selection." }, { status: 500 });
  }

  // ── 8. Trigger cv-backend to generate P2-4 (BackgroundTask, 202) ─────────
  // chosen_opening is forwarded; cv-backend writes only P2-4 and prepends it.
  // voice_sample_raw must not appear in logs.
  try {
    await generateCoverLetter({
      letter_id:         letterId,
      user_id:           user.id,
      job_id:            jobId,
      jd_text:           jdText,
      role:              (jobRow?.title ?? "the role").trim(),
      company_name:      (jobRow?.company ?? "the company").trim(), // jobs.company, not cover_letters.company_hook_text
      cv_text:           cvRow.cv_text as string,
      voice_sample_text: voiceRow.voice_sample_raw as string,
      fingerprint:       voiceRow.fingerprint as Record<string, unknown>,
      story:             topStory,
      company_hook_text: (letter.company_hook_text ?? "") as string,
      tone_target:       (letter.tone_target as ToneTarget) ?? "professional",
      word_count_target: 170,
      ai_provider:       aiProvider,
      ai_api_key:        aiApiKey,
      ai_model:          creds.model ?? undefined,
      chosen_opening:    chosen.text,
    });
  } catch (err) {
    // Roll back status to 'picking' so the user can try again
    await admin
      .from("cover_letters")
      .update({ status: "picking" })
      .eq("id", letterId);

    console.error(
      "[POST /pick] cv-backend trigger error:",
      err instanceof CvBackendError ? `${err.status}: ${JSON.stringify(err.detail)}` : String(err),
    );
    return NextResponse.json(
      { error: "Generation failed to start. Your selection has been preserved — try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ letter_id: letterId });
});
