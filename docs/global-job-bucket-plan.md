# Global Job Bucket — Detailed Plan

> Status: **Phase A live on `main`; Phase B/C engine built on branch `feat/global-bucket`.**
> Author session: 2026-06-24/25. Additive to the existing sourcing pipeline.

> ## ARCHITECTURE UPDATE (2026-06-25) — serve-into-`jobs`
> The web reads `jobs` in 31 places and `analysis_runs.job_id` FKs `jobs.id`, so the
> normalized "switch reads to `profile_jobs`" cutover was rejected as too large/risky.
> **Chosen model: serve-into-`jobs`.** `global_jobs` (067) + `search_coverage` (066) are the
> shared bucket + freshness ledger. The worker scrapes only the coverage-driven delta, upserts
> survivors into `global_jobs`, then **materialises each profile's `jobs` rows FROM the bucket**
> (tier-projected JD + the profile's own filters + per-user distance). Consequences:
> - **Zero web changes, no `analysis_runs` FK repoint** — open decision #1 is now MOOT.
> - **`profile_jobs` (068) is reserved/unused** under this model (table stays, harmless).
> - Everything gated by `USE_GLOBAL_BUCKET` (default off); flag off = byte-for-byte old behaviour.
> Where the text below says reads switch to `profile_jobs`, read it as "served into `jobs`".

## 1. Problem & goal

Today every user's job fetch is **per-profile and independent**. Two users searching the
same role (e.g. "AIN" in Melbourne) each run the full source pipeline, each scrape the
same full JDs, each store their own copies. Cost and latency scale linearly with users,
even though they're looking at the *same public postings*.

**Goal:** one **global, deduplicated bucket** of postings that every user's fetch reads
from first. A fetch only scrapes the **delta of days not yet covered** for that
search slice. Unique new postings are added to the bucket; everyone benefits.

Hard requirements from the product owner:
- **One global bucket**, not per-role buckets (easy to query/operate).
- **Respect each profile's filters** — keyword, location, title include/exclude,
  description exclude, working rights. The home-care-vs-aged-care case: an aged-care AIN
  search must NOT surface home-care jobs another user fetched.
- **Respect existing subscription rules** — specifically the Adzuna full-JD rule (below).
  No new frequency/window-depth gating.
- **30-day retention** in the bucket; older postings auto-removed from discovery.
- Additive only; never ALTER base tables; `jobs` stays until an explicit cutover.

## 2. Current architecture (grounded)

| Concern | Where | Behaviour today |
|---|---|---|
| Orchestration | [orchestrator.ts](../backend/worker/src/pipeline/orchestrator.ts) | Runs per profile; one run per `run_pipeline` job. |
| Lookback window | orchestrator.ts:290–330 | First run = 28d deep; else incremental `min(daysSince(lastRun)+1, 30)`. Driven by the **profile's** `run_logs`. |
| Source method by tier | [migration 064](../shared/supabase/migrations/064_platform_source_tiers.sql) | `weekly`/`monthly` → Adzuna **api** (snippet), SEEK direct. `unlimited` → Adzuna **direct/actor** (full JD), SEEK direct. |
| Dedup | [dedup.ts](../backend/worker/src/pipeline/dedup.ts) | L1 url_hash, L2-strong (title+city+company), L2-weak (`possible_duplicate`). Universe = new candidates **+ existing rows for THIS profile** (`fetchExistingJobsForProfile`). |
| Canonical URL | [normalise.ts:44](../backend/worker/src/pipeline/normalise.ts) | Strips utm/ref/src, lowercases, trims trailing slash. |
| Normalisation keys | [normalise/keys.ts](../backend/worker/src/pipeline/normalise/keys.ts) | `normaliseCity` → metro or state code (our **location-cell** primitive). `normaliseTitle`, `normaliseCompany`, `bucketKey`. |
| JD enrichment | orchestrator.ts:669–750 | **Post-dedup** — full JDs fetched only for dedup *survivors* (SEEK direct stage 7, Careerjet actor 7c, Adzuna actor 7d). This is the expensive step. |
| Filters | stages 4c, 10b | Title include/exclude + description-exclude (postFetchFilter), then working-rights filter. Applied **before save**. |
| Save | [save.ts](../backend/worker/src/pipeline/save.ts) | Idempotent upsert into `jobs` on conflict `(profile_id, url_hash)`. |
| Per-user state | `jobs` columns | `seen_at`, `applied_at`, `dismissed_at`, `pool_decision_at`, `manual_jd_text`, `contact_email`, `ai_relevance_score`, `keywords_matched`, `distance_km`. |
| RLS | [migration 002](../shared/supabase/migrations/002_rls.sql) | `jobs` access via join `search_profiles.user_id = auth.uid()`. |

**Key insight:** JD enrichment is *already* post-dedup. So widening the dedup universe from
per-profile to global directly reduces the number of full-JD scrapes — the savings lever is
already in the right place.

## 3. Corrected mental model

Two ranges that must never be conflated:

- **Serve window** = the user's requested window (7d / 28d / 30d). Applied as a read filter
  on the bucket: `posted_at >= now − window`.
- **Scrape delta** = `[slice.last_refreshed_at, now]`. The only thing we actually fetch from
  sources. If the slice was refreshed 2 days ago, we scrape ~2 days regardless of the
  user's serve window.

The bucket's "freshness" is **per search-slice**, never global. A slice =
`(normalised keyword, location-cell, source)`. The product owner's timeline maps exactly:

| Event | Slice state | Action |
|---|---|---|
| User A, "AIN Melbourne", 28d, first run | slice empty | scrape 28d; `covered_through=now−28d`, `last_refreshed_at=now` |
| A again, 7 days later | refreshed 7d ago | scrape delta `[now−7d, now]`; merge unique |
| User B, "AIN Melbourne", 28d, same moment as A's first run | slice fresh (just refreshed) | **0 scrape** — serve 28d from bucket |
| User C, "AIN Melbourne", 28d, 2 days after last refresh | refreshed 2d ago | scrape delta 2d (your "26 from bucket + 2 new"); merge unique |

**Filter on read, never on write.** The bucket stores the **raw unfiltered superset** for a
slice. Each profile's include/exclude/visa/distance filters are replayed at read time into
*that user's* view. A's "exclude home care" never removes rows another user needs.

**Role variants are NOT a taxonomy problem.** Each keyword already fires its own source
search, so coverage is naturally per raw keyword. A request for `{ain, assistant in nursing,
pca, care worker}` serves the **union** of those keyword-slices; the user's own
**title-include** filter (`ain, assistant in nursing, personal care assistant, care worker,
pca`) is the precise relevance gate that keeps home-care out of an aged-care search. No
fragile `role_canonical` collapse is required for correctness — a synonym map is a later
optimization only.

## 4. Data model (additive)

Three new tables. DDL below is a **sketch** for review, not the final migration.

### 4.1 `search_coverage` — the freshness ledger

```sql
create table public.search_coverage (
  id                uuid primary key default gen_random_uuid(),
  keyword_norm      text not null,        -- lower(trim(keyword)), e.g. 'ain'
  location_cell     text not null,        -- normaliseCity() output, e.g. 'melbourne'
  source            text not null,        -- 'seek' | 'adzuna' | 'careerjet'
  last_refreshed_at timestamptz not null, -- newest successful scrape of this slice
  covered_through   timestamptz not null, -- oldest posted_at we have backfilled to
  last_job_count    int not null default 0,
  refreshing        boolean not null default false,  -- single-flight lock (Phase C)
  refresh_started_at timestamptz,                    -- lock staleness guard
  updated_at        timestamptz not null default now(),
  unique (keyword_norm, location_cell, source)
);
create index on public.search_coverage (keyword_norm, location_cell);
-- service-role only RLS (like platform_sources)
```

### 4.2 `global_jobs` — the canonical posting (the bucket)

```sql
create table public.global_jobs (
  id                  uuid primary key default gen_random_uuid(),
  url_hash            text not null unique,   -- sha256(canonicalUrl)
  canonical_url       text not null,
  source              text not null,
  source_tier         int not null default 1,

  title               text not null,
  company             text not null default '',
  location            text not null default '',
  location_cell       text not null default '',  -- normaliseCity(location)
  lat                 double precision,          -- geocoded once, shared
  lng                 double precision,

  -- coarse bucket selector: union of every keyword that ever surfaced this row
  matched_keywords    text[] not null default '{}',

  -- JD storage with tier gating (see §7.2)
  description_snippet text,           -- always present (API/list snippet)
  description_full    text,           -- nullable; full JD when scraped
  jd_access           text not null default 'snippet'
                      check (jd_access in ('snippet','all','unlimited_only')),
  --   'all'            full JD is free-for-everyone (SEEK direct, Careerjet actor)
  --   'unlimited_only' full JD is a paid feature (Adzuna actor)
  --   'snippet'        no full JD yet
  jd_quality          int,            -- reuse classify_jd_quality()

  salary_min          numeric,
  salary_max          numeric,
  visa_likelihood     float,          -- property of the job → global
  sponsorship_status  text,
  citizen_pr_only     boolean,

  posted_at           timestamptz,
  first_seen_at       timestamptz not null default now(),  -- reliable eviction clock
  last_seen_at        timestamptz not null default now(),  -- last scrape that re-saw it
  expires_at          timestamptz,
  is_expired          boolean not null default false,
  is_dead_link        boolean not null default false,

  dedup_status        text not null default 'original',
  duplicate_of        uuid references public.global_jobs(id) on delete set null,
  repost_of           uuid references public.global_jobs(id) on delete set null,

  created_at          timestamptz not null default now()
);
create index on public.global_jobs (location_cell);
create index on public.global_jobs using gin (matched_keywords);
create index on public.global_jobs (posted_at desc);
create index on public.global_jobs (first_seen_at desc);
-- service-role write; no end-user direct read (see §8)
```

### 4.3 `profile_jobs` — per-user link + state (RLS-scoped)

```sql
create table public.profile_jobs (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.search_profiles(id) on delete cascade,
  global_job_id    uuid not null references public.global_jobs(id) on delete cascade,

  keywords_matched text[] not null default '{}',  -- which of THIS user's keywords hit
  ai_relevance_score float,                        -- per-user (depends on their CV)
  distance_km      numeric,                        -- per-user (their home address)
  distance_method  text,

  manual_jd_text   text,                           -- user's own JD edits
  contact_email    text,                           -- user's own recruiter contact

  seen_at          timestamptz,
  applied_at       timestamptz,
  dismissed_at     timestamptz,
  pool_decision_at timestamptz,
  is_starred       boolean not null default false,

  created_at       timestamptz not null default now(),
  unique (profile_id, global_job_id)
);
create index on public.profile_jobs (profile_id, created_at desc);
-- RLS via join to search_profiles.user_id = auth.uid()  (same pattern as jobs today)
```

**What is global vs per-user** (the correctness boundary):

| Global (`global_jobs`) | Per-user (`profile_jobs`) |
|---|---|
| url, title, company, location, lat/lng | `ai_relevance_score` (depends on their CV) |
| description_snippet / description_full / jd_access | `keywords_matched` (their query) |
| visa_likelihood, salary, jd_quality | `distance_km`/`distance_method` (their address) |
| posted_at, first_seen_at, dead-link/expiry | `manual_jd_text`, `contact_email` |
| dedup_status, duplicate_of, repost_of | seen/applied/dismissed/pool/starred |

## 5. Slice key definition

- **keyword_norm** = `lower(trim(keyword))`. Each profile keyword → its own slice (matches
  "each keyword fires a separate search").
- **location_cell** = `normaliseCity(searchLocation)` — the location we *query the source*
  with, NOT per-job location. Falls back to state code, then `''` (= "All Australia").
- **source** = `seek | adzuna | careerjet` (the date-aware sources). Other adapters
  (greenhouse, lever, RSS, gov health) are board-specific and out of scope for slice
  coverage in v1 — they keep per-profile behaviour or are folded in later.

A job's membership in a slice is recorded coarsely via `global_jobs.matched_keywords`
(union) + `location_cell`. Serving selects on overlap; the user's **title-include** filter is
the precise final gate.

## 6. Pipeline flow — before vs after

```
BEFORE (per profile)                    AFTER (bucket-first)
────────────────────                    ────────────────────
1 lookback = f(profile last run)        1 resolve slices = keywords × cell × sources
2 fetch all sources (full window)       2 for each slice: lookback = [last_refreshed_at, now]
3 dedup vs THIS profile's jobs          3 fetch sources only for the delta (skip if fresh & locked → §9)
4 filter (title/desc/visa)              4 dedup candidates vs GLOBAL bucket (url + fingerprint)
5 enrich full JDs (survivors)           5 enrich full JDs for NEW survivors only
6 distance                              6 upsert new/changed rows → global_jobs; bump matched_keywords, last_seen
7 save → jobs                           7 update search_coverage (last_refreshed_at, covered_through)
                                        8 READ projection: bucket rows for slices ∩ window
                                          → apply per-user filters + tier JD gating + distance
                                          → upsert profile_jobs links
                                        9 auto-analyze NEW profile_jobs (unchanged downstream)
```

Concrete orchestrator changes:
- **Lookback block (290–330):** replace per-profile `run_logs` lookup with per-slice
  `search_coverage.last_refreshed_at`. Delta = `[last_refreshed_at, now]`; if no row →
  cold-start 30d (capped at the 30-day retention, not 28).
- **Dedup (`fetchExistingJobsForProfile`):** replace with `fetchBucketCandidates(slices)`
  reading `global_jobs` filtered by `location_cell` + `matched_keywords && sliceKeywords`,
  within 30d. The L1/L2 logic in `dedup.ts` is reused verbatim; only the universe source
  changes.
- **Save:** split into (a) `upsertGlobalJobs()` on conflict `url_hash`, and
  (b) `upsertProfileJobs()` on conflict `(profile_id, global_job_id)`. Dual-write to `jobs`
  during transition (Phase B).
- **New read stage** between dedup/enrich and auto-analyze: `projectForProfile()` — §7.

## 7. Read-time projection (`projectForProfile`)

Given a profile and the candidate `global_jobs` rows for its slices ∩ serve-window:

### 7.1 Filters (replayed per user, never baked into the bucket)
1. **title-include** (`adzuna_title_keywords` / `must_include_phrases`) — keep only titles
   containing any phrase. This is the home-care/aged-care gate.
2. **title-exclude** (`exclude_title_keywords`).
3. **description-exclude** (postFetchFilter "Description must NOT contain").
4. **working-rights / visa** (existing stage 10b logic).
5. **distance** — compute haversine from `global_jobs.lat/lng` to the profile's
   `home_lat/home_lng`; store on `profile_jobs.distance_km`. Geocoding is shared (done once
   on the global row); distance is per-user and cheap.

### 7.2 Tier JD gating (the "respect subscription" rule)
Resolve the reader's tier (existing `loadPlatformSources`). For each row, choose JD text:

| Row `jd_access` | weekly / monthly reader | unlimited reader |
|---|---|---|
| `all` (SEEK direct, Careerjet) | **full** | **full** |
| `unlimited_only` (Adzuna actor) | **snippet** | **full** |
| `snippet` (no full yet) | snippet | snippet → *their run may trigger enrichment* (§9.2) |

So: SEEK full JD is shared with everyone. Adzuna full JD is shown only to unlimited, even
when present in the bucket (an unlimited user populated it). Weekly/monthly always see the
Adzuna snippet. This is enforced purely at read — the bucket stores the richest version once.

## 8. Dedup — pre-scrape vs post-scrape (honesty caveat)

- **Pre-scrape (free, saves the JD fetch):** L1 canonical `url_hash`; L2 fingerprint
  `(normaliseTitle, normaliseCity, normaliseCompany)` — reuse `dedup.ts`. Source list pages
  give title/company/snippet before opening the JD, so anything already in the bucket skips
  full-JD enrichment and just links via `profile_jobs`.
- **Post-scrape (cannot be avoided):** description-similarity for the *same job cross-posted
  on different boards* with different URLs (SEEK + Adzuna + Careerjet). This needs the JD to
  exist, so it's a reconciliation that demotes the loser to `dedup_status='duplicate'`. It
  saves storage and duplicate display, **not** the scrape. Pre-scrape L1/L2 already kills the
  large majority of redundant fetches.

> "Dedup by same description *before* scraping" is physically impossible — the description
> doesn't exist until scraped. The plan delivers the achievable version (URL + fingerprint
> pre-scrape) and a post-scrape cross-board cleanup.

## 9. Concurrency & enrichment-on-read

### 9.1 Single-flight slice lock (thundering herd)
"Many users, same role, same moment" must not trigger N parallel scrapes. Per slice:
- First refresher CAS-sets `search_coverage.refreshing = true, refresh_started_at = now`.
- Concurrent requests see `refreshing = true` → **serve the (possibly slightly stale) bucket
  immediately** and do not scrape. They attach to the in-flight refresh's result on next read.
- Stale-lock guard: `refresh_started_at < now − 10min` → lock considered dead, may be retaken
  (mirrors the worker's existing lock auto-expiry in [index.ts](../backend/worker/src/index.ts)).

### 9.2 Upgrade-on-read (Adzuna full JD)
When an **unlimited** reader hits a row with `jd_access='snippet'` (or `unlimited_only` but
`description_full IS NULL`), their run enriches it via the Adzuna actor and writes
`description_full` + `jd_access='unlimited_only'` back to the shared row — future unlimited
readers reuse it. Weekly/monthly readers never trigger this.

## 10. Retention & eviction (30-day hard window)

- **Serve filter:** every read applies `coalesce(posted_at, first_seen_at) >= now − 30d`. So
  expiry is enforced at read regardless of cleanup timing.
- **Cleanup job** (worker cron, daily): delete `global_jobs` where
  `coalesce(posted_at, first_seen_at) < now − 30d` **AND not referenced** by any
  `profile_jobs` that has `applied_at` or an `analysis_runs` row. Referenced rows are kept
  for history but already excluded from serving by the read filter.
- `search_coverage` rows untouched by age (they're cheap and record freshness); their
  `covered_through` is clamped to `now − 30d`.
- **Staleness accepted:** a served row may have died since scraping. We do **not** re-verify
  liveness proactively (that would cost a fetch and defeat the savings). `is_dead_link` is set
  lazily on click-through (existing behaviour). Documented trade-off.

## 11. RLS & privacy

- `global_jobs` + `search_coverage`: **service-role only**, like `platform_sources`. No
  end-user client may read them directly (prevents bucket enumeration).
- `profile_jobs`: RLS via join `search_profiles.user_id = auth.uid()` — identical pattern to
  `jobs` today. Users only ever see their own links.
- Per-user PII (`manual_jd_text`, `contact_email`) lives only on `profile_jobs`, never shared.

## 12. Backfill / migration strategy

Riskiest step; gated behind the `migration-checker` subagent.
1. Create the three tables (additive; no ALTER on `jobs`).
2. **Backfill `global_jobs`** from existing `jobs`: group by `url_hash`, pick a winner per
   group (richest description, freshest `posted_at`), union `matched_keywords`,
   set `jd_access` by source/length heuristic, geocode lat/lng if derivable.
3. **Backfill `profile_jobs`**: one row per existing `jobs` row, mapping `profile_id` +
   resolved `global_job_id`, copying per-user state (`applied_at`, `dismissed_at`,
   `manual_jd_text`, `contact_email`, `ai_relevance_score`, `seen_at`, etc.).
4. **Dual-write window:** save stage writes BOTH `jobs` (old) and `global_jobs`/`profile_jobs`
   (new). UI/reads migrate to the new tables behind a feature flag.
5. **Cutover:** once reads are fully on `profile_jobs`, stop writing `jobs`. Keep `jobs`
   read-only for rollback for one release, then retire.
6. **Rollback:** feature flag flips reads back to `jobs`; dual-write means `jobs` stays
   current throughout the window.

`analysis_runs.job_id` currently FKs `jobs`. Decision needed at Phase B: either keep
`analysis_runs` pointing at `jobs` (and keep `jobs` as the per-user row), or repoint to
`profile_jobs`. Leaning **keep `jobs` as the per-user row and make `profile_jobs` an alias/
superset is too messy** — cleaner is: `profile_jobs` *replaces* `jobs` as the per-user row and
`analysis_runs.job_id` is repointed to `profile_jobs.id` in a later migration. Flagged as an
open decision (§16).

## 13. Phasing & verification gates

Each phase ends on a Vercel-preview manual gate, per CLAUDE.md.

- **Phase A — Coverage ledger + slice engine (write-only). ✅ landed (not applied/deployed).**
  Add `search_coverage` (migration 066); add `pipeline/coverage.ts` (`resolveSlices`,
  `normaliseKeyword`, `recordCoverage` write-only; `readCoverage`/`computeDeltaDays` defined
  for B but not yet called); orchestrator records coverage after each successful run,
  try/catch-guarded so a not-yet-applied migration no-ops.
  **Decomposition correction:** acting on coverage (scrape-delta + bucket serve) is **coupled**
  to the table split — making profile B scrape only the delta *without* serving it the rows
  profile A already holds (those live under A's `profile_id` in today's per-profile `jobs`)
  would **regress** B's results. So the lookback-flip and the serve ship **together in Phase B**,
  not in A. Phase A only warms the ledger; existing scrape depth is unchanged.
  *Gate:* apply migration 066; run a profile; confirm `search_coverage` populates with the right
  slices and the pipeline is otherwise unchanged (no behaviour difference).

- **Phase B — Canonical/link split + backfill.**
  `migration-checker` first. Create `global_jobs`/`profile_jobs`; backfill; dual-write;
  reads behind a flag; eviction cleanup job; 30-day retention.
  *Gate:* applied/dismissed/manual-JD state survives a simulated eviction; RLS blocks a
  browser client from reading `global_jobs` directly; bucket hit serves with 0 scrape.

- **Phase C — Single-flight locks + upgrade-on-read.**
  Slice `refreshing` CAS + stale-lock guard; Adzuna upgrade-on-read for unlimited.
  *Gate:* 5 concurrent identical requests → exactly 1 scrape (verify `run_logs`); a
  free-then-unlimited read sequence leaves a `description_full` populated row.

- **Phase D — Admin observability + cutover.**
  Bucket hit-rate, full-JD scrapes avoided, est. cost saved on the admin sourcing page.
  Retire `jobs` writes once reads are stable.
  *Gate:* admin dashboard shows hit-rate > 0 and a non-zero "scrapes avoided" counter under
  multi-user load.

## 14. Test plan

- **Unit:** slice-key derivation (keyword/location normalisation); delta computation from
  `last_refreshed_at`; read-time filter replay (title include/exclude, desc exclude, visa);
  tier-JD projection matrix (§7.2); eviction predicate (referenced rows kept).
- **Integration (worker):** two profiles same slice → second scrapes delta only; cross-board
  duplicate demoted post-scrape; upgrade-on-read writes back full JD.
- **Concurrency:** simulated N-parallel same-slice → 1 scrape.
- **RLS:** browser client cannot select `global_jobs`/`search_coverage`; can select only own
  `profile_jobs`.
- **Migration:** backfill idempotency; dual-write parity between `jobs` and
  `global_jobs`+`profile_jobs`; rollback flips cleanly.

## 15. File / artifact inventory (anticipated)

- New migrations: `0xx_search_coverage.sql`, `0xx_global_jobs.sql`, `0xx_profile_jobs.sql`,
  `0xx_profile_jobs_rls.sql`, `0xx_backfill_bucket.sql` (numbers assigned via
  `migration-checker`).
- Worker: `pipeline/coverage.ts` (slice resolve + freshness + lock), `pipeline/bucket.ts`
  (`fetchBucketCandidates`, `upsertGlobalJobs`), `pipeline/project.ts`
  (`projectForProfile` + tier JD), `pipeline/evict.ts` (cleanup cron). Edits to
  `orchestrator.ts` (lookback + stage wiring), `dedup.ts` (universe source), `save.ts`
  (split writes).
- Web: read paths (`dashboard/page.tsx`, applications, analyze) switch to `profile_jobs`
  behind a flag; admin sourcing page gains bucket metrics.
- Docs/graph: update `.claude/graph.json` build_state + entities; this doc kept current.

## 16. Open decisions / risks

1. **`analysis_runs.job_id` repointing** (§12) — keep on `jobs` vs move to `profile_jobs`.
   Decide at Phase B start; affects backfill order and the cutover migration.
2. **Non-date-aware sources** (greenhouse, lever, RSS, gov health) — v1 keeps them
   per-profile / outside slice coverage. Confirm that's acceptable or fold a subset in.
3. **Location-cell coarseness** — `normaliseCity` collapses to metro/state. Two users with
   different radii share the same cell; distance is filtered per-user on read, so this is
   safe, but very fine-grained suburb searches all map to one metro cell (acceptable for v1).
4. **`posted_at` reliability** — using `first_seen_at` as the eviction/window fallback when
   `posted_at` is null. Some sources give relative dates; ingestion-time fallback is the
   safe clock.
5. **Adzuna snippet retention** — we must keep `description_snippet` even after a full JD is
   fetched, so weekly/monthly readers still have something to show. Storage cost is minor.
6. **Geocoding source** — where lat/lng comes from for `global_jobs` (existing distance
   stage already resolves coordinates; reuse that resolver, store on the global row).
7. **Bucket-served runs vs live run caps (Phase D, web-layer).** graph.json Phase 13 billing
   is live: `weekly` = 30 runs/period, `monthly` = 120, `unlimited` = ∞, enforced **only** at
   the 4 web choke points (worker untouched). A bucket-first fetch that scrapes 0 days is much
   cheaper than a full run — decide whether such a read still counts against the cap. The worker
   stays cap-agnostic; this is a web-layer policy call for Phase D. Does not affect A–C.
8. **No worker test harness** — backend/worker has only `tsc --noEmit` (no unit tests). All
   bucket logic is verified by typecheck + the per-phase Vercel-preview gate. Consider adding a
   minimal test runner for `coverage.ts`/dedup/projection during Phase B.
