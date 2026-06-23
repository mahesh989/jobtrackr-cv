/**
 * /api/admin/sources
 *
 * Founder/admin-only management of the single platform-wide job-source config
 * (migration 063). Whatever the admin enables here applies to every user's
 * pipeline run — source selection + per-source method moved off the per-profile
 * job-search form onto this global row.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

const VALID_SOURCES = ["adzuna", "seek", "careerjet", "greenhouse", "lever"] as const;
type Source = (typeof VALID_SOURCES)[number];

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

  const { data } = await ctx.admin
    .from("platform_sources")
    .select("enabled_sources, adzuna_method, seek_method")
    .eq("id", 1)
    .maybeSingle();

  return NextResponse.json(
    data ?? { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
  );
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { enabled_sources?: unknown; adzuna_method?: unknown; seek_method?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: ctx.userId };

  if (Array.isArray(body.enabled_sources)) {
    const cleaned = body.enabled_sources.filter(
      (s): s is Source => typeof s === "string" && (VALID_SOURCES as readonly string[]).includes(s),
    );
    update.enabled_sources = Array.from(new Set(cleaned));
  }
  if (body.adzuna_method === "api" || body.adzuna_method === "direct") update.adzuna_method = body.adzuna_method;
  if (body.seek_method === "direct" || body.seek_method === "actor")   update.seek_method   = body.seek_method;

  const { data, error } = await ctx.admin
    .from("platform_sources")
    .update(update)
    .eq("id", 1)
    .select("enabled_sources, adzuna_method, seek_method")
    .single();

  if (error) {
    console.error("[/api/admin/sources PATCH] update failed:", error.message);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
  return NextResponse.json(data);
}
