/**
 * POST /api/eval/run
 *
 * Founder-only. Trigger one or more (writer × scorer) eval variants on a pasted
 * CV + JD. Fans out to cv-backend /internal/analyze-eval once per variant; the
 * runs execute as background tasks. Returns the list of eval_run_ids so the
 * beta screen can poll each independently.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto                        from "node:crypto";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { decryptApiKey }             from "@/lib/integrations/crypto";
import { triggerEvalRun, CvBackendError } from "@/lib/cvBackend";
import { rateLimit, RATE_LIMIT_MESSAGE }   from "@/lib/rateLimit";

export const runtime     = "nodejs";
export const maxDuration = 30;          // fan-out is fast; eval runs in background

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

type Body = {
  jd_text:         string;
  jd_label?:       string;
  vertical?:       string;
  cv_version_id?:  string;
  cv_text?:        string;
  cv_source?:      string;
  writer_variants: string[];
  scorer_variant?: string;
  experiment_id?:  string;
  iteration?:      number;
  provider?:       Provider;
  ai_model?:       string;
};

export async function POST(req: NextRequest) {
  // ── 1. Auth + founder gate ───────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rl = await rateLimit(`eval:${user.id}`, 30, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  // ── 2. Parse + validate ─────────────────────────────────────────────────
  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const jdText = (body.jd_text ?? "").trim();
  if (jdText.length < 50) {
    return NextResponse.json({ error: "jd_text is empty or too short" }, { status: 422 });
  }
  const writers = Array.isArray(body.writer_variants) ? body.writer_variants.filter(Boolean) : [];
  if (writers.length === 0) {
    return NextResponse.json({ error: "writer_variants is empty" }, { status: 422 });
  }
  const scorerVariant = body.scorer_variant || "s1_current";

  const admin = createAdminClient();

  // ── 3. Resolve CV text — explicit paste wins, else cv_version_id ────────
  let cvText = (body.cv_text ?? "").trim();
  let cvSource = body.cv_source ?? null;
  if (!cvText) {
    const versionId = body.cv_version_id;
    if (versionId) {
      const { data: cvRow } = await admin
        .from("cv_versions")
        .select("id, cv_text, user_id, label")
        .eq("id", versionId)
        .maybeSingle();
      if (!cvRow || cvRow.user_id !== user.id) {
        return NextResponse.json({ error: "CV version not found" }, { status: 404 });
      }
      cvText = (cvRow.cv_text as string) ?? "";
      cvSource ??= (cvRow.label as string) ?? `cv:${versionId.slice(0, 8)}`;
    } else {
      // Fall back to the user's active CV.
      const { data: active } = await admin
        .from("cv_versions")
        .select("id, cv_text, label")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (active) {
        cvText = (active.cv_text as string) ?? "";
        cvSource ??= (active.label as string) ?? "active";
      }
    }
  } else {
    cvSource ??= "paste";
  }
  if (cvText.length < 50) {
    return NextResponse.json({ error: "Resolved CV text is empty" }, { status: 422 });
  }

  // ── 4. Resolve BYOK AI key (first available, like /api/jobs/:id/analyze) ─
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, status, config, is_enabled")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keys ?? []) as Array<{ provider: Provider; encrypted_api_key: string; config: { model?: string } | null }>) {
    keyByProvider.set(row.provider, {
      encrypted: row.encrypted_api_key,
      model:     row.config?.model ?? null,
    });
  }
  const chosen: Provider | undefined = body.provider && keyByProvider.has(body.provider)
    ? body.provider
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));
  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key configured. Add one in Settings → AI keys." },
      { status: 422 },
    );
  }
  const chosenEntry = keyByProvider.get(chosen)!;
  let aiApiKey: string;
  try { aiApiKey = decryptApiKey(chosenEntry.encrypted); }
  catch {
    return NextResponse.json(
      { error: "Could not decrypt AI key. Re-connect it in Settings → AI keys." },
      { status: 500 },
    );
  }
  const aiModel = body.ai_model ?? chosenEntry.model;

  // ── 5. Optional contact details for the contact-line stamp ──────────────
  const { data: prefRow } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const contactDetails = (prefRow?.contact_details ?? null) as Record<string, unknown> | null;
  const contactForBackend = contactDetails
    ? Object.fromEntries(Object.entries(contactDetails).filter(([k]) => k !== "projects"))
    : null;

  const experimentId = body.experiment_id || crypto.randomUUID();

  // ── 6. Fan out to cv-backend, one trigger per writer variant ────────────
  type Triggered = { writer_variant: string; eval_run_id?: string; error?: string };
  const triggers: Triggered[] = await Promise.all(
    writers.map(async (wv): Promise<Triggered> => {
      try {
        const r = await triggerEvalRun({
          cv_text:         cvText,
          jd_text:         jdText,
          writer_variant:  wv,
          scorer_variant:  scorerVariant,
          jd_label:        body.jd_label ?? null,
          vertical:        body.vertical ?? null,
          cv_source:       cvSource,
          experiment_id:   experimentId,
          iteration:       body.iteration ?? 1,
          contact_details: contactForBackend,
          ai_provider:     chosen,
          ai_api_key:      aiApiKey,
          ai_model:        aiModel,
        });
        return { writer_variant: wv, eval_run_id: r.eval_run_id };
      } catch (err) {
        const msg = err instanceof CvBackendError
          ? `cv-backend ${err.status}: ${typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)}`
          : err instanceof Error ? err.message : String(err);
        return { writer_variant: wv, error: msg };
      }
    }),
  );

  return NextResponse.json({
    experiment_id: experimentId,
    scorer_variant: scorerVariant,
    provider:      chosen,
    model:         aiModel,
    triggers,
  });
}
