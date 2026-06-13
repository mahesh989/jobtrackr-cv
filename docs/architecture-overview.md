# JobTrackr-CV — Architecture at a glance

**Product:** a job-application SaaS. It (1) **discovers** relevant jobs from ~25
sources, and (2) **tailors the user's CV + writes a cover letter** for any job
on demand using their own AI keys (BYOK). One Supabase database ties it together.

If you've just landed in this repo and can't tell what's frontend vs backend —
this page is the map. **There is one frontend and two backends.**

---

## The three services (this is the whole system)

```
                          ┌──────────────────────────────────────┐
        browser  ───────▶ │  frontend/web/  (Next.js, Vercel)    │
                          │  • the entire UI                     │
                          │  • ~40 API routes = a thin BFF       │
                          └───────┬───────────────────────┬──────┘
                                  │                       │
                 HMAC-signed HTTP │                       │ enqueue job (Redis)
                                  ▼                       ▼
              ┌───────────────────────────┐   ┌──────────────────────────┐
              │ BACKEND 1: backend/api/    │   │ BACKEND 2: backend/worker/│
              │ FastAPI (Python), Fly.io   │   │ Node + BullMQ, Fly.io     │
              │ ── CV-TAILORING pipeline    │   │ ── JOB-SOURCING pipeline   │
              │ tailors CV, writes letters, │   │ scrapes ~25 sources,      │
              │ generates the PDF           │   │ normalises, dedups, saves │
              └─────────────┬──────────────┘   └────────────┬─────────────┘
                            │                                │
                            └──────────┬─────────────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │  Supabase (Postgres +     │
                          │  Storage + Realtime)      │
                          │  shared/supabase/         │
                          │  27 tables, RLS on 26     │
                          └──────────────────────────┘

  External: Upstash Redis (queue + rate-limit) · Apify (scraper actors) ·
            Stripe (billing) · Resend (email) · Sentry (errors)
```

| | `frontend/web/` | `backend/worker/` | `backend/api/` |
|---|---|---|---|
| **Role** | Frontend + thin API/BFF | Job-sourcing pipeline | CV-tailoring pipeline |
| **Language** | TypeScript | TypeScript | Python |
| **Framework** | Next.js (App Router) | BullMQ workers | FastAPI |
| **Host** | Vercel | Fly.io (`jobtrackr-worker`) | Fly.io (`jobtrackr-cv-api`) |
| **Talks to browser?** | Yes | No | No (HMAC-only, internal) |
| **Triggered by** | user | Redis queue / cron | `frontend/web` API routes (HMAC) |

> **Why two backends?** They do different jobs at different scales in different
> languages, and they're intentionally kept separate. Don't merge them.

---

## "Where do I find…?"

| I'm looking for… | It's in… |
|---|---|
| A page / screen | `frontend/web/src/app/(dashboard)/dashboard/**` |
| An HTTP endpoint the browser calls | `frontend/web/src/app/api/**/route.ts` |
| A React component | `frontend/web/src/components/<feature>/` |
| Server actions / data fetching | `frontend/web/src/lib/` |
| **CV-tailoring logic (DO NOT BREAK)** | `backend/api/app/services/pipeline/**`, `.../eval/**` |
| AI prompts | `backend/api/app/services/ai/prompts/` |
| PDF generation | `backend/api/app/services/cv/pdf_generator.py` |
| **Job-sourcing logic (DO NOT BREAK)** | `backend/worker/src/pipeline/**`, `backend/worker/src/sources/**` |
| A specific job board's scraper | `backend/worker/src/sources/<board>.ts` |
| Database schema / migrations | `shared/supabase/migrations/` (applied in order) |
| The HMAC bridge contract | `backend/api/app/security/hmac.py` + `frontend/web/src/lib/cvBackend.ts` |

---

## How the two pipelines flow (high level)

**Job sourcing** (`backend/worker`, runs on a schedule or on demand):
`profile criteria → fan out to ~25 source adapters → normalise → dedup →
keyword/distance filter → save to jobs table`. Progress is streamed to the UI
via `run_logs` (Supabase Realtime).

**CV tailoring** (`backend/api`, runs when the user clicks "Analyze"):
`frontend/web /api/jobs/[id]/analyze → HMAC call to backend/api → 7-step
pipeline (parse JD, match skills, ATS score, compose tailored CV, validate,
rescore, render PDF) → writes analysis_runs row + PDF to Storage`. The UI
subscribes to the `analysis_runs` row for live step status.

> Both pipelines are battle-tested and tuned. Treat their internals as frozen
> unless a change is explicitly about the pipeline itself.

---

## The implicit contract you must know about

`backend/worker`, `backend/api`, and `frontend/web` **do not call each other
directly** for state — they coordinate through **shared Supabase rows**. In
particular `analysis_runs` and `run_logs` act as a message bus (written by a
backend, read live by the UI). That means **renaming or repurposing a column
on those tables is a cross-service breaking change**, even though nothing
imports it across the language boundary. Treat those columns as a versioned
API.

---

## Deploy targets

| Service | Provider | Name / root |
|---|---|---|
| `frontend/web/` | Vercel | root directory = `frontend/web` |
| `backend/worker/` | Fly.io | `jobtrackr-worker` (`backend/worker/fly.toml`) |
| `backend/api/` | Fly.io | `jobtrackr-cv-api` (`backend/api/fly.toml`) |
| Postgres + Storage + Realtime | Supabase | shared |

For the full review, findings, and the phased refactor plan see
[`docs/ARCHITECTURE_REVIEW_2026-06-11.md`](ARCHITECTURE_REVIEW_2026-06-11.md).
