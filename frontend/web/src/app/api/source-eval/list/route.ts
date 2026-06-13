// GET /api/source-eval/list?limit=10
//
// Returns the user's most recent source_eval_runs (shallow — no results
// jsonb) for the "Recent evals" picker in the beta UI.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
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

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam && /^\d+$/.test(limitParam)
    ? Math.min(50, Math.max(1, Number(limitParam)))
    : 10;

  const { data, error } = await supabase
    .from("source_eval_runs")
    .select("id, keywords, location, posted_within_days, sources_requested, status, unique_total, created_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[source-eval/list] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load list." }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
}
