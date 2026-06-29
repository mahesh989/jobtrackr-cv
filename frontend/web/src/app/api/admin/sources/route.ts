/**
 * /api/admin/sources
 *
 * Founder/admin-only management of per-subscription-tier job-source config
 * (migration 064 — platform_source_tiers). Whatever the admin sets for each
 * tier applies to every user on that plan during their pipeline runs.
 *
 * GET  → returns { weekly, monthly, unlimited } tier configs
 * PATCH → body: { tier, enabled_sources?, adzuna_method?, seek_method? }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

const VALID_SOURCES = ["adzuna", "seek", "careerjet", "greenhouse", "lever", "agedcare"] as const;
type Source = (typeof VALID_SOURCES)[number];
type Tier   = "weekly" | "monthly" | "unlimited";

const TIER_DEFAULTS: Record<Tier, { enabled_sources: string[]; adzuna_method: string; seek_method: string }> = {
  weekly:    { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  monthly:   { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  unlimited: { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
};

async function requireAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: me } = await admin.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) return null;
  return { userId: user.id, admin };
}

export async function GET() {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: rows } = await ctx.admin
    .from("platform_source_tiers")
    .select("tier, enabled_sources, adzuna_method, seek_method");

  const result: Record<string, unknown> = { ...TIER_DEFAULTS };
  for (const row of (rows ?? []) as Array<{ tier: string; enabled_sources: string[] | null; adzuna_method: string | null; seek_method: string | null }>) {
    const def = TIER_DEFAULTS[row.tier as Tier] ?? TIER_DEFAULTS.weekly;
    result[row.tier] = {
      enabled_sources: row.enabled_sources ?? def.enabled_sources,
      adzuna_method:   row.adzuna_method   ?? def.adzuna_method,
      seek_method:     row.seek_method     ?? def.seek_method,
    };
  }
  return NextResponse.json(result);
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { tier?: unknown; enabled_sources?: unknown; adzuna_method?: unknown; seek_method?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const tier = body?.tier;
  if (tier !== "weekly" && tier !== "monthly" && tier !== "unlimited") {
    return NextResponse.json({ error: "tier must be weekly, monthly, or unlimited" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: ctx.userId,
  };

  if (Array.isArray(body.enabled_sources)) {
    const cleaned = body.enabled_sources.filter(
      (s): s is Source => typeof s === "string" && (VALID_SOURCES as readonly string[]).includes(s),
    );
    update.enabled_sources = Array.from(new Set(cleaned));
  }
  if (body.adzuna_method === "api" || body.adzuna_method === "direct") update.adzuna_method = body.adzuna_method;
  if (body.seek_method === "direct" || body.seek_method === "actor")   update.seek_method   = body.seek_method;

  const { data, error } = await ctx.admin
    .from("platform_source_tiers")
    .upsert({ tier, ...update }, { onConflict: "tier" })
    .select("tier, enabled_sources, adzuna_method, seek_method")
    .single();

  if (error) {
    console.error("[/api/admin/sources PATCH] update failed:", error.message);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
  return NextResponse.json(data);
}
