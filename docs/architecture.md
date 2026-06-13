# JobTrackr-CV — Architecture Reference

> Companion to `design.md` (which has the full phase plan and locked decisions).
> This doc is the quick-reference for planners and contributors — system shape,
> file locations, and boundaries at a glance. Keep it current when topology changes.

---

## Tech Stack

| Service | Runtime | Key Libraries | Host |
|---|---|---|---|
| **frontend/web** | Next.js 16.2.6 / React 19 / TypeScript | `@supabase/ssr`, `@supabase/supabase-js`, BullMQ, Tailwind v4 | Vercel |
| **backend/api** | Python 3.11 / FastAPI 0.115.5 / Uvicorn | `anthropic 0.97`, `openai 1.109`, `reportlab 4.2.2`, `pypdf 5.1.0`, `python-docx 1.1.2` | Fly.io (`jobtrackr-cv-api`, region: `syd`) |
| **backend/worker** | Node.js / BullMQ ^5.13 / ioredis ^5.4 | Apify actors in `backend/worker/apify-actors/` | Fly.io (`jobtrackr-worker`) |
| **database** | Supabase Postgres | Supabase Auth, RLS, Realtime, Storage | Supabase (shared with production JobTrackr) |

backend/api Fly.io machine spec: `shared-cpu-1x`, 512 MB RAM, `min_machines_running = 1` (kept warm to avoid cold-start timeouts on Vercel Hobby's 10 s function limit).

---

## Repository Layout

```
jobtrackr-cv/
├── frontend/
│   └── web/                            # Next.js app (Vercel)
│       └── src/
│           ├── app/                    # App Router — pages + API routes
│           │   └── api/                # Server-only API routes (HMAC caller lives here)
│           ├── components/             # React components
│           └── lib/
│               └── cvBackend.ts        # HMAC-signed caller to backend/api (server-only)
├── backend/
│   ├── api/                            # FastAPI pipeline service (Fly.io: jobtrackr-cv-api)
│   │   ├── app/
│   │   │   ├── routes/internal/        # /internal/* endpoints (HMAC-protected)
│   │   │   ├── security/hmac.py        # FastAPI dependency: verify_hmac
│   │   │   ├── services/
│   │   │   │   ├── ai/
│   │   │   │   │   ├── client.py             # BYOK AI client (Anthropic / OpenAI / DeepSeek)
│   │   │   │   │   └── prompts/              # Per-step prompt templates package
│   │   │   │   ├── cv/
│   │   │   │   │   ├── skill_categoriser.py  # CV skill extraction (upload-time)
│   │   │   │   │   └── pdf_generator.py      # ReportLab PDF generation
│   │   │   │   └── pipeline/
│   │   │   │       ├── orchestrator.py       # Top-level pipeline runner (BackgroundTask)
│   │   │   │       └── steps/                # One file per pipeline step
│   │   │   └── ...
│   │   └── fly.toml
│   └── worker/                         # Job-discovery worker (Fly.io: jobtrackr-worker)
├── shared/
│   └── supabase/migrations/            # SQL migrations (manually applied, CLI-untracked)
└── docs/                               # This folder
```

---

## Data Flow

### CV Upload
```
Browser → POST /api/cv
  → Supabase Storage upload (cvs/{user_id}/{cv_version_id}.pdf)
  → callCvBackend("/internal/extract-cv-text", { storage_path })
    → cv-backend: pypdf / python-docx extracts plain text
  → INSERT cv_versions (cv_text, pdf_storage_path, is_active)
  → [optional] callCvBackend("/internal/categorise-cv", { cv_text, ai_key })
    → cv-backend: LLM classifies skills → technical/soft_skills/domain_knowledge
  → UPDATE cv_versions (categorised_skills)
```

### Job Analysis (7-step pipeline)
```
Browser → POST /api/jobs/[id]/analyze
  → [if JD short] callCvBackend("/internal/scrape-jd", { url })
  → INSERT analysis_runs (status=pending, step_status={all: pending})
  → callCvBackend("/internal/analyze", { run_id, cv_text, jd_text, ai_key, ... })
    → cv-backend: returns 202 immediately; pipeline runs as BackgroundTask
    → Step 1: jd_analysis.py        → jd_analysis_result
    → Step 2: cv_jd_matching.py     → cv_jd_matching_result + match_score
    → Step 3: ats_scoring.py        → ats_scoring_result
    → Step 4: input_recommendations.py → input_recommendations
    → Step 4.5: keyword_feasibility.py → keyword_feasibility
    → Step 5: ai_recommendations.py → ai_recommendations (markdown)
    → Step 6: tailored_cv.py        → tailored CV markdown
              + tailored_rescoring.py + tailored_structural_validation.py
    → pdf_generator.py → ReportLab PDF
    → Supabase Storage upload (tailored-cvs/{user_id}/{run_id}.pdf)
    → UPDATE analysis_runs (status=completed, all result columns, tailored_pdf_storage_path)
  ← Browser Realtime subscription (postgres_changes on analysis_runs row)
     fires on each step_status update → UI cards render progressively
```

After each step: `mark_step(run_id, step_name, "completed")` writes to `analysis_runs.step_status` (JSONB), which triggers the Realtime event.

---

## Auth Boundary

**Supabase Auth** handles all user identity. Sessions are managed by `@supabase/ssr` in `frontend/web/src/middleware.ts`.

Every table has RLS enforced: `auth.uid() = user_id`. No table is readable by unauthenticated requests. See `docs/database.md` for the full RLS policy summary.

backend/api never sees user sessions. It receives `user_id` as a plain field in HMAC-signed request payloads and writes directly to Supabase using the **service-role key** (bypasses RLS — intentional for pipeline writes).

---

## HMAC Boundary (frontend/web ↔ backend/api)

backend/api has **no public auth surface** — it is Fly.io private networking only. Every call from Next.js API routes must be signed.

**Signing (frontend/web/src/lib/cvBackend.ts):**
```
X-Timestamp: <unix-seconds>
X-Signature: HMAC-SHA256(JOBTRACKR_HMAC_SECRET, timestamp_string + raw_json_body)
```

Encoding: the timestamp is concatenated as its ASCII decimal string representation (not packed bytes), followed by the raw JSON body bytes. Both sides must agree on this — see `frontend/web/src/lib/cvBackend.ts` and `backend/api/app/security/hmac.py` for the canonical implementation.

**Verification (backend/api/app/security/hmac.py):**
- Missing headers → 401
- Timestamp outside ±5 min window → 401 (replay protection)
- Signature mismatch → 401 (constant-time compare)

Both sides share `JOBTRACKR_HMAC_SECRET` via environment variables (Vercel env + Fly.io secrets).

---

## BYOK AI Client

Users store their own Anthropic / OpenAI / DeepSeek API keys, encrypted AES-256-GCM in `user_integrations`. The web layer decrypts and passes the plaintext key to backend/api in each HMAC-signed request body — **keys never touch backend/api's database**.

`backend/api/app/services/ai/client.py` receives `(provider, api_key, model)` per-request and routes to the correct SDK. Falls back to provider default model if stored model fails or returns "not a chat model" error.

---

## Internal API Endpoints

All backend/api endpoints require HMAC verification (`verify_hmac` FastAPI dependency):

| Endpoint | Method | Purpose | Timeout |
|---|---|---|---|
| `/health` | GET | Health check (no auth) | — |
| `/internal/analyze` | POST | Start 7-step pipeline (BackgroundTask) | returns 202 immediately |
| `/internal/extract-cv-text` | POST | Extract plain text from PDF/DOCX in Storage | 60 s |
| `/internal/scrape-jd` | POST | Scrape JD text from URL (BeautifulSoup) | 20 s |
| `/internal/categorise-cv` | POST | Extract + classify CV skills via LLM | 45 s |

---

## Deployment

| Service | App name | Region | Deploy trigger |
|---|---|---|---|
| frontend/web | `jobtrackr-cv` (Vercel project) | auto | Push to `main` |
| backend/api | `jobtrackr-cv-api` (Fly.io) | `syd` | `flyctl deploy` (manual) |
| backend/worker | `jobtrackr-worker` (Fly.io) | — | `flyctl deploy` (manual) |

**backend/api deploys are manual** — `flyctl deploy` from `backend/api/`. Code changes to backend/api do not auto-deploy on git push.

Vercel environment variables set in Vercel dashboard. Fly.io secrets set with `flyctl secrets set --app jobtrackr-cv-api KEY=value`.

---

## Non-Negotiable Constraints

1. **Never modify production JobTrackr** at `/Users/mahesh/Documents/Next Phase Cleaning/APPlication/JobTrackr`.
2. **Additive DB changes only** — never ALTER existing JobTrackr tables (jobs, search_profiles, etc.). New tables and new `user_integrations.provider` values only.
3. **backend/api stays Python** — ReportLab PDF output is not portable; all pipeline logic stays in backend/api.
4. **BYOK only** — no platform AI spend. Keys flow in request payloads; never stored in backend/api.
5. **RLS on everything** — every new table gets RLS. Service-role key used only in backend/api pipeline writes.

See `design.md` for the full locked-decisions list and phase verification gates.
