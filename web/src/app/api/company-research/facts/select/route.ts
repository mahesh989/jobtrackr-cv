/**
 * POST /api/company-research/facts/select
 *
 * Deterministic fact selection: given a company_id, JD text, and CV text,
 * returns the company's facts ranked by keyword overlap with the query.
 * No AI call — purely deterministic via cv-backend /internal/select-company-fact.
 *
 * Request body: { company_id: string, jd_text: string, cv_text: string }
 *
 * Responses:
 *   200  { ranked_facts: RankedFact[] }
 *   401  Unauthorized
 *   404  No research found for company_id
 *   422  Missing required fields
 *   502  cv-backend call failed
 *   500  DB error
 *
 * No AI key resolution needed — the select-company-fact endpoint is
 * deterministic and makes no AI calls.
 */

import { NextRequest, NextResponse }         from "next/server";
import { createClient }                      from "@/lib/supabase/server";
import { createAdminClient }                 from "@/lib/supabase/admin";
import { selectCompanyFact, CvBackendError } from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // ── 1. Verify session ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { company_id?: string; jd_text?: string; cv_text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { company_id, jd_text, cv_text } = body;
  if (!company_id || !jd_text || !cv_text) {
    return NextResponse.json(
      { error: "company_id, jd_text, and cv_text are required." },
      { status: 422 },
    );
  }

  // ── 3. Fetch company facts from Supabase ──────────────────────────────────────
  const admin = createAdminClient();

  const { data: row, error: lookupErr } = await admin
    .from("company_research")
    .select("facts")
    .eq("company_id", company_id)
    .maybeSingle();

  if (lookupErr) {
    console.error("[/api/company-research/facts/select] lookup error:", lookupErr.message);
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  if (!row?.facts) {
    return NextResponse.json(
      { error: `No research found for company_id '${company_id}'. Run POST /api/company-research first.` },
      { status: 404 },
    );
  }

  // ── 4. Call cv-backend /internal/select-company-fact ─────────────────────────
  try {
    const result = await selectCompanyFact({
      company_id,
      facts:    row.facts,
      jd_text,
      cv_text,
    });

    return NextResponse.json({ ranked_facts: result.ranked_facts });
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
