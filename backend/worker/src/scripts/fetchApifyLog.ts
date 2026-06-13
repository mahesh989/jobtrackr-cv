/**
 * Fetch the last Apify actor run log for seek-au-scraper.
 * Usage: npx tsx --env-file=.env src/scripts/fetchApifyLog.ts
 */

import { createClient } from "@supabase/supabase-js";
import { decryptApiKey } from "../lib/crypto.js";

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const { data } = await db
  .from("user_integrations")
  .select("encrypted_api_key")
  .eq("provider", "apify")
  .eq("status", "valid")
  .limit(1)
  .maybeSingle();

const token = decryptApiKey(data!.encrypted_api_key as string);

// List recent runs
const runsRes = await fetch(
  "https://api.apify.com/v2/acts/prospect_fuzz~seek-au-scraper/runs?limit=5&desc=1",
  { headers: { Authorization: `Bearer ${token}` } }
);

interface ApifyRun { id: string; status: string; startedAt: string; buildNumber: string; }
const runs = (await runsRes.json()) as { data: { items: ApifyRun[] } };

console.log("Recent runs:");
runs.data.items.forEach(r =>
  console.log(` - ${r.id} | ${r.status} | build ${r.buildNumber} | ${r.startedAt}`)
);

const lastId = runs.data.items[0]?.id;
if (!lastId) { console.log("No runs found"); process.exit(0); }

console.log(`\nFetching log for run ${lastId}...`);
const logRes = await fetch(
  `https://api.apify.com/v2/actor-runs/${lastId}/log`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const log = await logRes.text();
console.log("\n=== Actor Log ===");
console.log(log.split("\n").slice(-120).join("\n"));

process.exit(0);
