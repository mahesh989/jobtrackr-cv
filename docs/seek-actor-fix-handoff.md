# SEEK Actor Fix — Handoff for a Coding Agent

> Status: **PARKED / TODO.** The SEEK Apify actor returns 0 jobs. Decision: fix it
> **in the Apify console first** (copy → rename → repair → verify), and only wire it
> into the app once it demonstrably works. Do **not** change app code to "fix SEEK"
> until a working actor exists on Apify.

## The problem (evidence from production actor logs, 2026-06-25)

The SEEK *actor* (Apify fallback, used when SEEK direct gets 403) never returns jobs.
Two different deployed builds were observed failing **two different ways** — which is
itself a red flag that the deployed actor and the repo source have drifted:

1. **Playwright build** (`src/main.ts` style, datacenter proxy):
   ```
   PlaywrightCrawler: Request blocked - received 403 status code.
   ... reached maximum retries ... Total 1 requests: 0 succeeded, 1 failed.
   ✅ Scraping complete! Total jobs: 0
   ```
   → SEEK 403-blocks Apify **datacenter** IPs. Needs a **residential (AU)** proxy.

2. **GraphQL build** (`__main__.py` Python / gotScraping, residential-ish proxy that
   got past the block):
   ```
   [seek] Warmup GET seek.com.au → HTTP 200
   [Cleaner] Page 1/1 → https://au.seek.com/graphql
   [Cleaner] HTTP 200, body 141 chars
   [Cleaner] Body preview: {"errors":[{"message":"An error occurred","path":["jobSearchV6"],
                            "extensions":{"code":"UNSTABLE_QUERY_ERROR"}}],"data":{"jobSearchV6":null}}
   [Cleaner] Done: 0 jobs
   ```
   → Proxy/403 is solved here, but SEEK's GraphQL resolver rejects the query with
   `UNSTABLE_QUERY_ERROR`. This almost always means **SEEK changed the `jobSearchV6`
   query shape / variables** and the actor's query is now stale. It is **not**
   keyword-specific (would fail for `ain` and `cleaner` alike — confirm by testing both).

### Repo confusion to clean up
`backend/worker/apify-actors/seek-scraper/src/` contains **two** implementations:
- `main.ts` — TypeScript, `gotScraping` → `https://au.seek.com/graphql` (JobSearchV6),
  **datacenter** proxy (`Actor.createProxyConfiguration()` with no group).
- `__main__.py` — Python, curl_cffi → same GraphQL endpoint.

Neither matches the **Playwright** build seen in log #1 — so the deployed actor on Apify
has diverged from this repo. **Pick ONE implementation as the source of truth** when fixing.

## Integration contract (how the app calls the actor — do NOT break this)

`backend/worker/src/sources/seek.ts`:
- Actor id from env **`SEEK_ACTOR_ID`** (default `prospect_fuzz~seek-au-scraper`).
- Calls `https://api.apify.com/v2/acts/${SEEK_ACTOR_ID}/run-sync-get-dataset-items?timeout=300`
  (POST, Bearer = user's Apify token).
- **Input** body: `{ keywords: string[], location: string, dateRange: number (days), maxResults: number }`.
- **Output**: the run's dataset items, parsed directly as an array of `SeekItem`:
  `{ jobId, title, company, location, salary?, teaser?, listingDate?, url, workType?, keyword? }`
  (see the `SeekItem` interface in `seek.ts`). The actor MUST `Actor.pushData(...)` rows in this shape.

So **integration later = just point `SEEK_ACTOR_ID` at the new actor** via a Fly secret on
`jobtrackr-worker`. No app code change required if the new actor honors the input/output above.

## The plan (Apify-console-first — what the user wants)

1. **Copy the actor in the Apify console** and **rename** it (e.g. `seek-au-scraper-v2`).
   Work entirely in the console build editor — do not touch the app.
2. **Repair it there until it returns jobs.** Two things to fix:
   - **Proxy** → use **residential AU**: `Actor.createProxyConfiguration({ groups: ["RESIDENTIAL"], countryCode: "AU" })`
     (datacenter is 403-blocked). Confirm residential is enabled on the Apify plan.
   - **Query** → capture a **fresh working `jobSearchV6` request** from a real browser:
     open seek.com.au, search (e.g. "ain" in "Sydney NSW"), DevTools → Network →
     the `graphql` POST → copy its `operationName`, full `query`, and `variables`, plus the
     request headers (esp. `seek-request-brand`, `seek-request-country`, `x-seek-site`, and any
     persisted-query hash). Update the actor's query/variables/headers to match exactly.
     The `UNSTABLE_QUERY_ERROR` is SEEK saying "your query no longer matches my schema."
3. **Verify in the console** with both `keywords:["ain"]` and `keywords:["cleaner"]`,
   `location:"Sydney NSW"`, `dateRange:14`. Acceptance = a non-empty dataset of real jobs in
   the `SeekItem` shape, no `UNSTABLE_QUERY_ERROR`, no 403.
4. **Only then integrate:** `fly secrets set SEEK_ACTOR_ID=<new-actor-id> -a jobtrackr-worker`.
   Re-run a profile whose SEEK direct is currently 403ing (e.g. the Cleaner profile) and confirm
   `[seek] actor returned N raw items` with N > 0 in `run_logs.log_lines`.

## Acceptance criteria
- New renamed actor on Apify returns ≥1 real job for `ain` AND `cleaner` in Sydney.
- Output rows match `SeekItem` (so `seek.ts` parses them with zero app changes).
- After pointing `SEEK_ACTOR_ID` at it, a worker run logs `seek (apify ...): N raw` with N>0.

## Context / why it's low-urgency
SEEK **direct** (curl_cffi in the worker) still works intermittently (got 200/9 jobs for AIN);
it only 403s sometimes. The global bucket + **Adzuna + Careerjet** already deliver results, and
the bucket's coverage fix (commit `6bbe888`) means a failed/empty SEEK no longer caches as
"covered" — so SEEK is retried next run. The actor is a *fallback*; repairing it improves
resilience but isn't blocking. Don't sink the whole Apify budget into SEEK's moving target.
