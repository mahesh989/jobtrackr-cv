// CSV export — GET /api/profiles/[id]/jobs/export
// Respects the same sort/filter params as the jobs page.
// Returns Content-Disposition: attachment so browsers download directly.

import { NextRequest, NextResponse } from "next/server";
import { jsonError, withUser } from "@/lib/api-utils";

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

export const GET = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
, { user, supabase }) => {
  const { id } = await params;

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!profile) return jsonError("Not found", 404);

  const sp = req.nextUrl.searchParams;

  const minKeywords = sp.get("min_keywords");
  const minVisa  = sp.get("min_visa");
  const source   = sp.get("source");
  const sort     = sp.get("sort") ?? "created_at";

  // Builds a fresh query each call — a Supabase query builder is a
  // single-use, awaited-once object, so paginating below needs a new
  // instance per page rather than re-invoking .range() on an already-run one.
  function buildQuery() {
    let q = supabase
      .from("jobs")
      .select("title, company, location, source, source_tier, posted_at, visa_likelihood, keywords_matched, url, applied_at, dismissed_at, created_at")
      .eq("profile_id", id)
      .eq("is_expired", false)
      .eq("is_dead_link", false);
    if (minVisa)  q = q.gte("visa_likelihood", parseFloat(minVisa));
    if (source)   q = q.eq("source", source);
    if (sp.get("hide_applied") === "1") q = q.is("applied_at", null);
    if (sp.get("hide_dismissed") !== "0") q = q.is("dismissed_at", null);
    if (sort === "score" || sort === "ai_relevance_score")  q = q.order("created_at", { ascending: false, nullsFirst: false });
    else if (sort === "visa") q = q.order("visa_likelihood", { ascending: false, nullsFirst: false });
    else q = q.order("posted_at", { ascending: false, nullsFirst: false });
    return q;
  }

  type JobRow = { title: string; company: string; location: string; source: string; source_tier: number; posted_at: string | null; visa_likelihood: number | null; keywords_matched: string[]; url: string; applied_at: string | null; dismissed_at: string | null; created_at: string };

  // C67: was a flat .limit(1000) — a profile with more than 1000 matching
  // jobs silently exported only the first page, with nothing in the CSV
  // indicating the export was incomplete. Paginate through .range() until
  // a page comes back short, so "download my jobs" actually downloads all
  // of them. PAGE_SIZE matches PostgREST's own default row cap.
  // MAX_ROWS is a sane backstop against a truly runaway profile, not a
  // silent truncation point — if ever hit, the CSV says so explicitly.
  const PAGE_SIZE = 1000;
  const MAX_ROWS  = 20_000;
  let jobList: JobRow[] = [];
  let truncated = false;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data: page, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);
    // A discarded error here previously produced a silently-empty CSV that
    // looked like a successful export of zero matching jobs.
    if (error) return jsonError(error.message, 500);
    const rows = (page ?? []) as JobRow[];
    jobList = jobList.concat(rows);
    if (rows.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= MAX_ROWS) truncated = true;
  }

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

  const truncationNotice = truncated
    ? [row([`# Export truncated at ${MAX_ROWS} rows — this profile has more matching jobs than fit in one export.`])]
    : [];
  const csv = [header, ...lines, ...truncationNotice].join("\r\n");
  const filename = `jobtrackr-${(profile as { name: string }).name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
