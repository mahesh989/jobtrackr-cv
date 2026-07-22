/**
 * GET  /api/company-research/[company_id]   — read cached research
 * POST /api/company-research/[company_id]   — force refresh regardless of TTL
 *
 * GET responses:
 *   200  { research: CompanyResearch }
 *   401  Unauthorized
 *   404  No research found for this company_id
 *   500  DB error
 *
 * POST (force refresh) delegates to POST /api/company-research with the same
 * company_name derived from the existing row, bypassing the TTL check.
 * The POST body may optionally include { company_domain?: string } to provide
 * a domain hint for the refresh.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { researchCompany, CvBackendError } from "@/lib/cv/backend";
import { rateLimit, RATE_LIMIT_MESSAGE }    from "@/lib/rateLimit";
import { withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 120;

// ── GET — return cached row ────────────────────────────────────────────────────

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ company_id: string }> },
) => {

  const { company_id } = await params;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("company_research")
    .select("*")
    .eq("company_id", company_id)
    .maybeSingle();

  if (error) {
    console.error("[/api/company-research/[company_id]] GET error:", error.message);
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json({ research: data });
});

// ── POST — force refresh ───────────────────────────────────────────────────────

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ company_id: string }> }, { user }) => {

  // Rate limit: force-refresh re-runs Tavily + AI + an outbound homepage fetch.
  const rl = await rateLimit(`company-research:${user.id}`, 15, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const { company_id } = await params;
  const admin = createAdminClient();

  // ── 1. Fetch existing row to get the canonical name ───────────────────────────
  const { data: existing, error: lookupErr } = await admin
    .from("company_research")
    .select("name, domain")
    .eq("company_id", company_id)
    .maybeSingle();

  if (lookupErr) {
    console.error("[/api/company-research/[company_id]] lookup error:", lookupErr.message);
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  if (!existing) {
    return NextResponse.json(
      { error: "No existing research found. Use POST /api/company-research to trigger initial research." },
      { status: 404 },
    );
  }

  // ── 2. Optional overrides from body (domain hint + JD location hint) ─────────
  let domainOverride: string | null = existing.domain ?? null;
  let jdLocation:     string | null = null;
  try {
    const body = await req.json();
    if (body?.company_domain) domainOverride = body.company_domain;
    if (body?.jd_location)    jdLocation     = String(body.jd_location).trim() || null;
  } catch { /* body is optional */ }

  // Recover JD location from the user's most recent matching job when not
  // supplied. Mirrors the auto-lookup in POST /api/company-research.
  if (!jdLocation) {
    const { data: matchedJob } = await admin
      .from("jobs")
      .select("location, profile_id, created_at, search_profiles!inner(user_id)")
      .ilike("company", existing.name)
      .eq("search_profiles.user_id", user.id)
      .not("location", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const loc = (matchedJob?.location as string | null)?.trim() ?? "";
    if (loc) jdLocation = loc;
  }

  // ── 3. Resolve platform AI provider/key/model ─────────────────────────────────
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;

  // ── 4. Research + upsert ──────────────────────────────────────────────────────
  try {
    const result = await researchCompany({
      company_name:   existing.name,
      company_domain: domainOverride,
      jd_location:    jdLocation,
      ai_provider:    chosen,
      ai_api_key:     aiApiKey,
      ai_model:       creds.model ?? null,
    });

    if (result.research) {
      await admin
        .from("company_research")
        .upsert(result.research, { onConflict: "company_id" });
    }

    return NextResponse.json({ status: "completed", research: result.research });
  } catch (err) {
    console.error(
      "[/api/company-research/[company_id]] refresh error:",
      err instanceof CvBackendError ? err.status : (err as Error).message,
    );
    return NextResponse.json({ error: "Refresh failed." }, { status: 502 });
  }
});
