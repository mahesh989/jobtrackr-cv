/**
 * POST /api/company-research/facts/select
 *
 * Deterministic fact selection for a job. Resolves company_id, JD text, and
 * CV text server-side from the provided job_id — callers do not need to
 * supply these directly.
 *
 * Request body: { job_id: string }
 *
 * Resolution order:
 *   company_id  — jobs.company → slug (same algorithm as /api/company-research)
 *   jd_text     — jobs.manual_jd_text → latest completed analysis_run.jd_text → 422
 *   cv_text     — cv_versions where is_active = true → 422 if absent
 *
 * Responses:
 *   200  { ranked_facts: RankedFact[], company_id: string }
 *   400  Missing job_id
 *   401  Unauthorized
 *   404  Job not found / not owned / no company research found
 *   422  No company set on job / no JD text / no active CV
 *   502  cv-backend call failed
 *   500  DB error
 *
 * No AI key resolution needed — select-company-fact is deterministic.
 */

import { NextRequest, NextResponse }         from "next/server";
import { createClient }                      from "@/lib/supabase/server";
import { createAdminClient }                 from "@/lib/supabase/admin";
import { selectCompanyFact, CvBackendError } from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 30;

const JD_MIN_CHARS = 50;

export async function POST(req: NextRequest) {
  // ── 1. Verify session ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { job_id?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) {
    return NextResponse.json({ error: "job_id is required." }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── 3. Ownership check (job → search_profile → user) ─────────────────────────
  // Service-role bypasses RLS so this manual ownership check is required.
  // location is selected so we can pass it through to cv-backend for the
  // geographic mismatch filter (defends against same-name org conflations).
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, company, manual_jd_text, location")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();

  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  // ── 4. Resolve company_id from jobs.company ───────────────────────────────────
  const companyRaw = (job.company as string | null)?.trim() ?? "";
  if (!companyRaw) {
    return NextResponse.json(
      { error: "No company set for this job. Edit the job to add a company name." },
      { status: 422 },
    );
  }

  // Must match make_company_slug() in cv-backend and /api/company-research.
  const companyId = companyRaw
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    .replace(/_+$/, "") || "unknown_company";

  // ── 5. Resolve JD text ────────────────────────────────────────────────────────
  let jdText: string | null = null;
  const manualJd = (job.manual_jd_text as string | null)?.trim() ?? "";
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

    const runJd = (run?.jd_text as string | null)?.trim() ?? "";
    if (runJd.length >= JD_MIN_CHARS) jdText = runJd;
  }

  if (!jdText) {
    return NextResponse.json(
      { error: "No JD text available for this job. Analyse the job first or add a manual JD." },
      { status: 422 },
    );
  }

  // ── 6. Fetch active CV text ───────────────────────────────────────────────────
  const { data: cv, error: cvErr } = await admin
    .from("cv_versions")
    .select("cv_text")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (cvErr || !cv?.cv_text) {
    return NextResponse.json(
      { error: "No active CV found. Upload a CV first." },
      { status: 422 },
    );
  }

  // ── 7. Fetch company facts ────────────────────────────────────────────────────
  const { data: row, error: factsErr } = await admin
    .from("company_research")
    .select("facts")
    .eq("company_id", companyId)
    .maybeSingle();

  if (factsErr) {
    console.error("[/api/company-research/facts/select] lookup error:", factsErr.message);
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  if (!row?.facts) {
    return NextResponse.json(
      { error: `No research found for '${companyRaw}'. Run POST /api/company-research first.` },
      { status: 404 },
    );
  }

  // ── 8. Call cv-backend /internal/select-company-fact ─────────────────────────
  try {
    const jobLocation = (job.location as string | null)?.trim() || null;
    const result = await selectCompanyFact({
      company_id:  companyId,
      facts:       row.facts,
      jd_text:     jdText,
      cv_text:     cv.cv_text,
      jd_location: jobLocation,
    });

    return NextResponse.json({ ranked_facts: result.ranked_facts, company_id: companyId });
  } catch (err) {
    console.error(
      "[/api/company-research/facts/select] cv-backend error:",
      err instanceof CvBackendError ? err.status : (err as Error).message,
    );
    return NextResponse.json(
      { error: "Fact selection failed. Please try again." },
      { status: 502 },
    );
  }
}
