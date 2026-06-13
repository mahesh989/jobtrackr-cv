/**
 * POST /api/cv/[id]/structurize
 *
 * On-demand structurization for an EXISTING CV. Lets the user run the
 * review form on CVs that were uploaded before the structurization feature
 * shipped (i.e. structured_cv is NULL). Runs the same single AI call the
 * upload route uses, then persists structured_cv + normalized_cv_text.
 *
 * Returns { ok: true } on success — the caller then routes to
 * /dashboard/cv/{id}/review.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { decryptApiKey }             from "@/lib/integrations/crypto";
import { structurizeCv, CvBackendError } from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 60;

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

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

  const { data: keyRows } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  type KeyRow = { provider: Provider; encrypted_api_key: string; config: { model?: string } | null };
  const keyByProvider = new Map<Provider, KeyRow>();
  for (const row of (keyRows ?? []) as KeyRow[]) keyByProvider.set(row.provider, row);

  const { searchParams } = new URL(req.url);
  const preferredProvider = searchParams.get("provider") as Provider | null;
  const chosen = (preferredProvider && keyByProvider.has(preferredProvider))
    ? preferredProvider
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key connected. Add one in Settings → Integrations." },
      { status: 422 },
    );
  }

  const k = keyByProvider.get(chosen)!;
  let apiKey: string;
  try { apiKey = decryptApiKey(k.encrypted_api_key); }
  catch {
    return NextResponse.json(
      { error: "Could not decrypt your AI key — re-connect it in Integrations." },
      { status: 500 },
    );
  }

  const storedModel = k.config?.model ?? null;
  let result;
  try {
    result = await structurizeCv({ cv_text: cv.cv_text, ai_provider: chosen, ai_api_key: apiKey, ai_model: storedModel });
  } catch (firstErr) {
    if (storedModel) {
      try {
        result = await structurizeCv({ cv_text: cv.cv_text, ai_provider: chosen, ai_api_key: apiKey, ai_model: null });
      } catch (retryErr) {
        const detail = retryErr instanceof CvBackendError ? `cv-backend ${retryErr.status}` : "AI structurization failed";
        console.error("[/api/cv/:id/structurize] retry failed:", retryErr);
        return NextResponse.json({ error: detail }, { status: 502 });
      }
    } else {
      const detail = firstErr instanceof CvBackendError ? `cv-backend ${firstErr.status}` : "AI structurization failed";
      console.error("[/api/cv/:id/structurize] failed:", firstErr);
      return NextResponse.json({ error: detail }, { status: 502 });
    }
  }

  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({
      structured_cv:        result.structured_cv,
      structured_cv_status: "parsed",
      normalized_cv_text:   result.normalized_cv_text,
      categorised_skills:   result.structured_cv.skills,
    })
    .eq("id", id);

  if (updateErr) {
    // Most likely cause: migrations 058+059 not applied yet.
    console.error("[/api/cv/:id/structurize] update failed:", updateErr.message);
    return NextResponse.json(
      { error: "Save failed — apply migrations 058 and 059 in Supabase first." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
