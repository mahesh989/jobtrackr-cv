/**
 * POST /api/company-research
 *
 * Trigger company research for a given company name. Returns cached data
 * immediately if fresh (< research_ttl_days old). Runs research synchronously
 * and writes the result to the company_research table if stale or absent.
 *
 * Request body: { company_name: string, company_domain?: string }
 *
 * Responses:
 *   200  { status: "cached" | "completed", research: CompanyResearch }
 *   401  Unauthorized
 *   422  Missing company_name / no AI key configured
 *   502  cv-backend research failed
 *   500  DB error
 *
 * The triggering user's BYOK AI key is used for the distillation call only.
 * The company_research row is global (no user_id) — written once, reused by all.
 */

import { NextRequest, NextResponse }                   from "next/server";
import { createClient }                                from "@/lib/supabase/server";
import { createAdminClient }                           from "@/lib/supabase/admin";
import { decryptApiKey }                               from "@/lib/integrations/crypto";
import { researchCompany, CompanyResearch, CvBackendError } from "@/lib/cvBackend";
import { rateLimit, RATE_LIMIT_MESSAGE }                from "@/lib/rateLimit";

export const runtime     = "nodejs";
export const maxDuration = 120;  // Tavily + scrape + AI distill

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type  Provider          = (typeof PROVIDER_PRIORITY)[number];

export async function POST(req: NextRequest) {
  // ── 1. Init supabase client ───────────────────────────────────────────────────
  const supabase = await createClient();

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { company_name?: string; company_domain?: string; jd_location?: string; provider?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const companyName = body.company_name?.trim();
  if (!companyName) {
    return NextResponse.json(
      { error: "company_name is required." },
      { status: 422 },
    );
  }
  // Caller-supplied location takes priority; otherwise we look one up
  // server-side from any matching job below (see step 4b).
  let jdLocation: string | null = body.jd_location?.trim() || null;

  // ── 3. Compute slug ───────────────────────────────────────────────────────────
  // Slug must match make_company_slug() in cv-backend exactly.
  const companyId = companyName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    .replace(/_+$/, "") || "unknown_company";

  const admin = createAdminClient();

  // ── 4. Parallel: auth check + cache lookup ────────────────────────────────────
  // Slug is known at this point so both calls can fire concurrently — saves one
  // full network roundtrip on every cache hit.
  const [{ data: { user } }, { data: existing, error: lookupErr }] = await Promise.all([
    supabase.auth.getUser(),
    admin.from("company_research").select("*").eq("company_id", companyId).maybeSingle(),
  ]);

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: company research spends the system Tavily key + an AI call and
  // triggers an outbound homepage fetch — cap per-user request volume.
  const rl = await rateLimit(`company-research:${user.id}`, 15, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  if (lookupErr) {
    console.error("[/api/company-research] lookup error:", lookupErr.message);
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  if (existing) {
    const lastResearched = new Date(existing.last_researched_at).getTime();
    const ageSeconds     = (Date.now() - lastResearched) / 1000;
    const ttl            = (existing.research_ttl_days ?? 90) * 24 * 60 * 60;

    if (ageSeconds < ttl) {
      return NextResponse.json({ status: "cached", research: existing });
    }
  }

  // ── 5. Resolve AI key ─────────────────────────────────────────────────────────
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, status, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keys ?? []) as Array<{
    provider:          Provider;
    encrypted_api_key: string;
    config:            { model?: string } | null;
  }>) {
    keyByProvider.set(row.provider, {
      encrypted: row.encrypted_api_key,
      model:     row.config?.model ?? null,
    });
  }

  const preferredProvider = (body.provider && PROVIDER_PRIORITY.includes(body.provider as Provider))
    ? (body.provider as Provider)
    : null;

  const chosen = (preferredProvider && keyByProvider.has(preferredProvider))
    ? preferredProvider
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

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
  } catch (err) {
    console.error("[/api/company-research] decrypt failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Could not decrypt your AI key. Re-connect it in Settings → Integrations." },
      { status: 500 },
    );
  }

  // ── 5a. Auto-lookup jd_location from a matching job when caller didn't supply ─
  // Cover-letter UI flow passes only { company_name }; we recover the JD's
  // location from the user's most-recent matching job so cv-backend's
  // geographic disambiguation gates can activate. Best-effort; missing
  // location is benign — backend falls back to legacy naive search.
  if (!jdLocation) {
    const { data: matchedJob } = await admin
      .from("jobs")
      .select("location, profile_id, created_at, search_profiles!inner(user_id)")
      .ilike("company", companyName)
      .eq("search_profiles.user_id", user.id)
      .not("location", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const loc = (matchedJob?.location as string | null)?.trim() ?? "";
    if (loc) jdLocation = loc;
  }

  // ── 5b. Call cv-backend ────────────────────────────────────────────────────────
  let result: { company_id: string; status: string; research: CompanyResearch | null; search_skipped: boolean };
  try {
    result = await researchCompany({
      company_name:   companyName,
      company_domain: body.company_domain ?? null,
      jd_location:    jdLocation,
      ai_provider:    chosen,
      ai_api_key:     aiApiKey,
      ai_model:       entry.model ?? null,
    });
  } catch (err) {
    console.error(
      "[/api/company-research] cv-backend error:",
      err instanceof CvBackendError ? err.status : (err as Error).message,
    );
    return NextResponse.json(
      { error: "Company research failed. Please try again." },
      { status: 502 },
    );
  }

  if (!result.research) {
    return NextResponse.json(
      { error: "Research returned no data." },
      { status: 502 },
    );
  }

  // ── 6. Upsert to company_research table ──────────────────────────────────────
  // admin (service-role) bypasses RLS — consistent with all other cv-backend
  // write-back paths in this project.
  const { error: upsertErr } = await admin
    .from("company_research")
    .upsert(result.research, { onConflict: "company_id" });

  if (upsertErr) {
    console.error("[/api/company-research] upsert error:", upsertErr.message);
    // Research succeeded but write failed — return the data anyway so the
    // caller can still use it; log the failure for debugging.
    return NextResponse.json(
      { status: "completed", research: result.research, write_error: true },
      { status: 200 },
    );
  }

  return NextResponse.json({ status: "completed", research: result.research });
}
