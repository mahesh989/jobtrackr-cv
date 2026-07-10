/**
 * POST /api/cv/[id]/recategorise
 *
 * Re-trigger AI skill categorisation for an existing CV. Useful when:
 *   - The CV was uploaded before an AI key was connected.
 *   - The user wants to refresh categories after editing their key.
 *
 * Returns { categorised_skills } on success.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { categoriseCv, CvBackendError } from "@/lib/cvBackend";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

export const runtime     = "nodejs";
// categoriseCv retries once (sequential) on a stored-model failure, so worst
// case is ~2x its 30s internal timeout — 55 stays under the 60s ceiling that
// works on any Vercel plan tier.
export const maxDuration = 55;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 1 AI call (categoriseCv).
  const rl = await rateLimit(`cv-recategorise:${user.id}`, 10, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

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
    return NextResponse.json({ error: "CV has no extractable text — re-upload the file." }, { status: 422 });
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

  // Call cv-backend. If the stored model fails (e.g. a
  // completions-only or unrecognised model name), retry once with the
  // provider's safe default (ai_model: null → cv-backend uses gpt-4o / claude-3-5-sonnet / deepseek-chat).
  function extractDetail(err: unknown): string {
    if (err instanceof CvBackendError) {
      const d = err.detail;
      if (d && typeof d === "object" && "detail" in d) return String((d as Record<string,unknown>).detail);
      return String(d ?? err.status);
    }
    return err instanceof Error ? err.message : "AI categorisation failed";
  }

  let categorised: { technical: string[]; soft_skills: string[]; domain_knowledge: string[] };
  const apiKey      = creds.apiKey;
  const storedModel = creds.model ?? null;
  try {
    categorised = await categoriseCv({ cv_text: cv.cv_text, ai_provider: chosen, ai_api_key: apiKey, ai_model: storedModel });
  } catch (firstErr) {
    // Retry without the stored model (cv-backend falls back to a safe default per provider).
    if (storedModel) {
      console.warn("[/api/cv/:id/recategorise] stored model failed, retrying with default:", extractDetail(firstErr));
      try {
        categorised = await categoriseCv({ cv_text: cv.cv_text, ai_provider: chosen, ai_api_key: apiKey, ai_model: null });
      } catch (retryErr) {
        console.error("[/api/cv/:id/recategorise] retry also failed:", extractDetail(retryErr));
        return NextResponse.json({ error: extractDetail(retryErr) }, { status: 502 });
      }
    } else {
      console.error("[/api/cv/:id/recategorise] categorisation failed:", extractDetail(firstErr));
      return NextResponse.json({ error: extractDetail(firstErr) }, { status: 502 });
    }
  }

  // Persist the result
  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({ categorised_skills: categorised })
    .eq("id", id);

  if (updateErr) {
    console.error("[/api/cv/:id/recategorise] update error:", updateErr.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  return NextResponse.json({ categorised_skills: categorised });
}
