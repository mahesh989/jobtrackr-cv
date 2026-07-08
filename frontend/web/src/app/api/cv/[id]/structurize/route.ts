/**
 * POST /api/cv/[id]/structurize
 *
 * On-demand structurization for an EXISTING CV. Lets the user run the
 * review form on CVs that were uploaded before the structurization feature
 * shipped (i.e. structured_cv is NULL), and is also called silently by the
 * review page when the stored `_version` is below STRUCTURED_CV_VERSION.
 *
 * Returns { ok: true } on success — the caller then routes to
 * /dashboard/cv/{id}/review.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { structurizeAndPersist }     from "@/lib/cv/structurizeAndCategorise";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

export const runtime     = "nodejs";
export const maxDuration = 60;

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 2 AI calls (structurize + categorise), also silently
  // auto-fired by the review page on a stale stored version.
  const rl = await rateLimit(`cv-structurize:${user.id}`, 8, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("provider");
  const preferred: Provider | null = (raw && (PROVIDER_PRIORITY as readonly string[]).includes(raw))
    ? (raw as Provider)
    : null;

  const r = await structurizeAndPersist(user.id, id, preferred);
  if (r.ok) return NextResponse.json({ ok: true });

  switch (r.error.kind) {
    case "not_found":
      return NextResponse.json({ error: "CV not found" }, { status: 404 });
    case "empty_cv_text":
      return NextResponse.json({ error: "CV has no extractable text — re-upload the file." }, { status: 422 });
    case "no_ai_key":
      return NextResponse.json({ error: "No AI key connected. Add one in Settings → Integrations." }, { status: 422 });
    case "decrypt_failed":
      return NextResponse.json({ error: "Could not decrypt your AI key — re-connect it in Integrations." }, { status: 500 });
    case "ai_failed":
      console.error("[/api/cv/:id/structurize] AI failed:", r.error.message);
      return NextResponse.json({ error: "AI structurization failed" }, { status: 502 });
    case "db_failed":
      // Most likely cause: migrations 058+059 not applied yet.
      console.error("[/api/cv/:id/structurize] update failed:", r.error.message);
      return NextResponse.json({ error: "Save failed — apply migrations 058 and 059 in Supabase first." }, { status: 500 });
  }
}
