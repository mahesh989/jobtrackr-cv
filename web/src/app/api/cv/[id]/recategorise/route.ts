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

  // Decrypt key + call cv-backend
  let categorised: { technical: string[]; soft_skills: string[]; domain_knowledge: string[] };
  try {
    const k = keyByProvider.get(chosen)!;
    const apiKey = decryptApiKey(k.encrypted_api_key);
    categorised = await categoriseCv({
      cv_text:     cv.cv_text,
      ai_provider: chosen,
      ai_api_key:  apiKey,
      ai_model:    k.config?.model ?? null,
    });
  } catch (err) {
    console.error("[/api/cv/:id/recategorise] categorisation failed:", err);
    const msg = err instanceof CvBackendError
      ? `AI categorisation failed (${err.status})`
      : err instanceof Error ? err.message : "AI categorisation failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Persist the result
  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({ categorised_skills: categorised })
    .eq("id", id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ categorised_skills: categorised });
}
