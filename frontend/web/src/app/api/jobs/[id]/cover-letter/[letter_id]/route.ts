/**
 * GET /api/jobs/[id]/cover-letter/[letter_id]
 *
 * Fetch the current state of a cover_letters row. Used for:
 *   1. Initial page load — get whatever state exists at render time
 *   2. Polling fallback — if Realtime is unavailable, poll this until
 *      status === "completed" or "failed"
 *
 * Returns the full row (minus voice_sample_raw, which is not stored on
 * cover_letters — only on voice_profiles).
 *
 * Ownership: letter must belong to the authenticated user AND to the job.
 *
 * Responses:
 *   200  { letter: CoverLetterRow }
 *   401  Unauthorized
 *   404  Letter not found or not owned by user
 *   500  DB error
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 10;

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; letter_id: string }> },
  { user },
) => {
  const { id: jobId, letter_id: letterId } = await params;


  const admin = createAdminClient();

  // Ownership: letter must belong to this user AND this job.
  // Use admin client for a single-query ownership-and-fetch.
  const { data: letter, error } = await admin
    .from("cover_letters")
    .select(
      "id, job_id, status, generation_status, story_id, company_hook_text, " +
      "tone_target, word_count_target, pass_1_skeleton, pass_2_voice_transferred, " +
      "pass_3_final, burstiness_score, naturalness_score, coherence_score, " +
      "specificity_ok, honesty_ok, quality_flags, ai_provider, " +
      "pass_1_model, pass_2_model, pass_3_model, " +
      "opening_variants, chosen_opening, discarded_openings, " +
      "user_edits, outcome, error_message, is_stale, " +
      "started_at, completed_at, created_at, updated_at",
    )
    .eq("id", letterId)
    .eq("user_id", user.id)
    .eq("job_id", jobId)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/jobs/[id]/cover-letter/[letter_id]] DB error:", error.message);
    return jsonError("Failed to fetch cover letter.", 500);
  }

  if (!letter) {
    return jsonError("Cover letter not found.", 404);
  }

  return NextResponse.json({ letter });
});
