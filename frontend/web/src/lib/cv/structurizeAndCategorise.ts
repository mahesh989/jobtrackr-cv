/**
 * Run structurize + categorise in parallel, merge the categoriser's skills
 * into the structured_cv, and re-render canonical text so the analysis
 * pipeline sees the full skill set in `normalized_cv_text`.
 *
 * Shared by /api/cv (upload) and /api/cv/[id]/structurize (on-demand).
 *
 * Each call retries once with the provider's default model when the user's
 * stored model rejects the request — mirrors the historical pattern from the
 * pre-structurize era when /internal/categorise-cv was the only call.
 */
import {
  structurizeCv,
  categoriseCv,
  renderCanonicalCv,
  type StructuredCv,
  type CategoriseCvResponse,
} from "@/lib/cv/backend";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptApiKey }     from "@/lib/integrations/crypto";
import { PROVIDER_ORDER }    from "@/lib/ai/models";
import type { AiProvider }   from "@/lib/ai/models";

export interface StructurizeAndCategoriseResult {
  structured_cv:      StructuredCv;
  normalized_cv_text: string;
  categorised:        CategoriseCvResponse;
}

async function withModelRetry<T>(
  fn: (model: string | null) => Promise<T>,
  storedModel: string | null,
  label: string,
): Promise<T> {
  try {
    return await fn(storedModel);
  } catch (firstErr) {
    if (!storedModel) throw firstErr;
    console.warn(`[${label}] stored model failed, retrying default:`, firstErr);
    return await fn(null);
  }
}

export async function runStructurizeAndCategorise(
  cvText:      string,
  provider:    AiProvider,
  apiKey:      string,
  storedModel: string | null,
): Promise<StructurizeAndCategoriseResult> {
  const [structureRes, categorised] = await Promise.all([
    withModelRetry(
      (m) => structurizeCv({ cv_text: cvText, ai_provider: provider, ai_api_key: apiKey, ai_model: m }),
      storedModel,
      "structurize",
    ),
    withModelRetry(
      (m) => categoriseCv({ cv_text: cvText, ai_provider: provider, ai_api_key: apiKey, ai_model: m }),
      storedModel,
      "categorise",
    ),
  ]);

  const merged: StructuredCv = {
    ...structureRes.structured_cv,
    skills: categorised,
  };

  // Re-render canonical text from the merged version so normalized_cv_text
  // carries the full categoriseCv skill set (the structurize render saw
  // an empty/partial skills block).
  const rendered = await renderCanonicalCv({ structured_cv: merged });

  return {
    structured_cv:      merged,
    normalized_cv_text: rendered.normalized_cv_text,
    categorised,
  };
}

// ── Persistence wrapper ─────────────────────────────────────────────────────

type StructurizeAndPersistError =
  | { kind: "not_found" }
  | { kind: "empty_cv_text" }
  | { kind: "no_ai_key" }
  | { kind: "decrypt_failed" }
  | { kind: "ai_failed";    message: string }
  | { kind: "db_failed";    message: string };

export type StructurizeAndPersistResult =
  | { ok: true;  structured_cv: StructuredCv; normalized_cv_text: string; categorised: CategoriseCvResponse }
  | { ok: false; error: StructurizeAndPersistError };

/**
 * Look up the CV + user's preferred AI key, run structurize + categorise,
 * persist the merged result, and return what was written. Shared by the
 * /api/cv/[id]/structurize POST route and the review page's silent
 * stale-version refresh.
 */
export async function structurizeAndPersist(
  userId: string,
  cvId:   string,
  preferredAiProvider: AiProvider | null = null,
): Promise<StructurizeAndPersistResult> {
  const admin = createAdminClient();

  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, cv_text")
    .eq("id", cvId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!cv) return { ok: false, error: { kind: "not_found" } };
  if (!cv.cv_text || cv.cv_text.trim().length < 50) {
    return { ok: false, error: { kind: "empty_cv_text" } };
  }

  const { data: keyRows } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, config")
    .eq("user_id", userId)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_ORDER as unknown as string[]);

  type KeyRow = { provider: AiProvider; encrypted_api_key: string; config: { model?: string } | null };
  const keyByAiProvider = new Map<AiProvider, KeyRow>();
  for (const row of (keyRows ?? []) as KeyRow[]) keyByAiProvider.set(row.provider, row);

  const chosen = (preferredAiProvider && keyByAiProvider.has(preferredAiProvider))
    ? preferredAiProvider
    : PROVIDER_ORDER.find((p) => keyByAiProvider.has(p));
  if (!chosen) return { ok: false, error: { kind: "no_ai_key" } };

  const k = keyByAiProvider.get(chosen)!;
  let apiKey: string;
  try { apiKey = decryptApiKey(k.encrypted_api_key); }
  catch { return { ok: false, error: { kind: "decrypt_failed" } }; }

  let result: StructurizeAndCategoriseResult;
  try {
    result = await runStructurizeAndCategorise(cv.cv_text, chosen, apiKey, k.config?.model ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI structurization failed";
    return { ok: false, error: { kind: "ai_failed", message } };
  }

  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({
      structured_cv:        result.structured_cv,
      structured_cv_status: "parsed",
      normalized_cv_text:   result.normalized_cv_text,
      categorised_skills:   result.categorised,
    })
    .eq("id", cvId);

  if (updateErr) {
    return { ok: false, error: { kind: "db_failed", message: updateErr.message } };
  }

  return { ok: true, ...result };
}
