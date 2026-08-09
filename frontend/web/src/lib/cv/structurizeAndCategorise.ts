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
import { createAdminClient }      from "@/lib/supabase/admin";
import { getActiveAiCredentials } from "@/lib/ai/activeProvider";
import type { AiProvider }        from "@/lib/ai/models";

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
  // Covers "no active platform provider" AND "its key failed to decrypt" —
  // getActiveAiCredentials() returns null for both, and neither is something
  // an end user can act on, so they are one case now. The old separate
  // `decrypt_failed` told users to re-connect a key they never owned.
  | { kind: "no_ai_key" }
  | { kind: "ai_failed";    message: string }
  | { kind: "db_failed";    message: string };

export type StructurizeAndPersistResult =
  | { ok: true;  structured_cv: StructuredCv; normalized_cv_text: string; categorised: CategoriseCvResponse }
  | { ok: false; error: StructurizeAndPersistError };

/**
 * Look up the CV, run structurize + categorise on the platform provider,
 * persist the merged result, and return what was written. Shared by the
 * /api/cv/[id]/structurize POST route and the review page's silent
 * stale-version refresh.
 *
 * There is no provider argument: BYOK is gone (D20), so the provider is
 * whatever the admin has active in platform_ai_settings. The old
 * `preferredAiProvider` parameter selected among a user's own keys and had
 * nothing left to select from.
 */
export async function structurizeAndPersist(
  userId: string,
  cvId:   string,
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

  // Platform-wide provider (platform_ai_settings), NOT a per-user BYOK key.
  // This function used to read `user_integrations` for an AI provider, which
  // was correct until BYOK was removed on 2026-06-16 (decision D20). Every
  // other AI path moved to getActiveAiCredentials() then; this one was
  // missed, so it looked for a row no account has had since — meaning CV
  // structurization failed with "No AI key connected. Add one in Settings →
  // Integrations." for EVERY user, pointing at a screen that no longer
  // offers AI keys. It also silently blocked skill categorisation, which is
  // what runs straight after a CV upload.
  const creds = await getActiveAiCredentials();
  if (!creds) return { ok: false, error: { kind: "no_ai_key" } };

  const chosen = creds.provider;
  const apiKey = creds.apiKey;
  const k = { config: { model: creds.model } };

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
