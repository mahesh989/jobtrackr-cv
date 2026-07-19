# JobTrackr-CV — Claude Rules

## What This Is

JobTrackr + on-demand AI CV tailoring. Three services, one Supabase database:

- **frontend/web** — Next.js 16, React 19, Tailwind 4, TypeScript
- **backend/api** — Python 3.11+, FastAPI, async-only
- **backend/worker** — Node.js, BullMQ (unchanged from JobTrackr)

Frontend and worker communicate with backend/api via HMAC-signed HTTP. Never expose backend/api endpoints to the browser.

**Read `docs/design.md` once at the start of every fresh conversation** — the phased plan, bridge contract, and data model live there. Then check `.claude/graph.json` for current state.

## How to Use This Repo Efficiently

**SESSION START — mandatory:**
1. Read `.claude/graph.json` in full
2. Read `docs/design.md` (skim if already familiar)
3. Check `build_state.current_phase` and `build_state.next_action` — resume there
4. Within the current phase, find the next task with `status: planned` whose `depends_on` are all `completed`
5. Do NOT skip phases. Each phase has a verification gate that must pass before moving on
6. Do NOT modify production JobTrackr (`/Users/mahesh/Documents/Next Phase Cleaning/APPlication/JobTrackr`) — this is a separate project

**DURING SESSION — update graph.json immediately when:**
- Any item moves: `planned` → `in_progress` → `completed`
- A phase's verification gate passes (mark phase `verified` in `build_state`)
- A new entity, field, or relationship is added
- A key decision is made or changed
- A bridge-contract endpoint is added/modified

**SESSION END — mandatory before finishing:**
1. Move all completed items in `build_state` to `completed[]`
2. Update `_meta.updated` to today's date
3. If any new entities/decisions arose, add them
4. Commit the updated graph: `git add .claude/graph.json && git commit -m "chore: update graph [session YYYY-MM-DD]"`

## Quick Commands

```bash
# Frontend
cd frontend/web && npm run dev        # localhost:3000
cd frontend/web && npm run build      # production build
cd frontend/web && npm run lint       # eslint
cd frontend/web && npx tsc --noEmit   # type check

# Backend API
cd backend/api && pip install -r requirements.txt
cd backend/api && uvicorn app.main:app --reload
cd backend/api && python -m pytest

# Worker
cd backend/worker && npm install
cd backend/worker && npm run dev
```

## Directory Structure

```
frontend/web/src/
  app/              # Next.js App Router pages + API routes
    (dashboard)/    # Authenticated dashboard pages
    api/            # Next.js API routes (BFF layer)
    auth/           # Login, signup, forgot/reset password
  components/       # Shared UI components
    ui/             # Reusable primitives (Button, Card, Input, Modal, etc.)
    providers/      # ThemeProvider, RunNotifier, SetupGateClient
    navigation/     # SidebarNav, MobileNav, ThemePicker
  features/         # Domain modules (one folder per feature)
    applications/   # Job applications, cover letters, emails
      components/   # ApplicationCard, StatusTabs, etc.
      hooks/        # useContactEmail, useCoverLetter, useEmailDraft
    auth/           # Auth components (AuthShell, LoginForm, SignupForm, etc.)
      components/   # LoginForm, SignupForm, etc.
      server/       # getAuthUser, handleSignOut, guards
    cv/             # CV library, review editor, tailoring, voice/stories
      analysis/     # AnalysisRun, CoverLetter, Feasibility
      library/      # CvLibrary, CvReview
      profile/      # ProfileForm, sections, primitives
      voice/        # VoiceCapture, Stories
    jobs/           # Job boards, search, scraping
      components/   # JobBoard, SmartFeed, SmartToolbar, etc.
      lib/          # jobFilters, pipelineState, progressFlags
    profiles/       # CV profiles (multi-CV support)
      components/   # ProfileForm, ProfilesTable, RunJobsTable
    admin/          # Admin dashboards (metrics, users, pipeline, etc.)
    billing/        # Stripe billing
    dashboard/      # Dashboard home page
    integrations/   # Third-party integrations
  lib/              # Shared utilities, types, helpers
    types.ts        # Canonical shared types (ContactDetails, SkillCategory, etc.)
    api-utils.ts    # requireUser(), requireAdmin(), parseJsonBody(), jsonError()
    constants.ts    # RunStatus, StepState, ADMIN_ROLES, VisaStatus, Eligibility
    supabase/       # Supabase client creation (browser + server)
    cv/             # CV-specific helpers (skillLabels, etc.)
    ai/             # AI client helpers
    billing/        # Billing helpers

backend/api/app/
  routes/           # FastAPI route handlers
    internal/       # HMAC-signed internal endpoints (called by worker/frontend)
    v1/             # Public API endpoints (if any)
  services/         # Business logic
    ai/             # AI client factory (Anthropic, OpenAI, etc.)
    pipeline/       # CV analysis pipeline (7 steps)
    verticals/      # Job vertical/role family classification
  schemas/          # Pydantic models
  security/         # HMAC signing, auth helpers
```

## Key Patterns

### Auth Flow
- Middleware (`middleware.ts`) protects all `/dashboard/*` routes
- API routes in `app/api/` use `requireUser()` from `lib/api-utils.ts` — returns `{ userId, supabase }`
- Admin routes use `requireAdmin()` — same pattern, adds role check
- Auth pages (`/auth/*`) are public, no theme class on `<html>` — intentionally hardcoded Aurora Light palette

### Data Flow
- Frontend → Next.js API routes (BFF) → backend/api (HMAC-signed) → Supabase
- Worker → backend/api (HMAC-signed) → Supabase
- Realtime: frontend subscribes to Supabase `postgres_changes` on `analysis_runs` for live step status

### Type System
- Canonical types live in `lib/types.ts` (ContactDetails, SkillCategory, ProfileCredentials, etc.)
- Feature-local types in `features/*/types.ts` — re-export from `@/lib/types` when shared
- `lib/constants.ts` for enums and constants (RunStatus, StepState, etc.)
- Never define duplicate types — always import from canonical source

### Loading States
- `loading.tsx` files use `PageSkeleton` (table pages) or `ContentSkeleton` (form/content pages) from `components/layout/PageSkeleton.tsx`
- `error.tsx` boundaries exist at root, dashboard, and admin levels

### Backend API Conventions
- All route handlers are `async def`
- `AIClientError` → 422, AI call failures → 502, `ValueError` → 422
- Always use `from exc` when re-raising in except blocks
- No SQLAlchemy — direct Supabase REST writes via httpx

## Non-Negotiable Decisions

1. **Two services, one DB.** `frontend/web` + `backend/worker` stay TypeScript. `backend/api` stays Python (FastAPI). Communicating via HMAC-signed HTTP. Shared Supabase.
2. **No logic porting.** cv-magic's pipeline orchestrator, 7 step files, ReportLab PDF generator, AI prompts — all stay Python verbatim.
3. **Strip cv-magic of:** Clerk auth, Stripe billing, quota, Resend email, webhooks, user/company/cv_versions routes (we add our own).
4. **BYOK only.** Users supply Anthropic / OpenAI keys. Encrypted with the same AES-256-GCM helper JobTrackr already uses for Apify.
5. **Realtime everywhere.** Frontend subscribes to Supabase `postgres_changes` on `analysis_runs` row for live step status. No polling.
6. **Additive DB changes only.** Never ALTER existing JobTrackr tables. Only INSERT new tables (`cv_versions`, `analysis_runs`) and extend the `user_integrations.provider` value set.
7. **Phased rollout with manual verification.** Each phase ends with a checkpoint to be tested on the Vercel preview URL before moving to the next.
8. **One CV active per user.** Many `cv_versions` rows, partial unique index on `(user_id) WHERE is_active = true`.

## Code Conventions

- **frontend/web** — same as JobTrackr: TypeScript, Next.js App Router, Tailwind, TanStack Query, Supabase browser client only for Realtime.
- **backend/worker** — unchanged from JobTrackr. Don't extend it for CV work; that's backend/api's job.
- **backend/api** — Python 3.11+, FastAPI, async-only, httpx, Supabase service-role client (no SQLAlchemy session for this project — direct REST writes are simpler).
- **Bridge** — internal HMAC-SHA256(timestamp + body), shared secret in env. Never expose backend/api endpoints to the browser.

## Production Safety

This repo's `main` deploys to Vercel preview, not to the production JobTrackr domain. Until we explicitly decide to promote:

- DO NOT change DNS or Vercel project aliases on the production JobTrackr.
- DO NOT push to the production JobTrackr repo.
- DO NOT alter existing JobTrackr Supabase tables (only new tables + new provider values).
- DO seed test data freely in shared Supabase — new tables are isolated from JobTrackr code paths.

## Model Routing

This project uses tiered models for different roles. Do not override
these defaults without explicit user instruction.

| Role | Model | When |
|---|---|---|
| Main session | claude-sonnet-4-6 | All hands-on coding work |
| Planning | claude-haiku-4-5 | Via /plan or planner subagent |
| Auditing | claude-opus-4-7 | Via /audit or auditor subagent only, never as main session |
| Migration checks | claude-sonnet-4-6 | Via migration-checker subagent before any Supabase migration work |

Opus is the senior reviewer, not the executor. Do not run Opus as the
main session model — it's expensive and unnecessary for most work.

If a session starts on the wrong model, switch via /model before
beginning substantive work.

## Session Management Rules

You are responsible for monitoring your own context usage and
proactively telling the user when to start a fresh session. Do not
wait to be asked.

### When to recommend a new session

Proactively recommend a fresh session when:

1. Context usage approaches 60% (run /context if uncertain)
2. A logical phase has just completed (committed and pushed)
3. The next task is fundamentally different from the current one
4. The conversation has accumulated more than ~20 substantial turns
5. A /compact was just performed and new work is about to start

### How to recommend a new session

When you decide a new session is warranted, invoke the /handoff slash
command. Do not write the handoff block manually — the command
standardises the format.

### What not to do

- Do not recommend new sessions mid-task. Finish the current logical
  unit first.
- Do not recommend new sessions during active debugging.
- Do not recommend sessions for short tasks (< 5 turns of activity).

## Things to Know

- **Tailwind 4** — uses CSS-native config (`@theme` in globals.css), not `tailwind.config.js`
- **Theme system** — 6 themes (aurora-light is default). CSS variables under `:root.theme-*` in globals.css. Auth pages hardcode Aurora Light palette intentionally (no theme class pre-login).
- **Deploy** — `main` branch → Vercel preview (not production). Production JobTrackr is a separate repo.
- **BYOK** — Users supply their own AI keys (Anthropic/OpenAI). Encrypted with AES-256-GCM.
- **One CV active per user** — partial unique index on `(user_id) WHERE is_active = true`
- **Additive DB changes only** — Never ALTER existing tables. Only INSERT new tables and extend value sets.
