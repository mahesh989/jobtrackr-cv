# Jooble AU Scraper — Deploy & Test Guide

## Architecture

Same two-phase pattern as the SEEK actor:

| Phase | Method | Cloudflare? |
|-------|--------|-------------|
| **1 — Listings** | Jooble JSON API (`curl_cffi`) | None — API has no CF |
| **2 — Descriptions** | Playwright → Jooble `/desc/{id}` | Blocked locally, bypassed by Apify residential proxy on the platform |

The `/desc/` URLs (returned as `link` in the API) host the full job description on Jooble's own pages.
Cloudflare protects them, but Apify's **residential AU proxy** passes right through.
Without a proxy (local dev), Phase 2 is skipped automatically with a warning.

## Pre-requisites

### 1. Jooble API key
Already obtained: stored in your password manager / `.env`.  
Register new keys at: https://jooble.org/api/about (free, 500 req limit)

### 2. Apify CLI
```bash
npm install -g apify-cli
apify login
```

## Deploy

```bash
cd worker/apify-actors/jooble-scraper
apify push
```

Actor ID: `<your-username>/jooble-au-scraper`

## Testing — two steps

### Step 1: verify Phase 1 (API only, no proxy needed)

Run on Apify console with `fetchDescriptions: false`:

```json
{
  "apiKey": "<your-jooble-api-key>",
  "keywords": ["Data Analyst"],
  "location": "All Australia",
  "maxResults": 5,
  "fetchDescriptions": false
}
```

Expected output (per job):

```json
{
  "id": "447477646465415327",
  "title": "ESG Junior Data Analyst (Mandarin Speaker)",
  "company": "ISS | Institutional Shareholder Services",
  "location": "Australia",
  "salary": "",
  "teaser": "acquire specific knowledge about the dominant issues...",
  "description": "",
  "listingDate": "2026-02-27T00:00:00.0000000",
  "source": "swooped.co",
  "url": "https://jooble.org/desc/447477646465415327?...",
  "workType": "",
  "keyword": "Data Analyst"
}
```

### Step 2: verify Phase 2 (descriptions via Apify proxy)

Run with `fetchDescriptions: true` (default). The actor will:
1. Collect listings (Phase 1)
2. Visit each `url` with Playwright + Apify residential proxy
3. Extract the full `description` text from the `/desc/` page

```json
{
  "apiKey": "<your-jooble-api-key>",
  "keywords": ["Data Analyst"],
  "location": "All Australia",
  "maxResults": 5,
  "fetchDescriptions": true
}
```

The `description` field should now contain 200–3000+ characters of full job description.
If it's empty, check the actor logs for "Cloudflare challenge" — means the proxy didn't kick in.

## Expected output schema

| Field | Source | Notes |
|-------|--------|-------|
| `id` | Jooble API `id` | Large integer, may be negative |
| `title` | Jooble API | |
| `company` | Jooble API | |
| `location` | Jooble API | `"Australia"` for AU-wide |
| `salary` | Jooble API | Often empty for AU jobs |
| `workType` | Jooble API `type` | `"Full-time"` etc., often empty |
| `teaser` | Jooble API `snippet` | HTML stripped, ~100 chars |
| `description` | Playwright → `/desc/` page | Full text, only with `fetchDescriptions: true` |
| `listingDate` | Jooble API `updated` | ISO 8601 |
| `source` | Jooble API | Original job board, e.g. `"swooped.co"` |
| `url` | Jooble API `link` | Jooble `/desc/` URL (with tracking params) |
| `keyword` | Actor input | Which keyword found this job |

## Verify API key locally (no Apify needed)

```bash
curl -s -X POST "https://jooble.org/api/<YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"keywords":"data analyst","location":"Australia","page":1,"resultonpage":5}' | python3 -m json.tool | head -40
```

## Location note

The Jooble API requires `"Australia"` (not `"All Australia"`) for AU-wide results.
The actor converts any "All Australia" input automatically.
`"Sydney"` or `"Melbourne"` also work as city filters.

## AU job count note

Jooble's AU-specific index is smaller than SEEK (~33 total for "Data Analyst" vs SEEK's hundreds).
For better coverage, use multiple keywords: `["Data Analyst", "Business Intelligence", "BI Analyst"]`.

## Set env var in worker after deploy

```bash
# Local
echo "JOOBLE_ACTOR_ID=<username>/jooble-au-scraper" >> worker/.env
echo "JOOBLE_API_KEY=<your-api-key>" >> worker/.env

# Fly.io
fly secrets set JOOBLE_ACTOR_ID=<username>/jooble-au-scraper --app jobtrackr-worker
fly secrets set JOOBLE_API_KEY=<your-api-key> --app jobtrackr-worker
```
