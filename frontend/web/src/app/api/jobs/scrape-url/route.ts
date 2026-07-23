/**
 * POST /api/jobs/scrape-url
 *
 * User-initiated JD fetch — the "Add job" modal calls this when the user
 * pastes a URL. Fetches the page on behalf of the user (same as if they
 * pressed Ctrl+U), extracts title / company / location / JD text via JSON-LD
 * → OG → HTML, and returns a pre-filled job object for the modal to display.
 *
 * Rate-limited to 10 calls / user / 60 s — enough for fast manual add, not
 * enough to be a crawling proxy.
 */

import { NextRequest, NextResponse } from "next/server";
import { scrapeJobUrl } from "@/lib/scrapeJobUrl";
import { rateLimit } from "@/lib/rateLimit";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 20;

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  const rl = await rateLimit(`scrape-url:${user.id}`, 10, 60);
  if (!rl.allowed) return NextResponse.json(
    { error: "Too many requests — wait a moment and try again." },
    { status: 429 },
  );

  let url: string;
  try {
    const body = await req.json();
    url = String(body?.url ?? "").trim();
    if (!url) throw new Error("missing url");
  } catch {
    return jsonError("Body must be { url: string }", 400);
  }

  try {
    const scraped = await scrapeJobUrl(url);
    return NextResponse.json(scraped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scrape failed";
    return jsonError(msg, 422);
  }
});
