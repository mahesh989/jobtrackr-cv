# Aged-care provider → ATS map

Working registry of Australian aged-care providers and the applicant-tracking
system (ATS) each one runs on. Drives the direct-from-employer scraping roadmap:
we build **one adapter per ATS**, then adding a provider is a one-row change.

**Source of truth:** the apply-link / careers-portal **domain**. That domain
identifies the ATS unambiguously (`*.myworkdayjobs.com` = Workday, etc.).
Values below are inferred from public careers pages via web search and are
**NOT yet API-validated** unless marked ✅. Validate each before adding it with
the two-call check at the bottom.

_Last researched: 2026-06-29._

## ATS detection cheat-sheet (apply-link domain → ATS)

| Domain pattern | ATS | Public JSON API? |
|---|---|---|
| `*.myworkdayjobs.com` | Workday | ✅ CXS — list + full JD |
| `jobs.dayforcehcm.com` / `*.dayforcehcm.com` | Dayforce | ✅ `jobposting/search` — full JD |
| `*.pageuppeople.com` / `secure.dc2.pageuppeople.com` | PageUp | partial (HTML/JSON, per instance) |
| `*.avature.net` | Avature | varies |
| `scouttalent.my.site.com` (Salesforce) | Scout Talent | Salesforce Experience Cloud |
| `jobadder.com` / careers-for-carers board | JobAdder | feed/board |

## Workday cluster — drops into existing `agedCareWorkday.ts` (one row each)

Subdomain encodes the version (`wd3`/`wd10`/`wd105`); board = first path segment.

| Provider | tenant | wdN | board | Status |
|---|---|---|---|---|
| Anglicare | `anglicare` | 105 | `Anglicare_Careers` | ✅ list + JD validated |
| Estia Health | `estiahealth` | 105 | `Estia_Health_Careers` | ✅ list validated (363, AU) |
| HammondCare | `hammondcare` | 105 | `External_Careers` | ✅ list validated (102, AU) |
| Bolton Clarke | `boltonclarke` | 105 | `Careers` | ✅ list validated (211, AU) |
| UnitingCare QLD | `unitingcareqld` | 105 | `UnitingCareCareers` | ✅ list validated (254, AU) |
| RSL LifeCare | `rsllc` | 3 | `rsllc` | ✅ end-to-end (20 jobs, full JDs) |
| ~~Bupa~~ | ~~`bupa`~~ | ~~3~~ | ~~`EXT_CAREER`~~ | ❌ REMOVED — board's `Location_Country` facet has UK/Egypt/HK but **no Australia**; Bupa AU is on another board/system (TBD) |
| ~~AgeCare~~ | ~~`agecare`~~ | ~~10~~ | ~~`AgeCare_Careers_External`~~ | ❌ REMOVED — tenant is **AgeCare Canada** (Calgary), not AU |

→ **6 AU aged-care employers live on one adapter.** End-to-end test (2026-06-29,
`testAgedCareWorkday.ts`) returned **134 jobs with full 3–5k char JDs**: Estia 40
(detail-cap), Bolton Clarke 26, RSL 20, Anglicare 17, UnitingCare QLD 17,
HammondCare 14. Role split 64 nursing / 59 care / 11 admin. To add a global
tenant later, filter AU server-side via the `Location_Country` facet (see the
TENANTS comment in `agedCareWorkday.ts`).

## PageUp cluster — needs `pageup.ts` fleshed out (scaffold exists)

PageUp instances are numbered (the `/NNNN/` path segment).

| Provider | PageUp instance | Status |
|---|---|---|
| BaptistCare | `999` | researched |
| Calvary | `1106` | researched |
| Resthaven | `1140` | researched |
| Arcare | `1073` | researched |
| SA Health (gov; has aged-care roles) | `532` | researched |

→ **5 more providers on a single second adapter.** Highest leverage after Workday.

## Dayforce — needs a new adapter (mirrors Workday; returns full JD)

| Provider | client namespace | Status |
|---|---|---|
| Opal HealthCare (132 homes) | `opalhealthcare` | researched |

API: `POST https://jobs.dayforcehcm.com/api/geo/{client}/jobposting/search`

## Other ATSs (lower priority / no scaffold)

| Provider | ATS | Notes |
|---|---|---|
| Regis Aged Care (84 homes, 14k staff) | Avature (`regis.avature.net`) | ✅ DONE — `avature.ts`, inline-JD listing, 59 care roles |
| Scout Talent clients (many NFP aged-care) | Scout Talent (Salesforce `my.site.com`) | Confirmed big in aged care; Salesforce Experience Cloud |
| "Careers for Carers" board | JobAdder | Aggregator board for smaller providers |

## Unresolved — ATS not yet identified (custom careers domains)

Open each careers page, follow the **apply** button, read the domain it lands on.

- Uniting NSW.ACT — `careers.uniting.org`
- Uniting AgeWell — `unitingagewell.org/careers`
- Australian Unity — `careers.australianunity.com.au`
- Catholic Healthcare — `catholichealthcare.com.au/about-us/careers`
- Whiddon — `whiddon.com.au`
- Mercy Health — `careers.mercy.com.au` (legacy `.aspx` — possibly PageUp)
- Southern Cross Care — `southerncrosscare.com.au/careers`
- St Vincent's Care — `svcs.org.au/people/careers`
- Allity — acquired by Bolton Clarke; check if folded into `boltonclarke` Workday

## Adapter build status (2026-06-29)

| ATS | Adapter file | adapter.name | Status (2026-06-29 validation) |
|---|---|---|---|
| Workday | `agedCareWorkday.ts` | `agedcare` | ✅ **WORKING** — 7 AU boards validated, Anglicare JD-confirmed |
| Dayforce | `agedCareDayforce.ts` | `agedcare_dayforce` | ✅ **WORKING** (commit pending) — bootstrap CSRF session via careers page → POST jobposting/search (full JD inline). Uniting NSW/ACT: 146 listed → 66 care-role full JDs. The old 403 was a wrong body + missing CSRF, NOT Cloudflare |
| PageUp | `pageup.ts` | `pageup` | ⚠ degraded — listings OK (≈20 links/board) but detail is a JS SPA with no JSON-LD → title+URL only, no JD |
| Scout Talent | `scoutTalent.ts` | `scout_talent` | ⚠ unvalidated (Salesforce; JSON-LD likely absent like PageUp) |
| Avature | `avature.ts` | `avature` | ✅ **WORKING** (commit `c141b39`) — Regis: listing server-renders full JD inline (no JSON-LD/detail fetch); paginate via `?jobOffset`, parse `<article article--result>`. 120 listed → 59 care-role full JDs |
| Radancy/TalentBrew | `radancy.ts` | `radancy` | ✅ **WORKING** — pagination fixed (commit `5ec41b6`): /search-jobs/results needs full query string incl. `SearchType=5`. Bupa AU: 269 links → 37 care-role full JDs |

### Validation learnings (why the JS-ATS ones are hard)

- **Workday & Dayforce expose real JSON APIs** — Workday's is open (✅). Dayforce's
  `POST jobs.dayforcehcm.com/api/geo/{client}/jobposting/search` returns 403 for
  Opal even with Chrome-124 TLS impersonation **and** a residential IP, so the
  block is application-level (session cookie / token / wrong path), not TLS.
  Needs a captured network-tab XHR (URL + payload + cookies) to resolve.
- **Modern PageUp / Scout Talent / Avature are JS SPAs** — job detail pages no
  longer embed schema.org JSON-LD, so server-side HTML scraping yields no JD.
  Realistic options: (a) capture each platform's job JSON API from the browser
  network tab and call it directly, or (b) render with a headless browser
  (Playwright — currently disabled on the 512MB Fly VM, BUG-5).
- **Net:** Workday is the reliable direct-scrape win. The JS-based ATSs need
  per-platform API capture or headless rendering before they yield full JDs;
  until then their listings still surface role-matched job links.

Shared role taxonomy + HTML strip: `agedCareRoles.ts`. All emit `source:"agedcare"`
(SOURCE_BONUS 1800). All gated `vertical=healthcare`. Enabled on the unlimited
tier via migrations 070–071. Each fails safe (returns []/throws → skipped).

## Coverage strategy

Two tiers, not infinite adapters:

- **Tier A (direct, full JD):** Workday + PageUp + Dayforce. These three adapters
  alone cover ~14 of the biggest providers with canonical full JDs. Then Avature /
  Scout Talent / JobAdder for further reach.
- **Tier B (breadth, teaser JD):** the long tail of custom/no-API sites is already
  caught by the existing aggregators (SEEK-direct, Adzuna, Careerjet) — they post
  there anyway. Don't build bespoke scrapers per tiny provider.

**Recommended build order:** Workday (✅) → add validated Workday rows → PageUp
(unlocks 5) → Dayforce (unlocks Opal) → resolve unknowns → Avature/Scout Talent.

## Validating a provider before adding it

Workday:
```bash
# 1. List (expect total + jobPostings)
curl -s -X POST "https://{tenant}.wd{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs" \
  -H "Content-Type: application/json" -d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}'
# 2. Detail full JD (use an externalPath from step 1)
curl -s "https://{tenant}.wd{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{board}{externalPath}"
```

Dayforce:
```bash
curl -s -X POST "https://jobs.dayforcehcm.com/api/geo/{client}/jobposting/search" \
  -H "Content-Type: application/json" -d '{}'
```

> Note: these hosts are blocked by the Claude-on-the-web egress policy, so run
> validation locally or from the Fly worker — not from a web session.
