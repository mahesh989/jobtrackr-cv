/**
 * GET /api/places/autocomplete?q=<query>
 *
 * Server-side proxy for Google Places Autocomplete API (New). Keeps
 * PLACES_API_KEY secret (it is never sent to the browser) and returns a
 * trimmed list of location suggestion strings for the profile location field.
 *
 * Auth-gated: only signed-in users may spend our Places quota.
 *
 * Responses:
 *   200  { suggestions: string[] }
 *   401  Unauthorized
 *   500  PLACES_API_KEY missing / upstream error
 */

import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-utils";

export const runtime = "nodejs";

const PLACES_URL = "https://places.googleapis.com/v1/places:autocomplete";

interface PlacePrediction {
  text?: { text?: string };
}
interface AutocompleteResponse {
  suggestions?: Array<{ placePrediction?: PlacePrediction }>;
}

export const GET = withUser(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  // Only authenticated users may consume the Places quota.

  const apiKey = process.env.PLACES_API_KEY;
  if (!apiKey) {
    console.error("[/api/places/autocomplete] PLACES_API_KEY is not set");
    return NextResponse.json({ error: "Places not configured." }, { status: 500 });
  }

  let data: AutocompleteResponse;
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify({
        input:                q,
        includedRegionCodes:  ["au"],
        includedPrimaryTypes: ["(cities)"],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      console.error(
        "[/api/places/autocomplete] upstream error:",
        res.status,
        (await res.text()).slice(0, 300),
      );
      return NextResponse.json({ error: "Places lookup failed." }, { status: 502 });
    }
    data = (await res.json()) as AutocompleteResponse;
  } catch (err) {
    console.error("[/api/places/autocomplete] fetch failed:", (err as Error).message);
    return NextResponse.json({ error: "Places lookup failed." }, { status: 502 });
  }

  const suggestions = (data.suggestions ?? [])
    .map((s) => s.placePrediction?.text?.text?.trim())
    .filter((t): t is string => Boolean(t));

  return NextResponse.json({ suggestions });
});
