/**
 * GET /api/user/stories
 *
 * Return the current story batch for the authenticated user. "Current batch"
 * is the set of stories sharing the most-recent extraction_timestamp.
 *
 * Uses a two-query pattern:
 *   1. Fetch MAX(extraction_timestamp) for the user.
 *   2. Fetch all stories matching that timestamp, ordered by created_at ASC
 *      (preserves the order returned by the extraction model).
 *
 * Returns { stories: StoredStory[], count: number }. Returns an empty array
 * if the user has never run story extraction.
 *
 * Responses:
 *   200  { stories, count }
 *   401  Unauthorized
 *   500  DB error
 */

import { NextResponse }      from "next/server";
import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // ── Query 1: find the max extraction_timestamp ────────────────────────────
  const { data: tsRow, error: tsErr } = await admin
    .from("stories")
    .select("extraction_timestamp")
    .eq("user_id", user.id)
    .order("extraction_timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tsErr) {
    console.error("[GET /api/user/stories] timestamp query failed:", tsErr.message);
    return NextResponse.json({ error: "Failed to fetch stories." }, { status: 500 });
  }

  // No stories extracted yet — not an error.
  if (!tsRow) {
    return NextResponse.json({ stories: [], count: 0 });
  }

  // ── Query 2: fetch the full batch at that timestamp ───────────────────────
  const { data: stories, error: batchErr } = await admin
    .from("stories")
    .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
    .eq("user_id", user.id)
    .eq("extraction_timestamp", tsRow.extraction_timestamp)
    .order("created_at", { ascending: true });

  if (batchErr) {
    console.error("[GET /api/user/stories] batch query failed:", batchErr.message);
    return NextResponse.json({ error: "Failed to fetch stories." }, { status: 500 });
  }

  return NextResponse.json({ stories: stories ?? [], count: (stories ?? []).length });
}
