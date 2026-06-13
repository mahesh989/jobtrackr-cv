// POST /api/source-eval/[id]/stop
//
// Cancels a running eval. Marks every source that is still pending/running
// as error:"Cancelled", then sets the row status to "failed" + finished_at.
//
// The worker may still be mid-flight on an active job — we can't reach into
// BullMQ from here to kill it, but marking the row terminal means the UI
// stops polling and the user can start a new eval immediately. If the worker
// eventually completes and tries to write results, maybeFinalize will detect
// all sources terminal and re-finalize (harmless — the row stays failed or
// flips to completed with partial results).

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
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

  // Fetch the current row (RLS ensures user can only touch their own evals).
  const { data: row, error: fetchErr } = await supabase
    .from("source_eval_runs")
    .select("id, sources_requested, results, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !row) {
    return NextResponse.json({ error: "Eval not found." }, { status: 404 });
  }
  if (row.status === "completed" || row.status === "failed") {
    // Already terminal — nothing to do.
    return NextResponse.json({ ok: true, already_terminal: true });
  }

  const now = new Date().toISOString();
  const cancelledResult = {
    status:      "error",
    error:       "Cancelled",
    started_at:  now,
    finished_at: now,
    timing_ms:   { fetch: 0, dedup: 0, jd_enrich: 0 },
    counts: {
      fetched: 0, after_url_dedup: 0, after_keyword: 0,
      after_smart: 0, after_dedup: 0, would_save: 0, full_jd: 0, thin_jd: 0,
    },
    samples:         [],
    kept_url_hashes: [],
  };

  // Mark every non-terminal source as cancelled.
  const results = (row.results as Record<string, { status?: string }>) ?? {};
  const patched: Record<string, unknown> = { ...results };
  for (const src of row.sources_requested as string[]) {
    const cur = results[src];
    const isTerminal = cur?.status === "done" || cur?.status === "error";
    if (!isTerminal) {
      patched[src] = cancelledResult;
    }
  }

  const { error: updateErr } = await supabase
    .from("source_eval_runs")
    .update({
      status:      "failed",
      finished_at: now,
      results:     patched,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[source-eval/stop] update failed:", updateErr.message);
    return NextResponse.json({ error: "Failed to cancel eval." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
