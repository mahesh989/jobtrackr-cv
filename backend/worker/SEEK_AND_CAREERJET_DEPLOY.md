# SEEK direct + Careerjet — deploy & verify guide

Two changes shipping together. Both share the same Apify residential proxy
secret to bypass Cloudflare from Fly's datacenter IP.

---

## What changed

| File | Change |
|---|---|
| `worker/src/lib/proxy.ts` (new) | Apify Proxy URL helper — returns residential AU proxy URL when `APIFY_PROXY_PASSWORD` is set |
| `worker/src/sources/seekDirect.ts` | `fetchHtml()` now routes through Apify proxy when configured. Falls back to direct (no proxy) when not. |
| `worker/src/sources/careerjet.ts` (new) | New Tier 1 adapter. Two phases: free API listings (no proxy) + got-scraping `/jobad/<hash>` enrichment (uses proxy). |
| `worker/src/sources/index.ts` | Registered `careerjetAdapter` |
| `worker/src/pipeline/normalise/winner.ts` | Added `careerjet: 1800` source bonus |
| `worker/src/pipeline/dedup.ts` | Mirror careerjet bonus for already-saved-row scoring |
| `worker/src/pipeline/orchestrator.ts` | Added Stage 7c — Careerjet JD enrichment, parallels Stage 7 SEEK enrichment |

Both adapters degrade gracefully — if a proxy or API key is missing, they
return whatever they could fetch instead of crashing the pipeline.

---

## Required Fly secrets (production)

### 1. Apify proxy password (fixes SEEK direct from Fly)

The Apify **proxy password** is a separate secret from your API token.

1. Open https://console.apify.com/account/integrations
2. Scroll to **Integrate with proxy** — copy the password (NOT the API token)
3. Apply:
   ```bash
   fly secrets set APIFY_PROXY_PASSWORD=<password> -a jobtrackr-worker
   ```

Once set: `seekDirect` requests route through Apify residential AU IPs and
bypass Cloudflare. Same proxy is used by Careerjet's JD enrichment.

Without it: `seekDirect` keeps failing with 403, Apify actor fallback
continues to run (current production state).

### 2. Careerjet API key (enables the new source)

1. Already obtained — your key: `fcaf5807eca47dadcec163c3ab58da55`
2. Whitelist Fly's outbound IP at https://www.careerjet.com.au/partners/api-config
   - Get Fly's IP: `fly ssh console -a jobtrackr-worker --command 'curl -s https://api.ipify.org'`
   - Multi-region apps: whitelist each region's outbound IP (max 8 per key)
3. Apply:
   ```bash
   fly secrets set CAREERJET_API_KEY=<your-key> -a jobtrackr-worker
   ```

Without it: `careerjetAdapter.fetchJobs()` throws on first call. The
orchestrator catches it (existing per-source error handling) and the
pipeline continues with other sources.

---

## Deploy

```bash
cd worker
fly deploy -a jobtrackr-worker
```

---

## What to look for in the next pipeline run

| Log line | Meaning |
|---|---|
| `[seek-direct] keywords: ... · proxy: Apify residential AU` | ✅ SEEK direct now routing through proxy |
| `[seek-direct] data analyst page 1/1: added 22` | ✅ SEEK pages parsing on Fly IP |
| `[seek-direct] done — 36 jobs` | ✅ SEEK direct succeeded, actor NOT running |
| `[seek-direct] data analyst page 1: HTTP 403` | ⚠️ Proxy not active (password missing/wrong); actor fallback kicks in |
| `[careerjet] keywords: ... · location: ... · user_ip: <ip>` | ✅ Careerjet adapter started |
| `[careerjet] "Data Analyst" page 1/4: added 50 ...` | ✅ Careerjet API returning AU listings |
| `[careerjet] done — N unique jobs` | ✅ Phase 1 complete |
| `[careerjet-jd] enriching N Careerjet survivors · proxy: Apify residential AU` | ✅ Stage 7c running with proxy |
| `[careerjet-jd] merged N/N full descriptions` | ✅ Full JDs extracted (5-14k chars each) |
| `[careerjet-jd] <url>: extracted only 0 chars` | ⚠️ Proxy not active OR Cloudflare interstitial — job keeps 230-char teaser, no crash |

---

## Architecture invariants (preserved)

- ✅ Apify SEEK actor untouched (still the automatic fallback if `seekDirect` fails)
- ✅ Existing dedup logic untouched — Careerjet jobs flow through the same `dedup.ts`
- ✅ Existing post-fetch filter (excluded/preferred keywords) untouched
- ✅ Existing visa extraction (Stage 10a) untouched — runs on the full JD that
  Stages 7 (SEEK) and 7c (Careerjet) provide
- ✅ DB schema unchanged — Careerjet jobs land in `jobs` table with `source = "careerjet"`
- ✅ Local dev works without secrets — Careerjet returns 230-char teasers, seekDirect
  works direct from residential IP

---

## Cost notes (for the 10-20 user test phase)

| Item | Per-request | Per-day (est. 100 searches) |
|---|---|---|
| Careerjet API (Phase 1) | Free up to 500/day | ~200 calls/day → 60% of budget |
| Apify residential proxy traffic | $8 / GB | ~150 MB/day SEEK + Careerjet JDs → ~$1.20/day |
| Apify SEEK actor (now fallback only) | $0.025/run | ~$0/day if `seekDirect` works |

If the Careerjet API hits the 500/day cap, the adapter logs a warning and the
pipeline continues with other sources. Email them for a higher limit when needed
(per the welcome email they sent you).

---

## Rollback

If something breaks in production:

```bash
# Disable Careerjet without redeploying
fly secrets unset CAREERJET_API_KEY -a jobtrackr-worker

# Disable SEEK direct proxy (forces actor fallback)
fly secrets unset APIFY_PROXY_PASSWORD -a jobtrackr-worker
```

Both adapters detect missing secrets and skip themselves gracefully. The
Apify SEEK actor continues to run as the fallback path it's always been.
