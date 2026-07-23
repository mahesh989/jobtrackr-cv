/**
 * Cover-letter generation orchestration — the full business logic behind
 * POST /api/jobs/[id]/cover-letter, extracted verbatim from the route
 * (2026-07-23 audit batch 5) so the route stays a thin auth/param shell.
 *
 * Flow: gates (final-ATS unless overridden) → prerequisites (CV, voice,
 * stories, JD) → idempotency (non-stale letter reuse) → billing reserve →
 * story match + company research → opening variants ('picking') or direct
 * generation trigger on cv-backend.
 */

import { NextRequest, NextResponse }                      from "next/server";
import { createAdminClient }                               from "@/lib/supabase/admin";
import { getActiveAiCredentials }                          from "@/lib/ai/activeProvider";
import { MIN_FINAL_ATS }                                   from "@/lib/atsThresholds";
import {
  generateOpeningVariants,
  matchStories,
  CvBackendError,
  MatchStoriesStory,
  OpeningVariant,
} from "@/lib/cv/backend";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { consumeCoverLetter, linkUsageEvent, releaseUsageEvent } from "@/lib/billing/entitlements";
import type { ToneTarget } from "@/lib/types";
import { jsonError } from "@/lib/api-utils";

import type { User } from "@supabase/supabase-js";

const JD_MIN_CHARS = 50;

/** Replicate make_company_slug() from backend/api/app/services/company/slug.py */
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


/** Everything after auth + param resolution. Returns the route response. */
export async function startCoverLetter(
  req: NextRequest,
  jobId: string,
  user: User,
): Promise<Response> {

  // ── Phase D-2 final-gate override ──────────────────────────────────────────
  // ?override=final_gate  — bypass passed_final_gate check (user clicked
  //                         "Generate cover letter anyway" on a low-scoring run)
  // ?override=all         — bypass every gate (currently only final_gate
  //                         exists on this route — initial_gate fires earlier)
  const overrideRaw = req.nextUrl.searchParams.get("override");
  const override =
    overrideRaw === "final_gate" || overrideRaw === "all"
      ? (overrideRaw as "final_gate" | "all")
      : null;

  // ── 1. Auth ───────────────────────────────────────────────────────────────────

  // Rate limit: opening-variant generation is a synchronous multi-call AI step.
  const rl = await rateLimit(`cover-letter:${user.id}`, 20, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { regenerate?: unknown; tone_target?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const regenerate  = body.regenerate === true;
  const toneRaw     = typeof body.tone_target === "string" ? body.tone_target : "professional";
  const toneTarget  = (["professional", "warm", "direct"] as const).includes(
    toneRaw as ToneTarget,
  ) ? toneRaw as ToneTarget : "professional";

  const admin = createAdminClient();

  // ── 3. Fetch job (ownership chain: job → search_profile → user) ───────────────
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, manual_jd_text, description")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return jsonError("Job not found", 404);

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();

  if (!profile || profile.user_id !== user.id) {
    return jsonError("Job not found", 404);
  }

  // ── 3.5. Phase D-2 final-ATS gate ─────────────────────────────────────────────
  // Mirrors the C-3 initial-gate pattern (on /analyze) but for the
  // cover-letter call. Reads passed_final_gate from the latest non-stale
  // analysis_run. When the gate failed and no override flag is set, blocks
  // with a 422 the UI converts into an inline "Generate anyway" prompt.
  //
  // Why on the web side and not cv-backend: the gate decision is a cheap
  // boolean read + an early-return. Doing it here means we never spend the
  // ~5-15 s synchronous variants AI call on a job the user's own threshold
  // would have rejected. cv-backend stays oblivious to this gate.
  //
  // No-analysis case: passed_final_gate is null when no analysis_run exists
  // (or it ran pre-Phase-C-2 before the column was written). We intentionally
  // do NOT block in that case — the user might be drafting without a prior
  // analysis. The strict `=== false` check only fires when the gate has
  // actually been evaluated and failed.
  if (!override) {
    const { data: latestRun } = await admin
      .from("analysis_runs")
      .select("tailored_match_score, passed_final_gate")
      .eq("job_id", jobId)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestRun?.passed_final_gate === false) {
      // Global threshold since migration 041 — see lib/atsThresholds.
      const threshold      = MIN_FINAL_ATS;
      const tailoredScore  = latestRun.tailored_match_score as number | null;
      return NextResponse.json(
        {
          error:
            `Tailored CV scored ${tailoredScore ?? "—"}, below the final-ATS threshold of ${threshold}. ` +
            `A cover letter built on a low tailored score rarely wins interviews. Generate anyway?`,
          action:         "below_final_gate",
          tailored_score: tailoredScore,
          threshold,
        },
        { status: 422 },
      );
    }
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

  // ── 5. Parallel: active CV + voice profile + idempotency check ────────────────
  const [
    { data: cvRow },
    { data: voiceRow },
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
  // Cached returns must NOT consume a cover-letter credit.
  if (existingLetter && !regenerate) {
    return NextResponse.json({ letter_id: existingLetter.id, status: "cached" });
  }

  // ── 6b. Billing gate — reserve a cover-letter credit ──────────────────────────
  // Placed after the idempotency check (so cached returns are free) and before
  // the expensive AI variant generation (so an over-cap user is blocked early).
  // The reservation is a pending usage_event; it is committed by a DB trigger
  // when the letter reaches status 'completed', voided on 'failed', and released
  // here on any early-return path before the cover_letters row exists.
  const clGate = await consumeCoverLetter(user.id, jobId);
  if (!clGate.allowed) {
    return NextResponse.json(
      { error: "Cover-letter limit reached", reason: clGate.reason, action: "upgrade" },
      { status: 402 },
    );
  }
  const usageEventId = clGate.eventId;
  const release = async () => { if (usageEventId) await releaseUsageEvent(usageEventId); };

  // Mark previous letter stale if regenerating
  if (existingLetter && regenerate) {
    await admin
      .from("cover_letters")
      .update({ is_stale: true })
      .eq("id", existingLetter.id);
  }

  // ── 7. Resolve platform AI provider/key/model ─────────────────────────────────
  const creds = await getActiveAiCredentials();
  if (!creds) {
    await release();
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;

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

  // No stories is NOT a blocker — cv-backend accepts story: null and the
  // letter draws its substance from the CV text instead (format_story
  // renders "(none available)"). Duty-based CVs often yield zero stories;
  // their cover letters must still generate.

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
    await release();
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
    ai_model:          creds.model ?? undefined,
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
    await release();
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
    await release();
    return jsonError("Failed to create cover letter record.", 500);
  }

  const letterId = letterRow.id as string;

  // Link the pending reservation to the letter row so the cover_letters status
  // trigger can commit (status 'completed') or void (status 'failed') it.
  if (usageEventId) await linkUsageEvent(usageEventId, letterId);

  return NextResponse.json({ letter_id: letterId, status: "picking", variants });
}
