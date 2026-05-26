// GET /api/source-eval/[id]
//
// Polled by the beta page. Returns the source_eval_runs row for the current
// user — RLS guarantees the user can only see their own evals.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: ReturnType<typeof createServerClient<any>> = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          ),
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("source_eval_runs")
    .select("id, keywords, location, posted_within_days, sources_requested, status, results, unique_total, overlap, created_at, finished_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[source-eval/get] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load eval." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(data);
}
