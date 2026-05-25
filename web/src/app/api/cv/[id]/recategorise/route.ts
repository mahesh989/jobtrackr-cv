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
import { decryptApiKey }             from "@/lib/integrations/crypto";
import { categoriseCv, CvBackendError } from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 25;

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

export async function POST(
  _req: NextRequest,
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
    return NextResponse.json({ error: "CV has no extractable text — re-upload the file." }, { status: 422 });
  }

  // Find the user's best AI key
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
  const chosen = PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key connected. Add one in Settings → Integrations." },
      { status: 422 },
    );
  }

  // Decrypt key + call cv-backend. If the stored model fails (e.g. a
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
  const k = keyByProvider.get(chosen)!;
  let apiKey: string;
  try { apiKey = decryptApiKey(k.encrypted_api_key); }
  catch (e) {
    return NextResponse.json({ error: "Could not decrypt your AI key — re-connect it in Integrations." }, { status: 500 });
  }

  const storedModel = k.config?.model ?? null;
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
