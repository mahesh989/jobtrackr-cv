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

| Provider | tenant | wdN | board (verify) | Status |
|---|---|---|---|---|
| Anglicare | `anglicare` | 105 | `Anglicare_Careers` | ✅ validated |
| Bupa | `bupa` | 3 | `EXT_CAREER` | researched |
| Estia Health | `estiahealth` | 105 | `Estia_Health_Careers` | researched |
| HammondCare | `hammondcare` | 105 | `External_Careers` | researched |
| Bolton Clarke | `boltonclarke` | 105 | `Careers` | researched |
| UnitingCare QLD | `unitingcareqld` | 105 | `UnitingCareCareers` | researched |
| RSL LifeCare | `rsllc` | 3 | `rsllc` | researched |
| AgeCare | `agecare` | 10 | `AgeCare_Careers_External` | researched |

→ **8 of AU's largest aged-care employers on one adapter.** Validate boards, then
add as rows in `TENANTS`.

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
| Regis Aged Care (82 homes, 14k staff) | Avature (`regis.avature.net`) | No scaffold; Avature API varies |
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
