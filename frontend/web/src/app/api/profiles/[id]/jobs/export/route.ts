// CSV export — GET /api/profiles/[id]/jobs/export
// Respects the same sort/filter params as the jobs page.
// Returns Content-Disposition: attachment so browsers download directly.

import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

function escapeCsv(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(cells: (string | number | null | undefined)[]): string {
  return cells.map(escapeCsv).join(",");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sp = req.nextUrl.searchParams;

  let query = supabase
    .from("jobs")
    .select("title, company, location, source, source_tier, posted_at, visa_likelihood, keywords_matched, url, applied_at, dismissed_at, created_at")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  const minKeywords = sp.get("min_keywords");
  const minVisa  = sp.get("min_visa");
  const source   = sp.get("source");
  if (minVisa)  query = query.gte("visa_likelihood",    parseFloat(minVisa));
  if (source)   query = query.eq("source", source);
  if (sp.get("hide_applied") === "1") query = query.is("applied_at", null);
  if (sp.get("hide_dismissed") !== "0") query = query.is("dismissed_at", null);

  const sort = sp.get("sort") ?? "created_at";
  if (sort === "score" || sort === "ai_relevance_score")  query = query.order("created_at", { ascending: false, nullsFirst: false });
  else if (sort === "visa") query = query.order("visa_likelihood", { ascending: false, nullsFirst: false });
  else query = query.order("posted_at", { ascending: false, nullsFirst: false });

  query = query.limit(1000);

  const { data: jobs } = await query;
  type JobRow = { title: string; company: string; location: string; source: string; source_tier: number; posted_at: string | null; visa_likelihood: number | null; keywords_matched: string[]; url: string; applied_at: string | null; dismissed_at: string | null; created_at: string };
  let jobList = (jobs ?? []) as JobRow[];

  if (minKeywords) {
    const minK = parseInt(minKeywords, 10);
    if (!isNaN(minK)) {
      jobList = jobList.filter((j) => (j.keywords_matched?.length ?? 0) >= minK);
    }
  }

  const header = row(["Title", "Company", "Location", "Source", "Tier", "Posted", "Visa %", "Keywords", "URL", "Applied", "Status"]);
  const lines  = jobList.map((j) =>
    row([
      j.title,
      j.company,
      j.location,
      j.source,
      j.source_tier,
      j.posted_at ? new Date(j.posted_at).toLocaleDateString("en-AU") : "",
      j.visa_likelihood   !== null ? Math.round(j.visa_likelihood * 100) + "%" : "",
      (j.keywords_matched ?? []).join("; "),
      j.url,
      j.applied_at ? new Date(j.applied_at).toLocaleDateString("en-AU") : "",
      j.dismissed_at ? "dismissed" : j.applied_at ? "applied" : "active",
    ])
  );

  const csv = [header, ...lines].join("\r\n");
  const filename = `jobtrackr-${(profile as { name: string }).name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
