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
3. Check `build_state.current_phase` — as of 2026-08-02 this reads
   **phase-13 COMPLETE, LIVE in production**: the original phased
   rollout is done and this repo has been in general maintenance mode
   (refactors, bug fixes, audits — see `_meta.session_notes` and
   `known_issues`/`deferred_features`) for several weeks. There is no
   `planned`-status task queue to resume by default.
4. If `build_state` ever shows a genuinely new phase in flight again
   (a fresh `next_action` with real `planned` tasks under it), the
   original discipline still applies: find the next task whose
   `depends_on` are all `completed`, and do NOT skip phases — each one
   has a verification gate that must pass before moving on.
5. Otherwise, treat the session as maintenance work: check
   `known_issues` / `deferred_features` for open items, or follow
   whatever the user asks for directly.
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
      library/      # LibraryClient; ReviewClient split into ReviewClient.tsx
                    #   (state) + ReviewSections.tsx (the 10 render blocks) +
                    #   cvDocPatchers.ts (structured-CV updaters) +
                    #   useReviewAutosave.ts — extracted PR #74-#77, 2026-08
      profile/      # Profile details form (sections, context, ProfileFormComponents)
      voice/        # CaptureClient, Stories
    jobs/           # Job boards, search, scraping
      components/   # JobBoard, SmartFeed, SmartToolbar, FeedCards/ (split into
                    #   cards/chips/context/parts/shell.tsx, PR #75)
      lib/          # jobFilters, pipelineState, progressFlags
    profiles/       # CV profiles (multi-CV support)
      components/   # ProfileForm, ProfilesTable, RunJobsTable
    admin/          # Admin dashboards (RangeFilter, AiSettings, SourcesCard)
    billing/        # Stripe billing (ManageButton, PlanCards, UsageMeter)
    dashboard/      # Dashboard home page — thin page.tsx +
                    #   getDashboardData.ts (data fetch extracted, PR #72)
    integrations/   # Third-party integrations (ApifyCard, EmailIntegrationCard)
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

backend/worker/src/
  pipeline/         # Job-discovery pipeline
    orchestrator/   # runPipeline + one file per stage (types, profile,
                    #   apifyIntegration, platformSources, concurrency,
                    #   lookback, bucketCoverage, earlyDedup, jobFacts,
                    #   enrichment, sourceFetch, runPipeline, index —
                    #   split from a single 1667-line orchestrator.ts, PR #78)
    normalise.js, dedup.js, save.js, coverage.js, bucket.js, ...
  sources/          # Per-board adapters (Adzuna, SEEK, Careerjet, ...)
  ai/               # Visa/setting/JD-facts extraction
  notifications/    # Alerts, digests, gate
```

## Key Patterns

### Auth Flow
- Middleware (`middleware.ts`) protects all `/dashboard/*` routes
- API routes in `app/api/` use `requireUser()` from `lib/api-utils.ts` — returns `{ userId, supabase }`
- Admin routes use `requireAdmin()` — same pattern, adds role check
- Auth pages (`/auth/*`) are public. The FOUC script lives in the ROOT layout, so `<html>` DOES carry the user's theme class there — the old claim that it doesn't was wrong and caused a real bug (Aurora Dark users saw white labels on a white card, because the shared `Input`/`FieldLabel` read `.field`/`text-text`). Since 2026-08-07 the auth screens sit inside a `.auth-shell` scope (globals.css) that pins surface/text/border/brand plus the raw hue families, so they render the same regardless of the active theme — by construction, not by a route check.

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

## Non-Negotiable Decisions

1. **Two services, one DB.** `frontend/web` + `backend/worker` stay TypeScript. `backend/api` stays Python (FastAPI). Communicating via HMAC-signed HTTP. Shared Supabase.
2. **No logic porting.** cv-magic's pipeline orchestrator, 7 step files, ReportLab PDF generator, AI prompts — all stay Python verbatim.
3. **Strip cv-magic of:** Clerk auth, Stripe billing, quota, Resend email, webhooks, user/company/cv_versions routes (we add our own).
4. **Platform-wide AI provider (BYOK removed 2026-06-16, see graph.json D20).** Single admin-managed provider/key/model in `platform_ai_settings`, replacing per-user BYOK keys. Encrypted with the same AES-256-GCM helper JobTrackr already uses for Apify.
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
these defaults without explicit user instruction. Model IDs verified
current as of 2026-08-02 — the Claude 5 family (Sonnet 5, Opus 5,
Fable 5) plus Haiku 4.5. Re-verify before trusting an older ID here.

| Role | Model | When |
|---|---|---|
| Exploring & planning | Fable 5 | Research phase and plan-mode design — standing user preference (2026-07-13): explore/plan on Fable, switch to Sonnet 5 once a plan is approved and it's time to write code |
| Main session (execution) | Sonnet 5 | All hands-on coding work, once a plan is approved |
| Deep audit / second opinion | Opus 5 | `/code-review` (`ultra` for a multi-agent cloud review) or `/security-review` for the pending diff; for anything narrower, pass `model: "opus"` to the Agent tool. Never run Opus as the main session model — it's the senior reviewer, not the executor |
| Migration checks | `migration-checker` subagent (Sonnet 5) | Before any Supabase migration work — see `.claude/agents/migration-checker.md`. Checks a proposed migration against this doc's additive-only rules (Non-Negotiable Decisions #6) before it's applied |

If a session starts on the wrong model, switch via /model before
beginning substantive work.

Historical note: earlier versions of this table referenced
`claude-sonnet-4-6` / `claude-haiku-4-5` / `claude-opus-4-7` and a
`/plan` + `/audit` + `planner`/`auditor` subagent setup. Those model IDs
don't exist and those subagents were never actually configured in
`.claude/agents/` on this machine (`.claude/agents/` is gitignored —
see the note in `.gitignore` — so this can silently drift per machine).
Corrected 2026-08-02 to what's real: Fable/Sonnet routing per the
user's actual stated preference, and the built-in `Plan` agent type /
`/code-review` skill for planning and auditing respectively, since
those already exist and do the job without inventing new tooling.

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
command (`.claude/commands/handoff.md`, local-only — gitignored, so
confirm it still exists on whichever machine you're running from). It
produces a standardised summary: branch/PR state, what was completed,
what's next, open gotchas. If it's missing, write the same five things
manually rather than skipping the handoff.

### What not to do

- Do not recommend new sessions mid-task. Finish the current logical
  unit first.
- Do not recommend new sessions during active debugging.
- Do not recommend sessions for short tasks (< 5 turns of activity).

## Things to Know

- **Tailwind 4** — uses CSS-native config (`@theme` in globals.css), not `tailwind.config.js`
- **Theme system** — **7 themes; `classic` is the default** (aurora-dark, aurora-light, default, classic, gilded-noir, notion, clay). CSS variables under `:root.theme-*` in globals.css; `default` is the bare `:root` palette with no class. Auth pages use the `.auth-shell` scoped token block, not hardcoded hex. Contrast for all seven + `.auth-shell` is asserted by `lib/themeContrast.test.ts`.
- **Never hardcode colours in components.** Use the semantic vocabulary — `bg-{success|warning|danger|info|accent}-subtle`, `border-{…}-border`, `text-{…}`, or the bare token for a solid fill. `scripts/check-theme-tokens.mjs` is a **hard CI gate**: a raw Tailwind palette class, arbitrary hex in a className, literal hex in an inline `style`, a `dark:` variant, or `text-white` on `bg-[var(--brand)]` fails the build. Fix it or add an allowlist entry with a written reason. `--brand-fg` is DARK on Gilded Noir, Clay and Aurora Dark — never assume white.
- **Deploy** — `main` branch → Vercel preview (not production). Production JobTrackr is a separate repo.
- **Platform-wide AI provider** — BYOK removed 2026-06-16; single admin-managed key in `platform_ai_settings` (`/dashboard/admin/ai-settings`), not per-user. Encrypted with AES-256-GCM.
- **One CV active per user** — partial unique index on `(user_id) WHERE is_active = true`
- **Additive DB changes only** — Never ALTER existing tables. Only INSERT new tables and extend value sets.
