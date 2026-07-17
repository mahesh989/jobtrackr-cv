# JobTrackr-CV — Agent Guide

## What This Is

JobTrackr + on-demand AI CV tailoring. Three services, one Supabase database:

- **frontend/web** — Next.js 16, React 19, Tailwind 4, TypeScript
- **backend/api** — Python 3.11+, FastAPI, async-only
- **backend/worker** — Node.js, BullMQ (unchanged from JobTrackr)

Frontend and worker communicate with backend/api via HMAC-signed HTTP. Never expose backend/api endpoints to the browser.

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
  features/         # Domain modules (one folder per feature)
    applications/   # Job applications, cover letters, emails
    cv/             # CV library, review editor, tailoring, voice/stories
    jobs/           # Job boards, search, scraping
    admin/          # Admin dashboards (metrics, users, pipeline, etc.)
    billing/        # Stripe billing
    dashboard/      # Dashboard home page
    integrations/   # Third-party integrations
    profiles/       # CV profiles (multi-CV support)
  lib/              # Shared utilities, types, helpers
    types.ts        # Canonical shared types (ContactDetails, SkillCategory, etc.)
    api-utils.ts    # requireUser(), requireAdmin(), parseJsonBody(), jsonError()
    constants.ts    # RunStatus, StepState, ADMIN_ROLES, VisaStatus, Eligibility
    supabase/       # Supabase client creation (browser + server)
    cv/             # CV-specific helpers (skillLabels, etc.)
    ai/             # AI client helpers
    billing/        # Billing helpers
  modules/          # Cross-feature modules
    auth/           # Auth components (AuthShell, LoginForm, SignupForm, etc.)
  ui/               # Shared UI components (Button, Card, Input, etc.)
  layout/           # PageSkeleton, ContentSkeleton (loading states)

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
- `loading.tsx` files use `PageSkeleton` (table pages) or `ContentSkeleton` (form/content pages) from `layout/PageSkeleton.tsx`
- `error.tsx` boundaries exist at root, dashboard, and admin levels

### Backend API Conventions
- All route handlers are `async def`
- `AIClientError` → 422, AI call failures → 502, `ValueError` → 422
- Always use `from exc` when re-raising in except blocks
- No SQLAlchemy — direct Supabase REST writes via httpx

## Things to Know

- **Tailwind 4** — uses CSS-native config (`@theme` in globals.css), not `tailwind.config.js`
- **Theme system** — 6 themes (aurora-light is default). CSS variables under `:root.theme-*` in globals.css. Auth pages hardcode Aurora Light palette intentionally (no theme class pre-login).
- **Deploy** — `main` branch → Vercel preview (not production). Production JobTrackr is a separate repo.
- **BYOK** — Users supply their own AI keys (Anthropic/OpenAI). Encrypted with AES-256-GCM.
- **One CV active per user** — partial unique index on `(user_id) WHERE is_active = true`
- **Additive DB changes only** — Never ALTER existing tables. Only INSERT new tables and extend value sets.
