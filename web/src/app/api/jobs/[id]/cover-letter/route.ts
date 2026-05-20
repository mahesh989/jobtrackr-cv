/**
 * POST /api/jobs/[id]/cover-letter
 *
 * Trigger single-call cover letter generation for a job. Returns 200 immediately
 * with { letter_id } — the cv-backend pipeline runs asynchronously and writes
 * progress to cover_letters via Supabase Realtime.
 *
 * Idempotent: if a non-stale cover_letters row already exists for (user, job),
 * returns the existing letter_id unless { regenerate: true } is in the body.
 *
 * Request body (all optional):
 *   { regenerate?: boolean, tone_target?: "professional" | "warm" | "direct", provider?: string }
 *
 * Prerequisites (422 if missing):
 *   - Active CV with extracted cv_text
 *   - Voice profile with fingerprint + voice_sample_raw
 *   - At least one story extracted
 *   - JD text available (manual_jd_text or latest analysis_run)
 *   - At least one valid AI key
 *
 * NOTE: voice_sample_raw is fetched via admin client and forwarded to cv-backend
 * in the signed payload. It must never appear in response bodies or logs.
 *
 * Responses:
 *   200  { letter_id, status: "cached" | "generating" }
 *   400  Invalid body
 *   401  Unauthorized
 *   404  Job not found or not owned by user
 *   422  Missing prerequisite (details in error field)
 *   500  DB or internal error
 *   502  cv-backend trigger failed
 */

import { NextRequest, NextResponse }                      from "next/server";
import { createClient }                                    from "@/lib/supabase/server";
import { createAdminClient }                               from "@/lib/supabase/admin";
import { decryptApiKey }                                   from "@/lib/integrations/crypto";
import {
  generateCoverLetter,
  generateOpeningVariants,
  matchStories,
  CvBackendError,
  MatchStoriesStory,
  OpeningVariant,
} from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 60;  // generateOpeningVariants is synchronous (~5-15 s); allow headroom

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type  Provider          = (typeof PROVIDER_PRIORITY)[number];

const JD_MIN_CHARS = 50;

/** Replicate make_company_slug() from cv-backend/app/services/company/slug.py */
function makeCompanySlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80)
      .replace(/_+$/, "") || "unknown_company"
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params;

  // ── 1. Auth ───────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { regenerate?: unknown; tone_target?: unknown; provider?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const regenerate  = body.regenerate === true;
  const toneRaw     = typeof body.tone_target === "string" ? body.tone_target : "professional";
  const toneTarget  = (["professional", "warm", "direct"] as const).includes(
    toneRaw as "professional" | "warm" | "direct",
  ) ? toneRaw as "professional" | "warm" | "direct" : "professional";

  const admin = createAdminClient();

  // ── 3. Fetch job (ownership chain: job → search_profile → user) ───────────────
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, manual_jd_text, description")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();

  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // ── 4. Resolve JD text ────────────────────────────────────────────────────────
  let jdText: string | null = null;
  const manualJd = (job.manual_jd_text ?? "").trim();
  if (manualJd.length >= JD_MIN_CHARS) {
    jdText = manualJd;
  } else {
    const { data: run } = await admin
      .from("analysis_runs")
      .select("jd_text")
      .eq("job_id", jobId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const runJd = (run?.jd_text ?? "").trim();
    if (runJd.length >= JD_MIN_CHARS) jdText = runJd;
  }

  if (!jdText) {
    return NextResponse.json(
      { error: "No JD text available. Analyse the job first or add a manual JD." },
      { status: 422 },
    );
  }

  // ── 5. Parallel: active CV + voice profile + AI keys + idempotency check ──────
  const [
    { data: cvRow },
    { data: voiceRow },
    { data: keyRows },
    { data: existingLetter },
  ] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, cv_text")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle(),

    // voice_sample_raw: fetched via admin client only — never returned to client
    admin
      .from("voice_profiles")
      .select("fingerprint, voice_sample_raw")
      .eq("user_id", user.id)
      .maybeSingle(),

    admin
      .from("user_integrations")
      .select("provider, encrypted_api_key, status, config")
      .eq("user_id", user.id)
      .eq("status", "valid")
      .eq("is_enabled", true)
      .in("provider", PROVIDER_PRIORITY as unknown as string[]),

    admin
      .from("cover_letters")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!cvRow?.cv_text) {
    return NextResponse.json(
      { error: "No active CV with extracted text found. Upload and activate a CV first." },
      { status: 422 },
    );
  }

  if (!voiceRow?.fingerprint || !voiceRow?.voice_sample_raw) {
    return NextResponse.json(
      { error: "Voice profile not found. Submit a writing sample on the My Voice page first." },
      { status: 422 },
    );
  }

  // ── 6. Idempotency — return cached if non-stale letter exists ─────────────────
  if (existingLetter && !regenerate) {
    return NextResponse.json({ letter_id: existingLetter.id, status: "cached" });
  }

  // Mark previous letter stale if regenerating
  if (existingLetter && regenerate) {
    await admin
      .from("cover_letters")
      .update({ is_stale: true })
      .eq("id", existingLetter.id);
  }

  // ── 7. Resolve AI key ─────────────────────────────────────────────────────────
  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keyRows ?? []) as Array<{
    provider: Provider; encrypted_api_key: string; config: { model?: string } | null;
  }>) {
    keyByProvider.set(row.provider, { encrypted: row.encrypted_api_key, model: row.config?.model ?? null });
  }

  const rawProvider = typeof body.provider === "string" ? body.provider : null;
  const preferred   = rawProvider && PROVIDER_PRIORITY.includes(rawProvider as Provider)
    ? rawProvider as Provider : null;
  const chosen      = (preferred && keyByProvider.has(preferred))
    ? preferred : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key configured. Add one in Settings → Integrations." },
      { status: 422 },
    );
  }

  const entry = keyByProvider.get(chosen)!;
  let aiApiKey: string;
  try {
    aiApiKey = decryptApiKey(entry.encrypted);
  } catch {
    return NextResponse.json(
      { error: "Could not decrypt your AI key. Re-connect it in Settings." },
      { status: 500 },
    );
  }

  // ── 8. Fetch top-ranked story ─────────────────────────────────────────────────
  let topStory: Record<string, unknown> | null = null;
  let topStoryId: string | null = null;

  const { data: tsRow } = await admin
    .from("stories")
    .select("extraction_timestamp")
    .eq("user_id", user.id)
    .order("extraction_timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tsRow) {
    const { data: storyRows } = await admin
      .from("stories")
      .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
      .eq("user_id", user.id)
      .eq("extraction_timestamp", tsRow.extraction_timestamp);

    if (storyRows && storyRows.length > 0) {
      // Rank stories against JD; fall back to first story on cv-backend error
      try {
        const scored = await matchStories({
          jd_text: jdText,
          stories: storyRows.map((s) => ({
            id:                   s.id as string,
            title:                s.title as string,
            domain:               s.domain as string,
            year:                 (s.year ?? null) as number | null,
            one_line:             s.one_line as string,
            detailed:             s.detailed as string,
            numbers:              (s.numbers ?? []) as { metric: string; value: string }[],
            tags:                 (s.tags ?? []) as string[],
            extraction_timestamp: s.extraction_timestamp as string,
          } satisfies MatchStoriesStory)),
        });
        const bestId = scored.scored[0]?.story_id;
        const best   = storyRows.find((s) => s.id === bestId) ?? storyRows[0];
        topStory   = best as Record<string, unknown>;
        topStoryId = best.id as string;
      } catch {
        topStory   = storyRows[0] as Record<string, unknown>;
        topStoryId = storyRows[0].id as string;
      }
    }
  }

  if (!topStory) {
    return NextResponse.json(
      { error: "No stories extracted yet. Run story extraction on your CV first." },
      { status: 422 },
    );
  }

  // ── 9. Resolve company hook ───────────────────────────────────────────────────
  const companyName = (job.company ?? "").trim() || "the company";
  const companySlug = makeCompanySlug(companyName);

  // Fallback: extract first sentence from the JD that mentions the company by name.
  // This gives generation something specific even when company_research hasn't run
  // — used both as the fallback hook (defensive) and as the low-research fallback.
  function extractJdHook(jd: string, company: string): string {
    const sentences = jd.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
    const hit = sentences.find(
      (s) => s.length > 40 && s.toLowerCase().includes(company.toLowerCase()),
    );
    if (!hit) return `${company} is hiring for this role`;
    return stripJdHeaderPrefix(hit.trim(), company);
  }

  // Strip common JD section-header prefixes that bleed into the first sentence
  // when newlines collapse to spaces (e.g. "Job Description At Ampol, we...").
  // Only one header is stripped — if a sentence accidentally matches twice, that
  // is already pathological and a single strip is enough.
  function stripJdHeaderPrefix(s: string, company: string): string {
    const companyEsc = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const HEADER_PATTERNS = [
      /^Job Description\s+/i,
      /^About (?:Us|the (?:Company|Role|Position|Team))\s+/i,
      new RegExp(`^About ${companyEsc}\\s+`, "i"),
      /^The (?:Role|Position|Opportunity|Company)\s+/i,
      /^(?:Company |Position |Role |Job )?(?:Overview|Summary|Description)\s+/i,
    ];
    for (const re of HEADER_PATTERNS) {
      const m = s.match(re);
      if (m) return s.slice(m[0].length).trim();
    }
    return s;
  }

  // Phase 10.4 refactor: company research is a prerequisite for generation.
  // The architecture's quality ceiling for paragraph 2 is set by the company
  // hook, and a JD-derived hook is reliably weaker than a researched fact.
  // - No research row at all → block with a 422 the UI can act on.
  // - Research exists but has no usable facts → proceed, fall back to JD hook,
  //   and record a warning so the UI surfaces it next to the finished letter.
  const { data: companyResearch } = await admin
    .from("company_research")
    .select("facts")
    .eq("company_id", companySlug)
    .maybeSingle();

  if (!companyResearch) {
    return NextResponse.json(
      {
        error:
          `Company research has not been run for ${companyName}. ` +
          "Run it first to give paragraph 2 a real company fact to anchor on.",
        action:       "research_company",
        company_name: companyName,
      },
      { status: 422 },
    );
  }

  let companyHookText = "";
  let lowQualityResearch = false;

  if (companyResearch.facts) {
    const facts = companyResearch.facts as {
      distinguishing_facts?: string[];
      mission_statement?: string;
      description_short?: string;
    };
    const distinguishing = facts.distinguishing_facts;
    if (distinguishing && distinguishing.length > 0) {
      companyHookText = distinguishing[0];
    } else if (facts.mission_statement) {
      companyHookText = facts.mission_statement;
    } else if (facts.description_short) {
      companyHookText = facts.description_short;
    }
  }

  if (!companyHookText) {
    // Research exists but distillation produced nothing usable — fall back
    // to JD-derived hook and let the UI warn the user before they send.
    companyHookText  = extractJdHook(jdText, companyName);
    lowQualityResearch = true;
  }

  // ── 10. Generate opening variants (synchronous — ~5-15 s) ───────────────────
  // Phase 11: generate 3-4 P1 openers before creating the DB row.
  // Creating the row only after a successful variants call means a cv-backend
  // failure never leaves a stuck 'picking' row in the DB.
  // voice_sample_raw is forwarded in the signed payload and must not be logged.
  const variantsPayload = {
    user_id:           user.id,
    job_id:            jobId,
    jd_text:           jdText,
    role:              (job.title ?? "the role").trim(),
    company_name:      companyName,
    cv_text:           cvRow.cv_text as string,
    voice_sample_text: voiceRow.voice_sample_raw as string,
    fingerprint:       voiceRow.fingerprint as Record<string, unknown>,
    story:             topStory,
    company_hook_text: companyHookText,
    ai_provider:       chosen,
    ai_api_key:        aiApiKey,
    ai_model:          entry.model ?? undefined,
  };

  let variants: OpeningVariant[];
  try {
    const result = await generateOpeningVariants(variantsPayload);
    variants = result.variants;
  } catch (err) {
    console.error(
      "[POST /api/jobs/[id]/cover-letter] variants generation failed:",
      err instanceof CvBackendError ? `${err.status}: ${JSON.stringify(err.detail)}` : String(err),
    );
    return NextResponse.json(
      { error: "Could not generate opening options. Try again." },
      { status: 502 },
    );
  }

  // ── 11. Create cover_letters row (picking) ────────────────────────────────────
  // quality_flags pre-populated with web-layer warnings; cv-backend merges
  // its own honesty-gate flags on top at the end without clobbering these.
  const initialQualityFlags = lowQualityResearch
    ? { low_quality_company_research: true }
    : {};

  const { data: letterRow, error: insertErr } = await admin
    .from("cover_letters")
    .insert({
      user_id:           user.id,
      job_id:            jobId,
      status:            "picking",
      story_id:          topStoryId,
      company_hook_text: companyHookText,
      tone_target:       toneTarget,
      word_count_target: 170,
      ai_provider:       chosen,
      quality_flags:     initialQualityFlags,
      generation_status: { generate: "pending", honesty: "pending" },
      opening_variants:  variants,
    })
    .select("id")
    .single();

  if (insertErr || !letterRow) {
    console.error("[POST /api/jobs/[id]/cover-letter] insert failed:", insertErr?.message);
    return NextResponse.json({ error: "Failed to create cover letter record." }, { status: 500 });
  }

  const letterId = letterRow.id as string;

  return NextResponse.json({ letter_id: letterId, status: "picking", variants });
}
