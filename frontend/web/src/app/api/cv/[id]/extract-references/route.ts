/**
 * POST /api/cv/[id]/extract-references
 *
 * On-demand referee extraction from an existing CV's text. Used by the
 * References section under /dashboard/cv → "Extract from CV" button.
 *
 * Result is cached on `cv_versions.extracted_references` and returned to
 * the client. NEVER auto-writes to user_preferences — the UI offers a
 * "Use these" button so the user explicitly opts in.
 *
 * Returns { referees: ExtractedReferee[] } on success.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import {
  extractCvReferences,
  CvBackendError,
  type ExtractCvReferencesResponse,
  type ExtractedReferee,
} from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 25;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Fetch the CV (verify ownership + get cv_text)
  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, cv_text")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!cv) return NextResponse.json({ error: "CV not found" }, { status: 404 });
  if (!cv.cv_text || cv.cv_text.trim().length < 50) {
    return NextResponse.json(
      { error: "CV has no extractable text — re-upload the file." },
      { status: 422 },
    );
  }

  // Resolve the platform AI provider/key/model
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen = creds.provider;

  function extractDetail(err: unknown): string {
    if (err instanceof CvBackendError) {
      const d = err.detail;
      if (d && typeof d === "object" && "detail" in d) return String((d as Record<string,unknown>).detail);
      return String(d ?? err.status);
    }
    return err instanceof Error ? err.message : "AI extraction failed";
  }

  const apiKey      = creds.apiKey;
  const storedModel = creds.model ?? null;
  let result: ExtractCvReferencesResponse;
  try {
    result = await extractCvReferences({
      cv_text:     cv.cv_text,
      ai_provider: chosen,
      ai_api_key:  apiKey,
      ai_model:    storedModel,
    });
  } catch (firstErr) {
    if (storedModel) {
      console.warn("[/api/cv/:id/extract-references] stored model failed, retrying with default:", extractDetail(firstErr));
      try {
        result = await extractCvReferences({
          cv_text:     cv.cv_text,
          ai_provider: chosen,
          ai_api_key:  apiKey,
          ai_model:    null,
        });
      } catch (retryErr) {
        console.error("[/api/cv/:id/extract-references] retry also failed:", extractDetail(retryErr));
        return NextResponse.json({ error: extractDetail(retryErr) }, { status: 502 });
      }
    } else {
      console.error("[/api/cv/:id/extract-references] extraction failed:", extractDetail(firstErr));
      return NextResponse.json({ error: extractDetail(firstErr) }, { status: 502 });
    }
  }

  const referees: ExtractedReferee[] = result.referees ?? [];

  // Cache the extracted list on the CV row so we don't pay for another AI
  // call if the user reopens the page. Stored even when empty — that's a
  // meaningful "extracted but none found" signal.
  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({ extracted_references: referees })
    .eq("id", id);

  if (updateErr) {
    console.error("[/api/cv/:id/extract-references] update error:", updateErr.message);
    // Don't fail the request — we already have a valid result. Just log it.
  }

  return NextResponse.json({ referees });
}
