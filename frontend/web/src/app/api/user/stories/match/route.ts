/**
 * POST /api/user/stories/match
 *
 * Rank the user's current story batch against a job's JD text. Returns stories
 * sorted by match_score descending (highest relevance first).
 *
 * Request body: { job_id: string }
 *
 * JD text resolution order:
 *   1. job.manual_jd_text if non-empty (user-edited version)
 *   2. Latest completed analysis_run.jd_text for this job
 *   3. 422 if neither is available
 *
 * Designed for the cover letter generation step (Phase 10.3) — called to
 * surface the most relevant story to use as the letter's narrative anchor.
 * Also used by the story library UI to show per-job relevance indicators.
 *
 * Responses:
 *   200  { stories: StoredStoryWithScore[], count: number }
 *   400  Missing job_id
 *   401  Unauthorized
 *   404  Job not found or not owned by user
 *   422  No JD text available / no stories extracted yet
 *   502  cv-backend call failed
 *   500  DB or internal error
 */

import { NextRequest, NextResponse }                       from "next/server";
import { createAdminClient }                               from "@/lib/supabase/admin";
import { matchStories, CvBackendError, MatchStoriesStory } from "@/lib/cv/backend";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 15;   // deterministic scoring — no AI call needed

const JD_MIN_CHARS = 50;  // below this, jd_text is not useful for matching

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {
  // ── 1. Verify session ────────────────────────────────────────────────────────

  // ── 2. Parse + validate body ─────────────────────────────────────────────────
  let body: { job_id?: unknown };
  try { body = await req.json(); }
  catch { return jsonError("Invalid JSON body", 400); }

  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) {
    return jsonError("job_id is required", 400);
  }

  const admin = createAdminClient();

  // ── 3. Ownership check (job → search_profile → user) ─────────────────────────
  // Service-role bypasses RLS so this manual check is non-optional.
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, manual_jd_text")
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

  // ── 4. Resolve JD text ────────────────────────────────────────────────────────
  // Priority: manual_jd_text → latest completed analysis_run.jd_text → 422.
  let jdText: string | null = null;

  const manualJd = job.manual_jd_text?.trim() ?? "";
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

    const runJd = run?.jd_text?.trim() ?? "";
    if (runJd.length >= JD_MIN_CHARS) jdText = runJd;
  }

  if (!jdText) {
    return NextResponse.json(
      { error: "No JD text available for this job. Analyse the job first or add a manual JD." },
      { status: 422 },
    );
  }

  // ── 5. Fetch current story batch (two-query pattern) ─────────────────────────
  const { data: tsRow } = await admin
    .from("stories")
    .select("extraction_timestamp")
    .eq("user_id", user.id)
    .order("extraction_timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!tsRow) {
    return NextResponse.json(
      { error: "No stories extracted yet. Run story extraction on your CV first." },
      { status: 422 },
    );
  }

  const { data: storyRows, error: batchErr } = await admin
    .from("stories")
    .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
    .eq("user_id", user.id)
    .eq("extraction_timestamp", tsRow.extraction_timestamp)
    .order("created_at", { ascending: true });

  if (batchErr || !storyRows) {
    console.error("[POST /api/user/stories/match] batch fetch failed:", batchErr?.message);
    return jsonError("Failed to fetch stories.", 500);
  }

  if (storyRows.length === 0) {
    return NextResponse.json(
      { error: "No stories extracted yet. Run story extraction on your CV first." },
      { status: 422 },
    );
  }

  // ── 6. Call cv-backend /internal/match-stories ────────────────────────────────
  const payload: { jd_text: string; stories: MatchStoriesStory[] } = {
    jd_text: jdText,
    stories: storyRows.map((s) => ({
      id:                   s.id as string,
      title:                s.title as string,
      domain:               s.domain as string,
      year:                 (s.year ?? null) as number | null,
      one_line:             s.one_line as string,
      tags:                 (s.tags ?? []) as string[],
      detailed:             s.detailed as string,
      numbers:              (s.numbers ?? []) as { metric: string; value: string }[],
      extraction_timestamp: s.extraction_timestamp as string,
    })),
  };

  let scored: { story_id: string; score: number }[];
  try {
    const result = await matchStories(payload);
    scored = result.scored;
  } catch (err) {
    console.error(
      "[POST /api/user/stories/match] cv-backend error:",
      err instanceof CvBackendError ? err.status : (err as Error).message,
    );
    return NextResponse.json(
      { error: "Story matching failed. Please try again." },
      { status: 502 },
    );
  }

  // ── 7. Merge scores back onto story rows, return sorted ───────────────────────
  const scoreMap = new Map(scored.map((s) => [s.story_id, s.score]));
  const withScores = storyRows
    .map((s) => ({ ...s, match_score: scoreMap.get(s.id as string) ?? 0 }))
    .sort((a, b) => b.match_score - a.match_score);

  return NextResponse.json({ stories: withScores, count: withScores.length });
});
