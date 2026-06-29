# Aged-care direct-scraping — session handoff

**Branch:** `claude/direct-career-site-scraping-r6vq44`
**Last session:** 2026-06-29
**Goal:** Scrape aged-care jobs directly from employer career sites (full JDs,
role-filtered), starting with Anglicare, expanding across providers/ATSs.

See also: `docs/aged-care-ats-map.md` (provider→ATS registry + validation
learnings) and `.claude/graph.json` decisions **D22, D23, D24**.

---

## 🤖 INSTRUCTIONS FOR THE NEXT AI AGENT — START HERE

Read this whole file, then `docs/aged-care-ats-map.md`, then `.claude/graph.json`
(decisions D22–D24). Work on branch `claude/direct-career-site-scraping-r6vq44`.
Commit + push after each logical change. The user runs all live validation on
their Mac (this environment's egress blocks the ATS hosts — do NOT try to curl
them yourself; ask the user to run commands and paste output).

**State as of 2026-06-29 end of session:** migrations applied through 073.
Workday (6 providers) and Radancy (Bupa AU) both return full JDs. ONE known bug:

### PRIORITY 1 — Fix Radancy pagination (only gets 15 of ~52 Bupa jobs)
`radancy.ts` `collectLinks()` tries `/search-jobs/results?CurrentPage=N&RecordsPerPage=100`
but that endpoint returns `{"hasJobs":true,"results":""}` (empty) — so it falls
back to the static `/search-jobs` page = page 1 only = 15 links = 3 role matches.
Bupa actually has 52 positions / ~21 care roles across 4 pages.

To fix, you need the REAL TalentBrew results request. Ask the user to:
  1. Open `https://careers.bupa.com.au/search-jobs` in Chrome → DevTools (F12)
     → Network tab → filter "results" (or XHR).
  2. Click "Next" / page 2 of the results.
  3. Find the request to `/search-jobs/results...`, right-click → Copy → "Copy
     as cURL", and paste the whole thing (URL + all query params + headers).
Then update `collectLinks()` to replicate that exact request (params/headers),
parse `/job/` links from the returned `results` HTML, and page until no new
links. Re-test with `npx tsx src/scripts/testRadancy.ts` — expect ~21 care jobs,
not 3. (If `/results` is hopeless, fallback: loop the static page with whatever
pagination param DevTools shows — note plain `?p=N` did NOT work.)

### PRIORITY 2 — Confirm Workday at scale + Fly egress
Have the user run `npx tsx src/scripts/testAgedCareWorkday.ts` (expect ~250+ jobs
now the detail cap is gone, 0 known-overseas locations). Then confirm a full
pipeline run on a healthcare-vertical profile (founder/unlimited account) shows
`[agedcare]`/`[radancy]` logs and rows land with `source='agedcare'` + non-empty
descriptions. **Critically: verify the Fly worker's datacenter IP can reach
Workday CXS + Radancy** — if they 403 there (but work on the Mac), route through
the Apify residential proxy (`getApifyProxyUrl` + `curlFetch`/`curlPostJson`).

### PRIORITY 3 — Expand (only after 1 & 2 are green)
Add more Workday/Radancy providers (one row each, validate first). Then consider
the paused JS-SPA ATSs (need network capture or Playwright) — see LATER.

**Golden rule (we got burned 3×):** never trust a tenant/board until the user
validates it live. "Company X uses ATS Y" ≠ "X's AU jobs are on that Y board."

---

## ✅ DONE this branch (shipped, validated)

### Workday adapter — `backend/worker/src/sources/agedCareWorkday.ts`
- Public Workday CXS JSON API. List (cheap) → role-taxonomy title filter →
  full-JD detail fetch **only for matches**.
- **6 AU providers, all validated 2026-06-29** (end-to-end test returned 134
  jobs with full 3–5k char JDs):
  Anglicare, Estia Health, HammondCare, Bolton Clarke, UnitingCare QLD, RSL LifeCare.
- Detail-fetch cap removed (`MAX_DETAIL_FETCH = Infinity`) → every role match
  gets a full JD; `MAX_PAGES = 60`.
- Adding a provider = one row in `TENANTS` (after the 2-curl validation).

### Radancy/TalentBrew adapter — `backend/worker/src/sources/radancy.ts`
- Bupa AU aged care (`careers.bupa.com.au`) — **Bupa is NOT on Workday for AU**
  (its `bupa.wd3` board is UK/global, zero AU jobs).
- Validated 2026-06-29: detail pages carry clean JSON-LD JDs + structured AU
  addresses. Paginates via `/search-jobs/results` AJAX; static fallback.
- Reusable for other Radancy employers (add to `ORGS`).

### Shared infra
- `sources/agedCareRoles.ts` — shared role taxonomy (`matchRole`: nursing
  RN/EN/AIN + care/support workers + admin officers) + `stripHtml` + `sleep`.
- `lib/curlfetch.ts` `curlPostJson()` + `scripts/fetch_jd.py` `--method/--data/
  --header` — reusable curl_cffi POST (for TLS-fingerprinted JSON APIs).
- Winner scoring: `source="agedcare"` → SOURCE_BONUS 1800 (all aged-care
  adapters emit this source so canonical full JDs win duplicates).
- Test scripts: `scripts/testAgedCareWorkday.ts`, `scripts/testRadancy.ts`.

### Enablement (all aged-care sources gated `vertical=healthcare`)
- Migrations: **070** (`agedcare`/Workday), **073** (`radancy`) → unlimited tier.
- Admin: `api/admin/sources` `VALID_SOURCES` + `PlatformSourcesCard` toggles
  ("Aged Care", "Aged Care — Bupa").

### Paused (built but disabled — see "LATER")
Dayforce, PageUp, Scout Talent, Avature. Commented out of `adapters[]`,
removed from admin toggles, migration **072** strips their names from the DB.

---

## ▶️ NEXT (do these first next session)

1. **Apply migrations** (user runs): `070` + `073` (the working sources).
   `071`/`072` net out to "paused ones off" — harmless if applied.
   Verify: `select enabled_sources from platform_source_tiers where tier='unlimited';`
   → should contain `agedcare` + `radancy`, NOT dayforce/pageup/scout/avature.

2. **Run the live tests on Mac** (residential IP; web sandbox + Fly egress
   differ) and paste results to confirm:
   - `npx tsx src/scripts/testAgedCareWorkday.ts` → expect ~250+ jobs now the
     cap is gone (Estia alone ~113), 0 known-overseas locations.
   - `npx tsx src/scripts/testRadancy.ts` → **confirm pagination grabbed all
     ~52 Bupa jobs (4 pages), not just the first 15.** If only 15, the
     `/search-jobs/results` params need fixing (it returned `hasJobs:true` but
     empty `results` in manual testing — may need `ProjectId`/`SearchType`).

3. **Full pipeline E2E**: run a healthcare-vertical profile on a founder/
   unlimited account. Watch worker logs for `[agedcare] …` and `[radancy] …`;
   confirm rows land with `source='agedcare'` + non-empty descriptions.

4. **⚠ Verify Fly egress**: all validation was from a residential Mac. Confirm
   Workday CXS + Radancy are reachable from the Fly worker's datacenter IP. If
   they 403, route through the Apify residential proxy (helper already exists:
   `getApifyProxyUrl` + `curlFetch`/`curlPostJson`).

---

## 🔭 LATER (backlog, lower priority)

- **Find Bupa AU's real coverage**: confirm Radancy pagination; the page showed
  52 positions across categories (Care Support 21, Clinical 14, etc.).

- **Add more Workday providers** (cheapest expansion): validate with the 2-curl
  check, add a row to `TENANTS`. Candidates to investigate from the ATS map.

- **Add more Radancy employers**: other big AU employers use TalentBrew; add to
  `radancy.ts` `ORGS` after validating their detail pages have JSON-LD.

- **Paused ATSs — need network capture or headless** (see ats-map "Validation
  learnings"):
  - **Dayforce** (Opal): `jobposting/search` 403s even via curl_cffi from a
    residential IP → app-level block (session cookie/token/wrong path). Needs a
    real network-tab XHR (URL + payload + cookies) captured from the Opal portal.
  - **PageUp** (BaptistCare/Calvary/Arcare/SA Health): listings work (~20 links)
    but detail is a JS SPA with no JSON-LD. Adapter is listing-only (title+URL,
    no JD). Needs PageUp's job JSON API captured, or headless rendering.
    Resthaven dropped (newer PageUp on custom domain).
  - **Scout Talent / Avature**: likely same JS-SPA problem, unvalidated.
  - Common unblock: enable **Playwright** (currently OOM-disabled on the 512MB
    Fly VM — graph BUG-5; needs `fly scale memory 1024`).

- **Tuning**: role taxonomy currently excludes "Care Manager" (leadership) and
  clinical-adjacent (Clinical Educator). Revisit if those are wanted.

- **Other aged-care ATSs not yet touched**: Mercury/Roubler, Elmo, JobAdder,
  SuccessFactors, Expr3ss! (scaffolds exist for some). Custom/no-API sites are
  covered by the existing aggregators (SEEK/Adzuna/Careerjet).

---

## ⚠️ Hard-won gotchas (don't relearn these)

- **Validate every tenant before trusting it.** Burned by: AgeCare = *Canada*;
  Bupa Workday board = *UK only*; PageUp/Scout/Avature = *JS SPAs*. "Company X
  is on ATS Y" does NOT mean "X's AU jobs are on that Y board."
- **Web session can't validate** — egress policy blocks `myworkdayjobs.com`,
  `dayforcehcm.com`, etc. Validation must run on the Mac or Fly.
- **zsh paste**: no `#` comment lines in pasted shell blocks (zsh runs them).
- **Test scripts** (`scripts/test*.ts`) are gitignored — force-add (`git add -f`).
- Workday `locationsText` is the *facility* name (messy, e.g. "8 Locations");
  the clean suburb is only on the *detail* endpoint.
