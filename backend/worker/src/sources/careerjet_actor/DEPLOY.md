# Deployment — careerjet-jd-fetcher

A custom Apify actor that fetches **full job descriptions** for a list of
careerjet.com.au job URLs over an internal **residential AU** proxy. Cheerio —
no browser, cheap compute.

## Why residential (not datacenter, unlike SEEK)

Verified 2026-06-22: careerjet.com.au's Cloudflare Turnstile **hard-blocks
datacenter IPs** — even a real Playwright browser on Apify's datacenter proxy
times out on every navigation. A residential IP gets the page with no challenge
at all, so a plain Cheerio fetch works. Residential proxy needs a **paid Apify
plan** (not the free tier).

## The funnel (mirrors SEEK's two-actor pattern)

- **Listings** — FREE Careerjet v4 API (in the worker, no proxy)
- **Filter + dedup** — worker, $0 → ~20 Careerjet survivors
- **Full JDs** — *this actor*, residential, only the survivors (cap ~20)

So residential cost is paid only for the handful of jobs that matter.

## 1. Install Apify CLI
```bash
npm install -g apify-cli
apify login
```

## 2. Deploy
```bash
cd backend/worker/src/sources/careerjet_actor
npm install
apify push          # → <your-username>/careerjet-jd-fetcher
```

## 3. Enable in the worker
```bash
fly secrets set CAREERJET_ACTOR_ID=<your-apify-username>~careerjet-jd-fetcher -a jobtrackr-worker
```
The worker reuses the **same per-user Apify token** as SEEK. With
`CAREERJET_ACTOR_ID` set, stage 7c enriches Careerjet survivors via this actor;
unset, Careerjet keeps the free v4 API snippet (no enrichment).

## 4. Test in the Apify console first
```json
{ "urls": ["https://www.careerjet.com.au/jobad/au4f774a0504ed1a561daa9486708f3005"], "maxUrls": 5 }
```
Expected: a dataset row with a multi-thousand-char `description`. If you get
`only N chars` / timeouts → the residential proxy isn't active (check your plan).

## 5. Cost
Residential ~$12.50/GB; a careerjet JD page is ~10–50 KB, so ~20 JDs/run ≈ a
few MB → ~$0.01–0.03 per run. Compute (Cheerio) is negligible. Well within the
$5/month Apify budget the worker already tracks for SEEK.
