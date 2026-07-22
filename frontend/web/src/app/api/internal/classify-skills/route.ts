/**
 * POST /api/internal/classify-skills
 *
 * Founder-only. Calls cv-backend /internal/classify-skills with a list of
 * skill phrases and a vertical. Returns deterministic lexicon classification
 * for each item — no AI calls.
 *
 * Used by the /beta/skills-audit page.
 */
import { NextRequest, NextResponse } from "next/server";
import { withAdmin, parseJsonBody } from "@/lib/api-utils";
import { callCvBackend }             from "@/lib/cv/backend";

export const runtime     = "nodejs";
export const maxDuration = 15;

interface ClassifyBody {
  items:    string[];
  vertical: string | null;
}

interface ClassifiedItem {
  item:      string;
  category:  string | null;
  canonical: string | null;
  is_noise:  boolean;
  action:    string;
}

interface ClassifyResponse {
  results: ClassifiedItem[];
}

export const POST = withAdmin(async (req: NextRequest) => {

  const { data: body, error: parseErr } = await parseJsonBody<ClassifyBody>(req);
  if (parseErr) return parseErr;

  if (!Array.isArray(body!.items) || body!.items.length === 0) {
    return NextResponse.json({ error: "items must be a non-empty array" }, { status: 422 });
  }

  try {
    const result = await callCvBackend<ClassifyResponse>("/internal/classify-skills", {
      items:    body!.items,
      vertical: body!.vertical ?? null,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
