/**
 * SEEK smoke test — one keyword, maxResults: 20.
 * Does NOT touch the DB quota. Read-only.
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/testSeek.ts [keyword]
 *
 * Example:
 *   npx tsx --env-file=.env src/scripts/testSeek.ts "Data Analyst"
 */

import { createClient } from "@supabase/supabase-js";
import { decryptApiKey } from "../lib/crypto.js";

const keyword  = process.argv[2] ?? "Data Analyst";
const ACTOR_ID = process.env.SEEK_ACTOR_ID ?? "prospect_fuzz~seek-au-scraper";

// ── Load token from DB ────────────────────────────────────────────────────────
const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const { data: integration, error } = await db
  .from("user_integrations")
  .select("encrypted_api_key, status, quota_used_usd")
  .eq("provider", "apify")
  .eq("status", "valid")
  .limit(1)
  .maybeSingle();

if (error || !integration) {
  console.error("[testSeek] No valid Apify integration found in DB:", error?.message ?? "no row");
  process.exit(1);
}

const token = decryptApiKey(integration.encrypted_api_key as string);
console.log(`[testSeek] Actor    : ${ACTOR_ID}`);
console.log(`[testSeek] Quota    : $${integration.quota_used_usd} used`);
console.log(`[testSeek] Keyword  : "${keyword}"`);
console.log(`[testSeek] Calling Apify actor (maxResults: 20)…\n`);

// ── Call actor ────────────────────────────────────────────────────────────────
const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?timeout=120`;

const res = await fetch(url, {
  method:  "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    keywords:   [keyword],
    location:   "All Australia",
    dateRange:  7,
    maxResults: 20,
  }),
  signal: AbortSignal.timeout(125_000),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  console.error(`[testSeek] Apify ${res.status}: ${body}`);
  process.exit(1);
}

interface SeekItem {
  id?: string;
  title?: string;
  company?: string;
  location?: string;
  area?: string;
  salary?: string;
  teaser?: string;
  listingDate?: string;
  url?: string;
  workType?: string;
  keyword?: string;
}

const items = (await res.json()) as SeekItem[];

console.log(`[testSeek] ✓ ${items.length} results\n`);

// Print each result cleanly
items.forEach((item, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${item.title ?? "—"}`);
  console.log(`    Company  : ${item.company ?? "—"}`);
  console.log(`    Location : ${[item.area, item.location].filter(Boolean).join(" · ") || "—"}`);
  console.log(`    Salary   : ${item.salary || "—"}`);
  console.log(`    Posted   : ${item.listingDate ?? "—"}`);
  console.log(`    WorkType : ${item.workType ?? "—"}`);
  console.log(`    URL      : ${item.url ?? "—"}`);
  console.log(`    Keyword  : ${item.keyword ?? "—"}`);
  console.log();
});

const estimated = (0.02 + items.length * 0.002).toFixed(4);
console.log(`[testSeek] done — ${items.length} results, estimated cost $${estimated}`);
process.exit(0);
