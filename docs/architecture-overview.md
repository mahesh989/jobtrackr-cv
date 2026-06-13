# JobTrackr-CV — Architecture at a glance

**Product:** a job-application SaaS. It (1) **discovers** relevant jobs from ~25
sources, and (2) **tailors the user's CV + writes a cover letter** for any job
on demand using their own AI keys (BYOK). One Supabase database ties it together.

If you've just landed in this repo and can't tell what's frontend vs backend —
this page is the map. **There is one frontend and two backends.**

---

## The three services (this is the whole system)

```
                          ┌──────────────────────────────┐
        browser  ───────▶ │  apps: web/  (Next.js, Vercel)│
                          │  • the entire UI              │
                          │  • ~40 API routes = a thin BFF│
                          └───────┬───────────────┬───────┘
                                  │               │
                 HMAC-signed HTTP │               │ enqueue job (Redis)
                                  ▼               ▼
              ┌───────────────────────────┐   ┌──────────────────────────┐
              │ BACKEND 1: cv-backend/     │   │ BACKEND 2: worker/        │
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
                          │  27 tables, RLS on 26     │
                          └──────────────────────────┘

  External: Upstash Redis (queue + rate-limit) · Apify (scraper actors) ·
            Stripe (billing) · Resend (email) · Sentry (errors)
```

| | `web/` | `worker/` | `cv-backend/` |
|---|---|---|---|
| **Role** | Frontend + thin API/BFF | Job-sourcing pipeline | CV-tailoring pipeline |
| **Language** | TypeScript | TypeScript | Python |
| **Framework** | Next.js 14 (App Router) | BullMQ workers | FastAPI |
| **Host** | Vercel | Fly.io (`jobtrackr-cv-worker`) | Fly.io (`jobtrackr-cv-api`) |
| **Talks to browser?** | Yes | No | No (HMAC-only, internal) |
| **Triggered by** | user | Redis queue / cron | `web` API routes (HMAC) |

> **Why two backends?** They do different jobs at different scales in different
> languages, and they're intentionally kept separate. Don't merge them.

---

## "Where do I find…?"

| I'm looking for… | It's in… |
|---|---|
| A page / screen | `web/src/app/(dashboard)/dashboard/**` |
| An HTTP endpoint the browser calls | `web/src/app/api/**/route.ts` |
| A React component | `web/src/components/<feature>/` |
| Server actions / data fetching | `web/src/lib/` |
| **CV-tailoring logic (DO NOT BREAK)** | `cv-backend/app/services/pipeline/**`, `.../eval/**` |
| AI prompts | `cv-backend/app/services/ai/prompts/` |
| PDF generation | `cv-backend/app/services/cv/pdf_generator.py` |
| **Job-sourcing logic (DO NOT BREAK)** | `worker/src/pipeline/**`, `worker/src/sources/**` |
| A specific job board's scraper | `worker/src/sources/<board>.ts` |
| Database schema / migrations | `supabase/migrations/` (applied in order) |
| The HMAC bridge contract | `cv-backend/app/security/hmac.py` + `web/src/lib/cvBackend.ts` |

---

## How the two pipelines flow (high level)

**Job sourcing** (worker, runs on a schedule or on demand):
`profile criteria → fan out to ~25 source adapters → normalise → dedup →
keyword/distance filter → save to jobs table`. Progress is streamed to the UI
via `run_logs` (Supabase Realtime).

**CV tailoring** (cv-backend, runs when the user clicks "Analyze"):
`web /api/jobs/[id]/analyze → HMAC call to cv-backend → 7-step pipeline (parse
JD, match skills, ATS score, compose tailored CV, validate, rescore, render
PDF) → writes analysis_runs row + PDF to Storage`. The UI subscribes to the
`analysis_runs` row for live step status.

> Both pipelines are battle-tested and tuned. Treat their internals as frozen
> unless a change is explicitly about the pipeline itself.

---

## The implicit contract you must know about

`worker`, `cv-backend`, and `web` **do not call each other directly** for state —
they coordinate through **shared Supabase rows**. In particular `analysis_runs`
and `run_logs` act as a message bus (written by a backend, read live by the UI).
That means **renaming or repurposing a column on those tables is a cross-service
breaking change**, even though nothing imports it across the language boundary.
Treat those columns as a versioned API.

---

## Deploy targets

| Service | Provider | Name / root |
|---|---|---|
| `web/` | Vercel | root directory = `web` |
| `worker/` | Fly.io | `jobtrackr-cv-worker` (`worker/fly.toml`) |
| `cv-backend/` | Fly.io | `jobtrackr-cv-api` (`cv-backend/fly.toml`) |
| Postgres + Storage + Realtime | Supabase | shared |

For the full review, findings, and the phased refactor plan see
[`docs/ARCHITECTURE_REVIEW_2026-06-11.md`](docs/ARCHITECTURE_REVIEW_2026-06-11.md).
