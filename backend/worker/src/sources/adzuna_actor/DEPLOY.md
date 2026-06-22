# Deployment — adzuna-jd-fetcher

A custom Apify actor that fetches **full job descriptions** for a list of
adzuna.com.au `/details/<id>` URLs using **Cheerio** over an internal
**residential AU** proxy.

## Why residential

Verified 2026-06-22:
- The Fly worker's datacenter IP gets `HTTP 429 Retry-After: 3600` from
  Adzuna `/details/<id>` after a small burst — the IP is in Adzuna's
  per-IP rate-limit penalty box for 1 hour at a time.
- A residential IP returns `HTTP 200` + the real page with a
  `<section class="adp-body">` carrying the full ~1.4–8k char JD.
- The page is plain static HTML — no Cloudflare, no JS challenge — so
  Cheerio is the right tool (no browser → cheap compute).

Residential proxy is **available on the Apify Free plan** at $8/GB (deducted
from your $5 monthly credit). A run is a few MB → cents.

## 1. Deploy
```bash
cd backend/worker/src/sources/adzuna_actor
npm install
apify push          # → <your-username>/adzuna-jd-fetcher
```

## 2. Enable in the worker
```bash
fly secrets set ADZUNA_ACTOR_ID=<your-apify-username>~adzuna-jd-fetcher -a jobtrackr-worker
```

The worker reuses the **same per-user Apify token** as SEEK. With
`ADZUNA_ACTOR_ID` set + the profile on `adzuna_method='direct'`, stage 7d
enriches Adzuna survivors via this actor; unset, stage 7d falls back to the
old curl-from-Fly path (which 429s) or stays on API teaser mode.

## 3. Test in the Apify console first
```json
{ "urls": ["https://www.adzuna.com.au/details/5743941401"], "maxUrls": 5 }
```
Expected: one dataset row with a multi-thousand-char `description`. If you
get `only N chars` / `HTTP=429` → the IP got a bad residential IP (rare) or
the URL has expired (try another).
