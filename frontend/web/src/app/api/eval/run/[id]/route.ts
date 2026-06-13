/**
 * GET /api/eval/run/[id]
 *
 * Founder-only poll endpoint. Proxies to cv-backend GET /internal/eval-run/{id}
 * over HMAC so the browser never sees the secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { getEvalRun, CvBackendError } from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 15;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!id || id.length < 8) {
    return NextResponse.json({ error: "Bad eval_run_id" }, { status: 400 });
  }

  try {
    const row = await getEvalRun(id);
    return NextResponse.json(row);
  } catch (err) {
    if (err instanceof CvBackendError) {
      return NextResponse.json(
        { error: typeof err.detail === "string" ? err.detail : `cv-backend ${err.status}` },
        { status: err.status === 404 ? 404 : 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
