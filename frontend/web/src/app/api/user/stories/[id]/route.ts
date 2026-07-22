/**
 * PATCH /api/user/stories/[id]
 *
 * Update mutable fields on a single story row owned by the authenticated user.
 * Currently supports: tags (text[]), one_line (string).
 *
 * Constraints enforced here (mirroring the Pydantic schema in cv-backend):
 *   tags     — max 10 elements; each tag max 50 chars; must be string[]
 *   one_line — max 300 chars; must be non-empty string
 *
 * Ownership: stories.user_id is verified explicitly because service-role
 * bypasses RLS. A user can only patch their own stories.
 *
 * Responses:
 *   200  Updated story row (id, title, domain, year, one_line, tags, ...)
 *   400  Invalid JSON / no valid fields / constraint violation
 *   401  Unauthorized
 *   404  Story not found or not owned by user
 *   500  DB error
 */

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { withUser } from "@/lib/api-utils";

export const runtime = "nodejs";

const MAX_TAGS      = 10;
const MAX_TAG_CHARS = 50;
const MAX_ONE_LINE  = 300;

export const PATCH = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id: storyId } = await params;

  // ── 1. Verify session ────────────────────────────────────────────────────────

  // ── 2. Parse body ─────────────────────────────────────────────────────────────
  let body: { tags?: unknown; one_line?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const patch: Record<string, unknown> = {};

  if ("tags" in body) {
    const raw = body.tags;
    if (!Array.isArray(raw) || !raw.every((t) => typeof t === "string")) {
      return NextResponse.json({ error: "tags must be an array of strings" }, { status: 400 });
    }
    const tags = raw as string[];
    if (tags.length > MAX_TAGS) {
      return NextResponse.json(
        { error: `tags may have at most ${MAX_TAGS} items` },
        { status: 400 },
      );
    }
    const overlong = tags.find((t) => t.length > MAX_TAG_CHARS);
    if (overlong) {
      return NextResponse.json(
        { error: `Tag "${overlong.slice(0, 20)}…" exceeds ${MAX_TAG_CHARS} characters` },
        { status: 400 },
      );
    }
    patch.tags = tags;
  }

  if ("one_line" in body) {
    const raw = body.one_line;
    if (typeof raw !== "string" || !raw.trim()) {
      return NextResponse.json({ error: "one_line must be a non-empty string" }, { status: 400 });
    }
    if (raw.trim().length > MAX_ONE_LINE) {
      return NextResponse.json(
        { error: `one_line exceeds ${MAX_ONE_LINE} characters` },
        { status: 400 },
      );
    }
    patch.one_line = raw.trim();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No supported fields in request" }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── 3. Ownership check — service-role bypasses RLS ───────────────────────────
  const { data: existing } = await admin
    .from("stories")
    .select("id, user_id")
    .eq("id", storyId)
    .maybeSingle();

  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  // ── 4. Apply patch ────────────────────────────────────────────────────────────
  const { data: updated, error: updateErr } = await admin
    .from("stories")
    .update(patch)
    .eq("id", storyId)
    .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
    .single();

  if (updateErr || !updated) {
    console.error("[PATCH /api/user/stories/:id] update failed:", updateErr?.message);
    return NextResponse.json({ error: "Failed to update story." }, { status: 500 });
  }

  return NextResponse.json(updated);
});
