# Deployment — careerjet-au-scraper

A custom Apify actor that scrapes careerjet.com.au listings + full JDs over an
internal **residential AU** proxy (bypasses the Cloudflare Turnstile that blocks
datacenter IPs). Cheerio-based — no browser, so compute is cheap.

## 1. Install Apify CLI (if not already)
```bash
npm install -g apify-cli
apify login   # paste your Apify token
```

## 2. Deploy
```bash
cd backend/worker/src/sources/careerjet_actor
npm install
apify push
```
Builds and pushes to your Apify account as `<your-username>/careerjet-au-scraper`.

## 3. Point the worker at it
```bash
fly secrets set CAREERJET_ACTOR_ID=<your-apify-username>~careerjet-au-scraper -a jobtrackr-worker
```
(Note the `~` separator in the actor id, same as `SEEK_ACTOR_ID`.)

The worker reuses the **same per-user Apify token** as SEEK (the user's Apify
integration). When that token is present, Careerjet runs via this actor (full
JDs). When it isn't, the worker falls back to the free v4 API adapter
(listings + ~251-char snippet).

## 4. Test in the Apify console first
```json
{
  "keywords": ["assistant in nursing"],
  "location": "Sydney NSW",
  "maxResults": 20,
  "fetchJDs": true,
  "jdCap": 10
}
```
Expected: rows with `title, company, location, salary, url, description, keyword`.
`description` should be multi-thousand chars for the ~10 jobs that got full-JD
enrichment, and the listing teaser for the rest.

If you see `0 article.job` with a Cloudflare title in the log → the residential
proxy isn't active. Confirm your Apify plan includes **Residential** proxy
(datacenter IPs are Turnstile-blocked).

## 5. Proxy cost reference
| Proxy group | Cost/GB | Typical per run (~200 listings + 40 JDs) |
|---|---|---|
| RESIDENTIAL | ~$12.50 | a few MB → ~$0.03–0.08 |

Residential is required here (datacenter is blocked), so there's no cheaper
group to start with — unlike the SEEK actor.
