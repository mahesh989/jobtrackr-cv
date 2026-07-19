---
name: codebase-nav
description: "Navigate the JobTrackr-CV codebase. Find files, understand architecture, trace data flows. Use when starting any task, locating code, or understanding how features connect."
trigger: always
---

# Codebase Navigation

You are working on **JobTrackr-CV** — a monorepo with three services sharing one Supabase database:

| Service | Stack | Directory | Deploy |
|---------|-------|-----------|--------|
| Frontend | Next.js 16, React 19, Tailwind 4, TypeScript | `frontend/web/` | Vercel preview |
| Backend API | Python 3.12, FastAPI, async | `backend/api/` | Fly.io (jobtrackr-cv-api) |
| Worker | Node.js 22, BullMQ, Playwright | `backend/worker/` | Fly.io (jobtrackr-worker) |

## Architecture Rule

**Browser never talks to backend/api directly.** All calls go through:
- Next.js API routes (`app/api/`) as the BFF layer
- Server actions (`lib/actions/`)
- Both call backend/api via HMAC-signed HTTP

```
Browser → Next.js API routes (BFF) → backend/api (HMAC-signed) → Supabase
Worker → backend/api (HMAC-signed) → Supabase
Browser ← Supabase Realtime (postgres_changes)
```

## Where Things Live

### Frontend (`frontend/web/src/`)

```
app/
  layout.tsx              Root layout (fonts, FOUC guard)
  page.tsx                Landing page (public)
  middleware.ts           Auth gate for all routes
  (dashboard)/            Auth-protected route group
    layout.tsx            Sidebar + header + auth + subscription gate
    dashboard/            Main dashboard
    admin/                Admin panels (12+ pages)
    cv/                   CV library, review, tailoring
    profiles/             Multi-CV profile management
    applications/         Cover letters, emails, application tracking
    jobs/                 Job analysis per run
    billing/              Stripe subscription management
    settings/             Theme, AI keys, profile
    voice/                Writing voice capture
    instructions/         Onboarding wizard
    integrations/         Apify, email
  api/                    60+ BFF API routes
  auth/                   Login, signup, password reset (public)
components/
  ui/                     13 reusable primitives (Button, Card, Modal, etc.)
  navigation/             Sidebar, Header, MobileNav
  providers/              ThemeProvider, RunNotifier, SetupGateClient
features/
  auth/                   Auth components + server guards
  cv/                     CV library, profile, analysis, voice
  jobs/                   Job board, filters, pipeline state
  profiles/               Profile CRUD, run management
  applications/           Cover letter cards, email drafts
  admin/                  Admin dashboard components
  billing/                Plan cards, usage meters
  dashboard/              Stat cards, pipeline donut
lib/
  types.ts                Canonical shared types
  constants.ts            Enums and constants (RunStatus, StepState, etc.)
  api-utils.ts            requireUser(), requireAdmin(), jsonError()
  actions.ts              Barrel re-export for server actions
  supabase/               Client factories (server, browser, admin)
  ai/                     Provider metadata (AiProvider, PROVIDER_META)
  billing/                Entitlements, plans, Stripe
  cvBackend.ts            HMAC-signed calls to Python backend
  admin/                  Admin guard, events, actions
```

### Backend API (`backend/api/app/`)

```
main.py                   FastAPI app entry
config.py                 Pydantic Settings
database.py               Singleton Supabase client
routes/
  health.py               GET /health, GET /health/db
  internal/               All HMAC-protected endpoints
    analyze.py            POST /internal/analyze (7-step pipeline)
    cv.py                 CV text extraction, structurization
    voice.py              Voice fingerprint extraction
    stories.py            Achievement story extraction
    company.py            Company research
    cover_letter.py       Cover letter generation
    skills.py             Skill classification
    scrape.py             JD URL scraping
schemas/                  Pydantic request/response models
services/
  ai/client.py            Unified AI client (Anthropic, OpenAI, DeepSeek)
  pipeline/orchestrator.py  7-step CV analysis pipeline
  cv/                     CV rendering, PDF generation
  cover_letter/           3-pass cover letter pipeline
  company/                Company research + fact selection
  skills/                 Lexicon-based skill classification
  eval/                   Deterministic enforcement + verification
security/
  hmac.py                 HMAC-SHA256 verification
  ssrf.py                 SSRF guard for URL fetching
```

### Worker (`backend/worker/src/`)

```
index.ts                  BullMQ worker entry (concurrency 1)
queue/                    Queue definition, scheduler, heartbeat
pipeline/                 13-stage job discovery pipeline
  orchestrator.ts         Main pipeline (1050+ lines)
  dedup.ts                URL hash + content fingerprint dedup
  eligibility.ts          Visa eligibility checks
  keywordFilter.ts        Keyword pre-filter
sources/                  22 job source adapters (SEEK, Adzuna, etc.)
ai/                       Visa extraction, JD facts, setting classification
notifications/            Email digests, error alerts, engagement
automation/               Auto-analyze triggers, billing
```

### Database (`shared/supabase/`)

83 migration files (additive only). Key tables:
- `users` — auth users with role field
- `search_profiles` — CV profiles (multi-profile support)
- `jobs` — scraped job listings
- `global_jobs` — shared canonical job bucket
- `cv_versions` — uploaded CVs (one active per user)
- `analysis_runs` — 7-step pipeline tracking
- `cover_letters` — generated cover letters
- `user_preferences` — contact details, settings
- `platform_ai_settings` — admin-configured AI provider
- `platform_source_tiers` — subscription-tier source config

## Finding Code Fast

| What you need | Where to look |
|---------------|---------------|
| A page component | `app/(dashboard)/<route>/page.tsx` |
| An API endpoint | `app/api/<domain>/<route>/route.ts` |
| A server action | `lib/actions/<domain>.ts` |
| A type definition | `lib/types.ts` (canonical) or `features/<domain>/types.ts` |
| A constant/enum | `lib/constants.ts` |
| Supabase queries | API routes or server actions (never client components) |
| AI provider config | `lib/ai/models.ts` |
| Billing logic | `lib/billing/entitlements.ts` |
| Auth guards | `features/auth/server/guards.ts` or `lib/api-utils.ts` |
| Backend endpoint | `backend/api/app/routes/internal/<name>.py` |
| Pipeline step | `backend/api/app/services/pipeline/steps/<name>.py` |
| Job source adapter | `backend/worker/src/sources/<source>.ts` |
| Migration | `shared/supabase/migrations/NNN_description.sql` |

## Key Files to Read First

1. `CLAUDE.md` — Session rules, non-negotiable decisions
2. `AGENTS.md` — Architecture overview
3. `lib/types.ts` — All shared types
4. `lib/constants.ts` — All enums and constants
5. `app/(dashboard)/layout.tsx` — Dashboard shell (auth, sidebar, providers)
6. `lib/cvBackend.ts` — How frontend calls Python backend
7. `backend/api/app/services/pipeline/orchestrator.py` — The 7-step pipeline

## Anti-Patterns to Avoid

- **Never** import from `next/headers` in client components
- **Never** use the browser Supabase client for data writes (use server actions or API routes)
- **Never** call backend/api from client-side code (always through BFF)
- **Never** hardcode API URLs — use the HMAC-signed `callCvBackend()` wrapper
- **Never** ALTER existing database tables — only ADD new tables and extend value sets
