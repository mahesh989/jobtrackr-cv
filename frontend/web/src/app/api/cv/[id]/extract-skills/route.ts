/**
 * POST /api/cv/[id]/extract-skills
 *
 * AI skill extraction for built-from-scratch CVs where the user hasn't
 * filled the skills buckets. The client passes the current experience /
 * education text from the builder; we call /internal/categorise-cv on the
 * Python backend and return the three skill buckets for the user to review.
 *
 * Falls back to the stored cv_text / normalized_cv_text when no body text
 * is provided (e.g. for uploaded CVs opened on the review page).
 *
 * Returns { domain_knowledge, soft_skills, technical } on success.
 */

import { NextRequest, NextResponse }  from "next/server";
import { createClient }               from "@/lib/supabase/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { getActiveAiCredentials }     from "@/lib/ai/activeProvider";
import { categoriseCv, CvBackendError } from "@/lib/cvBackend";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

export const runtime     = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 1 AI call (categoriseCv), builder "Suggest from experience".
  const rl = await rateLimit(`cv-extract-skills:${user.id}`, 12, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const admin = createAdminClient();

  // Ownership check + fetch stored text (fallback when no body text).
  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, cv_text, normalized_cv_text")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!cv) return NextResponse.json({ error: "CV not found" }, { status: 404 });

  // Client may send the current builder text directly (before saving) so we
  // can extract skills without forcing a save first.
  let body: { cv_text?: string } = {};
  try { body = await req.json().catch(() => ({})); } catch { /* no body */ }

  const cvText =
    (body.cv_text?.trim() ?? "").length >= 50
      ? body.cv_text!
      : (cv.normalized_cv_text?.trim() ?? cv.cv_text?.trim() ?? "");

  if (cvText.length < 50) {
    return NextResponse.json(
      { error: "Not enough CV text to extract skills from. Add some experience first." },
      { status: 422 },
    );
  }

  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured." },
      { status: 422 },
    );
  }

  function extractDetail(err: unknown): string {
    if (err instanceof CvBackendError) {
      const d = err.detail;
      if (d && typeof d === "object" && "detail" in d) return String((d as Record<string, unknown>).detail);
      return String(d ?? err.status);
    }
    return err instanceof Error ? err.message : "AI extraction failed";
  }

  try {
    const result = await categoriseCv({
      cv_text:     cvText,
      ai_provider: creds.provider,
      ai_api_key:  creds.apiKey,
      ai_model:    creds.model ?? null,
    });
    return NextResponse.json({
      domain_knowledge: result.domain_knowledge ?? [],
      soft_skills:      result.soft_skills      ?? [],
      technical:        result.technical         ?? [],
    });
  } catch (firstErr) {
    // Retry without the stored model (fall back to provider default).
    if (creds.model) {
      try {
        const result = await categoriseCv({
          cv_text:     cvText,
          ai_provider: creds.provider,
          ai_api_key:  creds.apiKey,
          ai_model:    null,
        });
        return NextResponse.json({
          domain_knowledge: result.domain_knowledge ?? [],
          soft_skills:      result.soft_skills      ?? [],
          technical:        result.technical         ?? [],
        });
      } catch (retryErr) {
        console.error("[/api/cv/:id/extract-skills] retry failed:", extractDetail(retryErr));
        return NextResponse.json({ error: extractDetail(retryErr) }, { status: 502 });
      }
    }
    console.error("[/api/cv/:id/extract-skills] failed:", extractDetail(firstErr));
    return NextResponse.json({ error: extractDetail(firstErr) }, { status: 502 });
  }
}
