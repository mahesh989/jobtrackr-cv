# JobTrackr-CV — Integration Design

> The full architectural plan for integrating the cv-magic CV-tailoring pipeline into JobTrackr. This document is the source of truth for **what** we are building. `.claude/graph.json` tracks **how far** we have got.

## 1. Summary

JobTrackr v2 absorbs the cv-magic CV-tailoring pipeline as an **internal feature module**. Users only ever see one domain, one product, one sign-in. The Python pipeline service is invisible plumbing on Fly.io with no public-facing URL.

- **One domain** — Vercel auto URL for the new project (custom domain deferred). Production JobTrackr stays at its own URL, untouched.
- **One identity** — Supabase auth for everything. cv-magic's Clerk is stripped.
- **One database** — shared Supabase project, additive tables only.
- **Same-tab navigation** — analysis is a JobTrackr route (`/jobs/[id]/analyze/[run_id]`), not a separate site.
- **Private Python service** — `cv-backend` runs on Fly.io and is only ever called by JobTrackr's Next.js API routes. Users never hit it directly.
- **BYOK** — Anthropic / OpenAI keys live in JobTrackr settings, encrypted with the same AES helper used for Apify.

cv-magic, as a separate product, ceases to exist in this project. It is folded in.

## 2. Architecture

```
                                    Browser
                                       │
              ┌────────────────────────┴────────────────────────┐
              │                                                 │
              ▼                                                 ▼
   ┌──────────────────────┐                          ┌──────────────────┐
   │  JobTrackr-CV web    │                          │ Supabase Realtime│
   │  Next.js — main UI   │ ◄────── subscribe ───────│  postgres_changes│
   │  (Vercel preview)    │         (analysis_runs)  │  on analysis_runs│
   └──────────┬───────────┘                          └──────────────────┘
              │                                              ▲
              │ POST /internal/analyze  (HMAC-signed)        │
              │                                              │ UPDATE step_status,
              ▼                                              │ step results
   ┌──────────────────────┐                                  │
   │  cv-backend          │  ──────── writes ────────────────┘
   │  FastAPI on Fly.io   │
   │  Python pipeline     │
   │  (BackgroundTasks)   │
   └──────────┬───────────┘
              │
              ▼ uploads tailored.md + tailored.pdf
   ┌──────────────────────┐
   │  Supabase Storage    │
   │  tailored-cvs/...    │
   └──────────────────────┘
```

| Service | Hosting | Purpose |
|---|---|---|
| `web/` | Vercel `jobtrackr-cv` | JobTrackr UI + new CV/analysis pages |
| `worker/` | Fly.io `jobtrackr-cv-worker` | Existing job-discovery pipeline (unchanged) |
| `backend/api/` | Fly.io `jobtrackr-cv-api` | CV-tailoring pipeline (added in Phase 2) |
| Postgres + Storage + Realtime | Supabase | Shared with production JobTrackr — additive tables only |

## 3. Locked decisions

| Decision | Value | Rationale |
|---|---|---|
| cv-backend hosting | Fly.io, region `syd` | No cold start; co-located with Supabase |
| AI keys | BYOK (Anthropic, OpenAI) | Zero platform AI cost; removes quota module |
| CV versioning | Many per user, one `is_active=true` at a time | Mirrors cv-magic UX |
| Stale strategy | New run on same (user, job) marks priors `is_stale=true`. Re-run is always user-triggered. JD-change detection deferred. | Simple, predictable |
| Realtime | Supabase `postgres_changes` on `analysis_runs` row | Same pattern as cv-magic |
| Internal auth | HMAC-SHA256 of (timestamp + body), shared secret in env | No JWKS, no DB round-trip |
| Git | This repo on its own; production JobTrackr untouched | Zero blast radius |
| PDF generation | Stays in Python (ReportLab) | Zero porting risk |
| cv-backend auth surface | None public; trusts HMAC from JobTrackr only | Single internal caller |
| Supabase project | Shared with production JobTrackr | New tables isolated from production code paths |

## 4. Data model (new tables in shared Supabase)

### `cv_versions`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → auth.users | |
| label | text | "Master CV — 2026" |
| pdf_storage_path | text | `cvs/{user_id}/{cv_id}.pdf` |
| cv_text | text | Extracted server-side via pypdf |
| is_active | boolean | Partial unique index |
| created_at | timestamptz | |

Partial unique index: `(user_id) WHERE is_active = true`.

### `analysis_runs`

Mirrors cv-magic's model with `company_id` renamed to **`job_id`** (FK → JobTrackr's `jobs.id`).

Columns: `id`, `user_id`, `job_id`, `cv_version_id`, `status`, `step_status` (jsonb 7 steps), `jd_text`, `jd_analysis_result`, `cv_jd_matching_result`, `ats_scoring_result`, `input_recommendations`, `keyword_feasibility`, `ai_recommendations`, `tailored_cv_storage_path`, `tailored_pdf_storage_path`, `tailored_ats_scoring_result`, `injected_keywords`, `match_score`, `tailored_match_score`, `ats_lift`, `is_stale`, `error_message`, `started_at`, `completed_at`, `created_at`.

### `user_integrations` (existing — extend allowed `provider` values)

Add `"anthropic"` and `"openai"` to the existing provider check/enum. Reuse the AES-256-GCM crypto helper and CRUD routes pattern.

### RLS + Realtime

- `cv_versions`, `analysis_runs`: users read/write only their own (`user_id = auth.uid()`).
- Add `analysis_runs` to the `supabase_realtime` publication.
- cv-backend writes via Supabase service-role (bypasses RLS).

## 5. Bridge contract

### JobTrackr → cv-backend

**POST** `https://jobtrackr-cv-api.fly.dev/internal/analyze`

Headers:
- `X-Timestamp: <unix-seconds>`
- `X-Signature: hmac-sha256(secret, timestamp + body)`

Body:
```jsonc
{
  "run_id":         "uuid",         // pre-created by JobTrackr
  "user_id":        "uuid",
  "jd_text":        "...",          // resolved by JobTrackr
  "jd_source_url":  "https://...",
  "jd_meta":        { "title": "...", "source": "seek", "company": "..." },
  "cv_version_id": "uuid",
  "cv_text":        "...",          // already extracted
  "ai_provider":    "anthropic",
  "ai_api_key":     "sk-ant-..."    // decrypted, in-memory only
}
```

Response: `202 Accepted` with `{ run_id }`. Pipeline runs in FastAPI BackgroundTasks.

### Helper endpoints (also HMAC-signed)

- **POST `/internal/extract-cv-text`** — body: `{ storage_path }` → `{ cv_text }`. Called during CV upload.
- **POST `/internal/scrape-jd`** — body: `{ url }` → `{ jd_text, job_title }`. Called only when JD too thin.

## 6. User flows

### 6a. First-time setup
1. User logs in to JobTrackr (existing Supabase auth).
2. Dashboard banner: "Add a CV and an AI key to enable Analyze."
3. `/cv` page → upload PDF → frontend uploads to Supabase Storage → backend calls `cv-backend /internal/extract-cv-text` → saves `cv_versions` row with `is_active=true`.
4. `/settings/ai-keys` page → paste key → validated against provider `/me` endpoint → encrypted → saved.

### 6b. Analyzing a job
1. **Analyze** button on each job card. State machine:
   - No active CV → disabled, tooltip "Upload a CV first"
   - No AI key → disabled, tooltip "Add an API key first"
   - Run exists & not stale → button reads "View analysis"
   - Else → enabled
2. Click → `POST /api/jobs/[id]/analyze`:
   - Verify ownership (RLS on `jobs`)
   - Load active `cv_version`, decrypt active AI key
   - **Decide JD source:**
     - `source === "seek"` → use `job.description` as-is
     - `source === "adzuna"` and `length < 600` → call `/internal/scrape-jd`. Fail if returned text < 200 chars.
     - Otherwise → use `job.description`
   - Mark prior `analysis_runs` for `(user_id, job_id)` as `is_stale=true`
   - INSERT new `analysis_runs` row with `status='pending'`
   - HMAC-sign and POST to cv-backend `/internal/analyze`
   - Return `{ run_id }`
3. Browser navigates to `/jobs/[id]/analysis/[run_id]`.
4. Page subscribes to Realtime on the row; step cards animate as `step_status` updates.
5. On `tailored_cv` complete → "Download tailored CV" appears (signed Storage URL).

### 6c. Re-run
"View analysis" exposes a "↻ Re-run" affordance → same as 6b, marks the previous run stale.

## 7. What gets copied from cv-magic

### Backend Python (copy → strip → deploy as Fly.io `jobtrackr-cv-api`)

| Keep | Strip | Add |
|---|---|---|
| `services/pipeline/` (orchestrator + all 7 steps) | `core/auth.py`, `utils/clerk.py` | `app/security/hmac.py` (HMAC middleware) |
| `services/ai/client.py` + `prompts.py` | `core/quota.py`, `services/billing/` | `/internal/analyze`, `/internal/extract-cv-text`, `/internal/scrape-jd` |
| `services/cv/pdf_generator.py`, `contact_line.py`, `skill_categoriser.py` | `services/notifications/` | Service-role Supabase writes (replace SQLAlchemy session) |
| `services/scraping/jd_scraper.py` | `routes/billing.py`, `routes/webhooks.py`, `routes/users.py`, `routes/companies.py`, `routes/cv_versions.py`, `routes/analysis_runs.py` | |
| `services/pipeline/jd_expiry.py`, `cv_resolver.py` (simplified) | All Alembic migrations (Supabase manages schema) | |
| | `models/user.py`, `models/company.py`, `models/user_preference.py` | |

AI client adapted to take `(provider, api_key)` from request payload instead of `User.ai_api_key`.

**Bug to fix during copy:** `_extract_text_from_pdf` runs sync `pypdf` inside async — wrap in `asyncio.to_thread`.

### Frontend (copy from cv-magic to `web/`)

- All of `components/analysis/*` — 12 cards/progress components.
- `lib/supabase.ts` realtime subscription helper.
- `components/cv/cv-client.tsx` — repurposed for the `/cv` upload page.

### NOT copied
- `frontend/(auth)/*` — JobTrackr already has Supabase auth.
- `components/billing/*` — no billing.
- Anything Clerk- or Stripe-related.

## 8. Phased implementation plan

Each phase ends in a manual verification gate. Do not advance until the gate passes.

### Phase 0 — Setup & infra
- Create this repo, push to GitHub
- Create Vercel project pointed at this repo
- Set up Fly.io `jobtrackr-cv-worker` app (copy config from JobTrackr)
- Create Fly.io `jobtrackr-cv-api` app (empty hello-world FastAPI)
- Set env vars on Vercel (Preview scope only — no Production scope yet)
- **Gate:** Vercel preview URL loads JobTrackr unchanged.

### Phase 1 — Data model
- Write migration SQL: `010_cv_versions.sql`, `011_analysis_runs.sql`, `012_extend_user_integrations.sql`
- Apply via Supabase SQL editor
- Add RLS + Realtime publication
- **Gate:** Manual INSERT/SELECT works; Realtime fires for a test row.

### Phase 2 — cv-backend skeleton
- Copy `cv-magic/backend/` → `backend/api/`
- Strip Clerk, Stripe, quota, Resend modules
- Add HMAC middleware
- Adapt AI client to BYOK
- Add `/internal/*` route stubs
- Deploy to Fly.io
- **Gate:** signed `curl` returns 202; Fly logs show "received run X".

### Phase 3 — CV upload UI + flow
- `/cv` page (upload, list, set-active, delete)
- `POST /api/cv`, `PATCH /api/cv/[id]`
- **Gate:** Upload a PDF on preview, see extracted text, switch active.

### Phase 4 — AI key UI + flow
- `/settings/ai-keys` page (mirror existing Apify pattern)
- `POST /api/integrations/anthropic`, `/api/integrations/openai`
- **Gate:** Paste real key, see validated, masked.

### Phase 5 — End-to-end with **only step 1 wired**
- Analyze button + state machine
- `POST /api/jobs/[id]/analyze` route
- `/jobs/[id]/analysis/[run_id]` page (minimal — subscribes to Realtime)
- cv-backend orchestrator runs only `run_jd_analysis`, then stops
- **Gate:** Click Analyze on a SEEK job → see step 1 JSON appear live.

### Phase 6 — Wire remaining steps + result cards
- Re-enable steps 2–6.6 in orchestrator
- Copy `components/analysis/*` into `web/`
- **Gate:** Full pipeline runs end-to-end; all cards render correctly.

### Phase 7 — Tailored CV PDF + viewer
- Enable PDF branch in orchestrator
- Download + preview UI
- **Gate:** PDF downloads with correct formatting.

### Phase 8 — Scrape path + re-run + history
- Test Adzuna scrape branch
- Manual-paste fallback when scrape fails
- "Analysis history" tab showing stale runs
- **Gate:** Adzuna analyze works; re-run marks prior stale; history shows.

### Phase 9 — Polish + promote
- Empty-state copy, error styling
- Optional: promote to production (separate decision)
- **Gate:** End-to-end test on preview clean.

**Total estimate:** ~20 hours of careful work, broken across however many sessions.

## 9. Git workflow

- Single repo, `main` branch deploys to Vercel preview.
- Optional feature branches if doing experimental work; otherwise commit straight to `main` since this whole repo IS the preview.
- Production JobTrackr lives in its own repo at `/Users/mahesh/Documents/Next Phase Cleaning/APPlication/JobTrackr` — never push there from this one.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Shared Supabase: bad migration breaks JobTrackr prod | New tables only — no ALTER on existing tables; `user_integrations.provider` change is additive |
| HMAC misconfigured | Phase 2 gate is a manual signed `curl` |
| Realtime not configured | Phase 1 gate verifies Realtime fires |
| Adzuna scrape fails | Phase 8 includes manual-paste fallback |
| PDF generator dependencies | cv-magic's existing Dockerfile already handles ReportLab + fonts |
| Fly.io cold start | Paid plan, no sleep |
| API key exposure | Encrypted at rest, never returned via API, scrubbed from logs |

## 11. Decisions still open (revisit before Phase 5)

1. **Provider support v1** — both Anthropic and OpenAI, or just Anthropic?
2. **PDF viewer** — inline iframe or download-only?
3. **JD-scrape fallback UX** — auto-fail-then-retry, or modal with "paste JD manually"?
