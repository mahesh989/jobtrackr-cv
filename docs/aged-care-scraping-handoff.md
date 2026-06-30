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
Workday (6 providers) and Radancy (Bupa AU) both return full JDs. Priority 1
below is now FIXED — start at Priority 2.

### ✅ PRIORITY 1 — Radancy pagination — FIXED (commit `5ec41b6`)
Root cause confirmed via DevTools cURL: `/search-jobs/results` requires the FULL
TalentBrew query string — sending only `CurrentPage&RecordsPerPage=100` made it
return `{"hasJobs":true,"results":""}`, so it fell back to the static page (15
links → 3 role matches). The missing key was `SearchType=5` plus the full
distance/sort/facet param set + `Content-Type: application/json` and `Referer`
headers. `collectLinks()` now builds the full query via `resultsUrl()` (only
`CurrentPage` varies), `RecordsPerPage=15` (100 returns degenerate), `MAX_PAGES`
40 safety ceiling, loop breaks early when a page yields no new `/job/` links.
**Live test (residential IP):** 269 links → 37 role-matched → 37 full JDs (0
thin), up from 3. No cookie/Imperva session needed — params alone fixed it.

### ✅ PRIORITY 2 — Workday at scale + Fly egress — MOSTLY DONE (2026-06-29)
- ✅ **Workday at scale**: `testAgedCareWorkday.ts` → **207 jobs** across 6
  tenants (Estia 113, Bolton Clarke 26, RSL 20, Anglicare 17, UnitingCare QLD 17,
  HammondCare 14), 0 overseas locations, 1 thin JD of 207 (negligible EOI).
- ✅ **Radancy**: 37 care-role full JDs (Bupa AU).
- ✅ **Fly egress CONFIRMED**: from `fly ssh console -a jobtrackr-worker`,
  `node -e "fetch(...)"` returned **bupa 200 + anglicare 200** — the datacenter
  IP reaches both Workday CXS and Radancy direct. **No Apify proxy needed.**
  (curl isn't in the worker image; test egress with Node's global fetch.)
- ✅ **Full pipeline E2E CONFIRMED LIVE (2026-06-29, prod job 339, image
  041a4b5)**: a manual full-refresh run on a healthcare profile logged
  `[agedcare] done — 207 jobs across 6 tenant(s)` + `[radancy] Bupa Aged Care:
  269 links → 37 role-matched → 37 jobs with full JD` → total raw 244 → stage 12
  saved 13. **P2 fully closed.** NOTE: the deployed worker had been a STALE build
  (showed phantom `bupa: 0` Workday tenant + no `[radancy]` + capped 134); a
  `flyctl deploy --config backend/worker/fly.toml` was required to go live.
  NOTE 2 (profile tuning, not adapter): all 13 saved auto-analyze-skipped as
  677–1244km > 30km (home n/a; survivors were interstate QLD/SA jobs — the
  Sydney ones were filtered earlier by the profile keyword + home-care rules).

### PRIORITY 3 — Expand (IN PROGRESS)
Add more Workday/Radancy/Avature providers (one row each, validate first). Then
consider the paused JS-SPA ATSs (need network capture or Playwright) — see LATER.

- ✅ **Regis Aged Care (Avature) DONE 2026-06-29 (commit `c141b39`)** — `avature.ts`
  rewritten. Regis server-renders the full JD inline in the listing (NO JSON-LD on
  detail pages), so it's a list-only adapter: paginate `?jobOffset`, parse
  `<article article--result>`, role-filter title, extract inline `article__content`
  JD. Live: 120 listed → 59 care-role full JDs. NEEDS worker redeploy + migration
  074. **8 direct providers now** (6 Workday + Radancy/Bupa + Avature/Regis).
- ✅ **Uniting NSW/ACT + Opal HealthCare (Dayforce) DONE** (commits `f3bf500`,
  `3d21db2`) — 66 + 86 jobs.
- ⏭ **Uniting family — ATS map (state-federated, 4 different ATSs):**
  | Entity | ATS | Status |
  |---|---|---|
  | UnitingCare QLD | Workday | ✅ done |
  | Uniting NSW/ACT | Dayforce (`unitingaunsw`/`UNITINGCCS`) | ✅ done |
  | Opal HealthCare | Dayforce (`opalhealthcare`/`CANDIDATEPORTALNURSING`) | ✅ done |
  | Uniting Vic/Tas | **Clinch** (`careers.unitingvictas.org.au`) | TODO new build |
  | Uniting AgeWell | **Clinch** (`careers.unitingagewell.org`) | same adapter as Vic/Tas |
  | Uniting SA | **BigRedSky** (`unitingsa.bigredsky.com`) | TODO new build |
  | Uniting WA | ? (`unitingwa.org.au`) | apply-domain not captured |

  **Clinch** (`clinch.ts`, BUILT but PAUSED — AWS WAF): the SEO back-door works —
  `/sitemap.xml` lists every `/jobs/{slug}` and detail pages carry clean JSON-LD
  JobPosting. Adapter = sitemap → role-filter slug → curl_cffi detail → JSON-LD.
  BLOCKER: a SINGLE curl_cffi hit to `/jobs/*` returns 200+JSON-LD, but a SEQUENCE
  (even spaced 1.5s) gets 202 challenge interstitials — AWS WAF behavioural/session
  challenge needing an `aws-waf-token` (headless/JS only). Re-enable when we have a
  headless path (Playwright OOM-disabled, BUG-5) or a got-scraping fingerprint that
  passes. ONLY worth it for **Uniting AgeWell** (35 real aged-care roles: home/
  personal care workers, RN/EN, lifestyle). **DROP Uniting Vic/Tas** — its matches
  are AOD/family-violence/out-of-home-care, NOT aged care.
  **BigRedSky** (SA, `unitingsa.bigredsky.com/page.php?pageID=…&AdvertID=…`): plain
  curl returned **HTTP 000** (connection refused/reset) — needs a cookie bootstrap
  (`NRJobBoardID`) or rejects bare requests. Not yet diagnosed; recon the landing
  `pageID=106` WITH a cookie jar (like the Dayforce bootstrap) before building.

- ✅ **Salvation Army (Salvos) — Workday, VALIDATED AU-only 2026-06-30** (one-row
  in `agedCareWorkday.ts` TENANTS: `salvationarmy`/wd3/`Salvos`). `testAgedCareWorkday.ts`
  returned 8 care-role jobs, 0 overseas across all 218 (the overseas denylist catches
  the exact Bupa-UK/AgeCare-Canada failure mode). Workday is now 7 validated tenants.
- ✅ **SuccessFactors (SAP CSB) DONE + VALIDATED 2026-06-30** (`successFactors.ts`,
  commit on this branch) — first tenant **Australian Unity** (`careers.australianunity.com.au`).
  Live: 123 links → 89 role-matched → **89 full JDs, 0 thin**, 37s. ONE adapter
  unlocks MANY AU aged-care providers (Workday-style leverage); add a tenant = one
  `ORGS` row after a 2-curl recon. **PLAN DIFFERED FROM REALITY:** the detail pages
  carry **NO JSON-LD** — the JD is in `<span itemprop="description"
  class="jobdescription">` (balanced-span extraction), the title in
  `<title>{Title} Job Details | {Company}</title>`, and the suburb/STATE are parsed
  from the rich slug `{Suburb}-{Title}-{STATE}-{postcode}`. JSON-LD kept as a
  fallback for future CSB themes that emit it. Link regex keeps `%2C`/`&amp;` slugs
  + the trailing slash (detail URL needs it). Imperva is passive here (plain fetch
  + UA, no cookie). Enablement migration **076** (unlimited tier) + VALID_SOURCES +
  PlatformSourcesCard ('Aged Care — Aus Unity'). Test: `testSuccessFactors.ts`.
  NEEDS: `flyctl deploy` worker + apply migration 076. Minor cosmetic: a slug word
  before the role keyword can leak into the suburb ("Kilsyth Night Duty") — real
  suburb still present/geocodable, distance gate unaffected.
- 🔵 **Southern Cross Care (SA) — Clinch** (`careers.southerncrosscare.com.au`):
  added to the PAUSED `clinch.ts` ORGS (alongside AgeWell). Comes online when the
  AWS WAF is solved. Confirms Clinch is worth a headless effort (AgeWell + SCC +
  more = several real aged-care tenants behind one adapter).

**Golden rule (we got burned 3×):** never trust a tenant/board until the user
validates it live. "Company X uses ATS Y" ≠ "X's AU jobs are on that Y board."

---

## 📋 SCOUTED CANDIDATE QUEUE (2026-06-30, via web research — NOT yet recon'd)

ATS classification of major AU aged-care providers not yet added. **All UNVALIDATED**
— the next session must run the 2-curl recon before adding any `ORGS`/`TENANTS` row
(golden rule). Detector signatures used: SuccessFactors = `/search/?q=&startrow=` +
`rmkcdn.successfactors.com`; PageUp/Clinch family = `careers.{co}.com.au/jobs/search`
+ `secure.dcN.pageuppeople.com/apply/...`; Workday = `*.myworkdayjobs.com`; Dayforce
= `dayforcehcm.com`; BigRedSky = `*.bigredsky.com/page.php`.

### 🟢 READY — fits a WORKING adapter, recon then add one row
| Provider | ATS | Identifiers | Adapter | Recon |
|---|---|---|---|---|
| **Mercy Health (aged care)** | Workday | tenant `mercyagedcare`, `wd105`, board `External` | `agedCareWorkday.ts` | POST CXS `/jobs` (below) |
| **IRT Group** | SuccessFactors | `careers.irt.org.au` (`/search/?q=`, rmkcdn) | `successFactors.ts` | GET `/search/?startrow=0` + one detail |
| **Catholic Healthcare** | Dayforce | namespace `chl`, **legacy** `dayforcehcm.com/CandidatePortal/en-AU/chl` | `agedCareDayforce.ts` ⚠ | older CandidatePortal URL ≠ the `jobs.dayforcehcm.com/en-AU/{ns}/{board}` flow the adapter uses — needs a network-tab capture, may need a tweak |

Recon commands (run on Mac, residential IP — no `#` lines in zsh paste):
```
curl -s 'https://careers.irt.org.au/search/?q=&startrow=0' -H 'User-Agent: Mozilla/5.0' | grep -o '/job/[^"]*' | sort -u | head
curl -s -X POST 'https://mercyagedcare.wd105.myworkdayjobs.com/wday/cxs/mercyagedcare/External/jobs' -H 'Content-Type: application/json' -d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}'
```
IRT: confirm `/job/{slug}/{id}/` links, then GET one and grep for `class="jobdescription"`
(SF CSB, same as Australian Unity) OR `application/ld+json`. If either present →
add `{ host: "careers.irt.org.au", company: "IRT Group" }` to `successFactors.ts` ORGS.
Mercy: confirm `total` > 0 + AU sample locations → add a `TENANTS` row.

### 🔵 BLOCKED — fits a PAUSED adapter (comes online when that ATS is solved)
| Provider | ATS | Identifiers |
|---|---|---|
| BaptistCare | PageUp | `careers.baptistcare.org.au/jobs/search`, `dc2.pageuppeople.com/apply/999` |
| Benetas | PageUp | `careers.benetas.com.au/jobs/search`, `secure.dc2.pageuppeople.com/apply/1189` |
| VMCH (Villa Maria) | PageUp | `careers.pageuppeople.com/607/...` |
| Brightwater | PageUp/Clinch (likely) | `careers.brightwatergroup.com/jobs/search` — recon to rule out SF |
| Southern Cross Care | Clinch | `careers.southerncrosscare.com.au/jobs/search` — already in paused `clinch.ts` ORGS |
| Carinity | BigRedSky | `qb.bigredsky.com/page.php?pageID=106` — same ATS as Uniting SA (HTTP 000, undiagnosed) |

### ⚪ UNKNOWN ATS — needs a job-detail capture before classifying
Aegis Aged Care (`aegisagedcare.applynow.net.au` — ApplyNow/Scout family), Helping
Hand SA (`helpinghand.org.au/careers/job-vacancies/?se=...` — embedded ATS via `?se=`),
Churches of Christ (`careers.cofc.com.au` custom), Juniper, TriCare, Hall & Prior,
Whiddon (landing pages didn't expose the ATS host).

> Already covered, do NOT re-add: Bolton Clarke + Allity (Workday `boltonclarke/wd105`),
> Regis (Avature), Bupa (Radancy), Uniting NSW/ACT + Opal (Dayforce), Australian Unity (SF).

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
   - `npx tsx src/scripts/testRadancy.ts` → pagination FIXED (commit `5ec41b6`);
     validated 2026-06-29: 269 links → 37 role-matched → 37 full JDs (0 thin).

3. **Full pipeline E2E**: run a healthcare-vertical profile on a founder/
   unlimited account. Watch worker logs for `[agedcare] …` and `[radancy] …`;
   confirm rows land with `source='agedcare'` + non-empty descriptions.

4. ✅ **Fly egress — DONE (2026-06-29)**: Node fetch from `fly ssh console`
   returned bupa 200 + anglicare 200. Datacenter IP reaches both direct; no
   Apify proxy needed. (Test with `node -e "fetch(...)"`, not curl — curl isn't
   in the image.)

---

## 🔭 LATER (backlog, lower priority)

- **Bupa AU coverage**: RESOLVED — pagination fix surfaces 269 listings → 37
  care-role matches (far more than the 52-position category view suggested).

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
