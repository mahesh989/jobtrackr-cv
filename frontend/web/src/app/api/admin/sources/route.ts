/**
 * /api/admin/sources
 *
 * Founder/admin-only management of per-subscription-tier job-source config
 * (migration 064). Three tiers: weekly, monthly, unlimited. The orchestrator
 * resolves each user's plan → tier row at run time.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

const VALID_SOURCES = ["adzuna", "seek", "careerjet", "greenhouse", "lever"] as const;
type Source = (typeof VALID_SOURCES)[number];
type Tier   = "weekly" | "monthly" | "unlimited";
const VALID_TIERS: Tier[] = ["weekly", "monthly", "unlimited"];

async function requireAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: me } = await admin.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) return null;
  return { userId: user.id, admin };
}

const DEFAULTS: Record<Tier, { enabled_sources: Source[]; adzuna_method: "api" | "direct"; seek_method: "direct" | "actor" }> = {
  weekly:    { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  monthly:   { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  unlimited: { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
};

export async function GET() {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data } = await ctx.admin
    .from("platform_source_tiers")
    .select("tier, enabled_sources, adzuna_method, seek_method")
    .in("tier", VALID_TIERS)
    .order("tier");

  // Ensure all three tiers are always returned, falling back to defaults.
  const rows = (data ?? []) as { tier: Tier; enabled_sources: string[]; adzuna_method: string; seek_method: string }[];
  const result = VALID_TIERS.map((tier) => {
    const row = rows.find((r) => r.tier === tier);
    return row ?? { tier, ...DEFAULTS[tier] };
  });

  return NextResponse.json({ tiers: result });
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { tiers?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
    return NextResponse.json({ error: "tiers array required" }, { status: 400 });
  }

  const updates: { tier: Tier; enabled_sources?: Source[]; adzuna_method?: "api" | "direct"; seek_method?: "direct" | "actor"; updated_at: string; updated_by: string }[] = [];

  for (const item of body.tiers as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const t = (item as Record<string, unknown>).tier;
    if (typeof t !== "string" || !VALID_TIERS.includes(t as Tier)) continue;

    const update: (typeof updates)[number] = { tier: t as Tier, updated_at: new Date().toISOString(), updated_by: ctx.userId };

    const es = (item as Record<string, unknown>).enabled_sources;
    if (Array.isArray(es)) {
      update.enabled_sources = es.filter(
        (s): s is Source => typeof s === "string" && (VALID_SOURCES as readonly string[]).includes(s),
      );
    }
    const am = (item as Record<string, unknown>).adzuna_method;
    if (am === "api" || am === "direct") update.adzuna_method = am;

    const sm = (item as Record<string, unknown>).seek_method;
    if (sm === "direct" || sm === "actor") update.seek_method = sm;

    updates.push(update);
  }

  if (updates.length === 0) return NextResponse.json({ error: "No valid tier updates" }, { status: 400 });

  const { data, error } = await ctx.admin
    .from("platform_source_tiers")
    .upsert(updates, { onConflict: "tier" })
    .select("tier, enabled_sources, adzuna_method, seek_method");

  if (error) {
    console.error("[/api/admin/sources PATCH] upsert failed:", error.message);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
  return NextResponse.json({ tiers: data });
}
