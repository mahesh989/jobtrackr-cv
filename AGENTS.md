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
    (dashboard)/    # Auth-protected route group (sidebar + auth check)
      dashboard/    # Main dashboard page (/dashboard)
      admin/        # /admin, /admin/users, /admin/metrics, etc.
      billing/      # /billing
      cv/           # /cv, /cv/[id]/review
      profiles/     # /profiles, /profiles/new, /profiles/[id]/edit
      settings/     # /settings/ai-keys, /settings/theme
      jobs/         # /jobs/[id]/analyze/[run_id]
      ...           # analytics, applications, analyses, integrations, voice, instructions
    api/            # Next.js API routes (BFF layer)
    auth/           # Login, signup, forgot/reset password (public)
    page.tsx        # Landing page (/)
  components/       # Shared UI components
    ui/             # Reusable primitives (Button, Card, Input, Modal, PageLoader, ContentLoader, etc.)
    providers/      # ThemeProvider, RunNotifier, SetupGateClient
    navigation/     # Sidebar, SidebarLinks, Header, MobileNav, ThemePicker
  features/         # Domain modules (one folder per feature)
    applications/   # Job applications, cover letters, emails
      components/   # CardListV2, StatusTabs, etc.
      hooks/        # useContactEmail, useCoverLetter, useEmailDraft
    auth/           # Auth components (Shell, LoginForm, SignupForm, etc.)
      components/   # LoginForm, SignupForm, etc.
      server/       # getAuthUser, handleSignOut, guards
    cv/             # CV library, review editor, tailoring, voice/stories
      analysis/     # AnalysisRun, CoverLetter, Feasibility
      library/      # LibraryClient, ReviewClient
      profile/      # ProfileForm, sections, primitives
      voice/        # CaptureClient, Stories
    jobs/           # Job boards, search, scraping
      components/   # JobBoard, SmartFeed, SmartToolbar, etc.
      lib/          # jobFilters, pipelineState, progressFlags
    profiles/       # CV profiles (multi-CV support)
      components/   # ProfileForm, ProfilesTable, RunJobsTable
    admin/          # Admin dashboards (RangeFilter, AiSettings, SourcesCard)
    billing/        # Stripe billing (ManageButton, PlanCards, UsageMeter)
    dashboard/      # Dashboard home page (StatCards, PipelineDonut)
    email/          # Email integration (IntegrationCard)
    integrations/   # Third-party integrations (ApifyCard)
  lib/              # Shared utilities, types, helpers
    types.ts        # Canonical shared types (ContactDetails, SkillCategory, etc.)
    api-utils.ts    # requireUser(), requireAdmin(), parseJsonBody(), jsonError()
    constants.ts    # RunStatus, StepState, ADMIN_ROLES, VisaStatus, JOB_SOURCES, TIER_DEFAULTS
    supabase/       # Supabase client creation (browser + server)
    cv/             # CV-specific helpers (skillLabels, etc.)
    ai/             # AI client helpers (AiProvider, PROVIDER_ORDER, PROVIDER_META)
    billing/        # Billing helpers
    eligibility.ts  # Eligibility, UserVisaStatus, computeEligibility (mirror of backend/worker)

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
- Canonical types live in `lib/types.ts` (ContactDetails, SkillCategory, ProfileCredentials, ToneTarget, etc.)
- Feature-local types in `features/*/types.ts` — re-export from `@/lib/types` when shared
- `lib/constants.ts` for enums and constants (RunStatus, StepState, JOB_SOURCES, TIER_DEFAULTS, etc.)
- `lib/ai/models.ts` for AiProvider, PROVIDER_ORDER, PROVIDER_META
- `lib/eligibility.ts` for Eligibility, UserVisaStatus, computeEligibility (mirror of backend/worker)
- Never define duplicate types — always import from canonical source

### Loading States
- `loading.tsx` files use `PageLoader` (table pages) or `ContentLoader` (form/content pages) from `components/ui/PageLoader.tsx`
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

### Button System

Canonical sizing defined in `lib/button-sizes.ts`:

| Token | Classes | Used By |
|-------|---------|---------|
| `BUTTON_SIZE.xs` | `text-[11px] px-2.5 py-1` | Button, Chip(sm), SegmentedControl(sm) |
| `BUTTON_SIZE.sm` | `text-[12px] px-3 py-1.5` | Button, Chip(md) |
| `BUTTON_SIZE.md` | `text-[13px] px-3 py-[5px]` | Button |
| `BUTTON_SIZE.lg` | `text-sm px-4 py-2` | Button |
| `ICON_BUTTON_SIZE.sm` | `w-6 h-6` | IconButton |
| `ICON_BUTTON_SIZE.md` | `w-7 h-7` | IconButton |
| `ICON_BUTTON_SIZE.lg` | `w-9 h-9` | IconButton |

`Button.tsx` and `IconButton.tsx` import these maps directly — sizing change in `button-sizes.ts` propagates everywhere they're used.
`Chip.tsx` sizes are intentionally aligned to `BUTTON_SIZE` values.
Inline `<button>` elements in feature code should use a `Button` component variant when possible; when a raw `<button>` is necessary (distinct visual like filter chips, dismiss links), use matching Tailwind classes from the table above.

### Ponytail Mode — Lazy Guidance

Active at `full` level every session via `opencode.json`. `ponytail:` comments
mark deliberate shortcuts. Keep them; don't "fix" what isn't broken.

**Laziness welcome here — the codebase already follows YAGNI:**
- `Button.tsx` — minimal Slot (merges props, no dependency)
- `AddModal.tsx` — inline URL input (stacked label breaks flex row)
- `SmartToolbar.tsx` — inline selects + search input (stacked label breaks toolbar)
- `ProfileForm.tsx` — inline input for auto-day sentence (stacked label breaks inline placement)
- `LocationAutocomplete.tsx` — raw input for Downshift (controlled value/onChange/keyDown)

**Laziness forbidden — never cut corners here:**
- HMAC signing (HMAC-SHA256 comparison)
- AES-GCM encryption/decryption (user AI keys)
- RLS policies on every new table
- Ownership checks on every API route
- Rate limiting on state-changing endpoints
- `requireUser()` / `requireAdmin()` guards
- Supabase client choice (server vs browser vs admin)
- Migration safety (additive only, never ALTER)

**Common over-engineering traps in this codebase:**
- Adding a dep when inline `<input type="date">` or CSS works
- Creating an abstraction with one consumer
- Wrapping a server action in a client-state layer when a plain `<form>` with `action` suffices
- Building a factory/registry for one product
- Writing a custom hook when a plain function works
