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
import { withAdmin, parseJsonBody } from "@/lib/api-utils";
import { JOB_SOURCES, TIER_DEFAULTS } from "@/lib/constants";
import type { JobSource, SourceTier } from "@/lib/constants";

type Tier = SourceTier;

export const GET = withAdmin(async (_req: NextRequest, _ctx, { admin }) => {

  const { data: rows } = await admin
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
});

export const PATCH = withAdmin(async (req: NextRequest, _ctx, { userId, admin }) => {

  const { data: body, error: parseErr } = await parseJsonBody<{
    tier?: unknown; enabled_sources?: unknown; adzuna_method?: unknown; seek_method?: unknown;
  }>(req);
  if (parseErr) return parseErr;

  const tier = body!.tier;
  if (tier !== "weekly" && tier !== "monthly" && tier !== "unlimited") {
    return NextResponse.json({ error: "tier must be weekly, monthly, or unlimited" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };

  if (Array.isArray(body!.enabled_sources)) {
    const cleaned = body!.enabled_sources.filter(
      (s): s is JobSource => typeof s === "string" && (JOB_SOURCES as readonly string[]).includes(s),
    );
    update.enabled_sources = Array.from(new Set(cleaned));
  }
  if (body!.adzuna_method === "api" || body!.adzuna_method === "direct") update.adzuna_method = body!.adzuna_method;
  if (body!.seek_method === "direct" || body!.seek_method === "actor")   update.seek_method   = body!.seek_method;

  const { data, error } = await admin
    .from("platform_source_tiers")
    .upsert({ tier, ...update }, { onConflict: "tier" })
    .select("tier, enabled_sources, adzuna_method, seek_method")
    .single();

  if (error) {
    console.error("[/api/admin/sources PATCH] update failed:", error.message);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
  return NextResponse.json(data);
});
