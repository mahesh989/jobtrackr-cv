# JobTrackr-CV AI Skills

AI engineering knowledge layer for the JobTrackr-CV codebase. Each skill teaches Claude/OpenCode how to work safely and consistently with this specific project.

## Skills Overview

| Skill | File | Activates When | What It Covers |
|-------|------|----------------|----------------|
| **codebase-nav** | `codebase-nav.md` | Always | Navigate the repo, find files, trace data flows, understand architecture |
| **frontend-patterns** | `frontend-patterns.md` | Always | Next.js App Router, server/client components, Tailwind 4, themes, UI primitives |
| **backend-api** | `backend-api.md` | Backend work | Python FastAPI endpoints, Pydantic schemas, AI client, error handling |
| **database-safety** | `database-safety.md` | Always | Migrations (additive only), RLS, Supabase clients, cache invalidation |
| **server-actions** | `server-actions.md` | Always | `"use server"` pattern, form handling, revalidation, barrel exports |
| **ai-pipeline** | `ai-pipeline.md` | Backend work | 7-step CV analysis, orchestrator, step implementation, cover letters |
| **security** | `security.md` | Always | IDOR, rate limiting, double submission, CSRF, XSS, SSRF, race conditions, timing attacks, auth guards, encryption |
| **type-system** | `type-system.md` | Always | Canonical types, constants, avoiding duplicates, correct imports |
| **testing** | `testing.md` | Always | Write and run tests, pytest patterns, vitest patterns, golden harnesses |
| **pr-review** | `pr-review.md` | `/pr-review` | Review PRs, categorize findings, score, suggest fixes |

## How Agents Should Use These Skills

### At session start
1. Read `codebase-nav.md` to understand the architecture
2. Read `type-system.md` to know where types live
3. Read `database-safety.md` to understand migration rules

### When adding a feature
1. Read `frontend-patterns.md` (if UI work)
2. Read `backend-api.md` (if Python work)
3. Read `server-actions.md` (if adding mutations)
4. Read `ai-pipeline.md` (if touching the analysis pipeline)

### Before committing
1. Read `testing.md` for verification checklist
2. Run the appropriate type check / lint / test commands

### When touching security-sensitive code
1. Read `security.md` for HMAC, encryption, and auth patterns

## Skill Details

### codebase-nav
**Purpose:** Prevent agents from getting lost or making wrong assumptions about architecture.

**Key rules:**
- Three services, one database — never mix concerns
- Browser never talks to backend/api directly
- Always check canonical type sources before defining new types
- Additive DB changes only — never ALTER existing tables

**Derived from:** `CLAUDE.md`, `AGENTS.md`, directory structure analysis, `middleware.ts`, Supabase client patterns.

---

### frontend-patterns
**Purpose:** Ensure agents follow established React/Next.js patterns.

**Key rules:**
- Server components by default, `"use client"` only when needed
- `useTransition` for form submissions (never `useActionState`)
- `PageLoader` for table pages, `ContentLoader` for content pages
- Tailwind 4 CSS-native config (no `tailwind.config.js`)
- Theme tokens: `text-text`, `bg-surface`, `border-border`, etc.
- Auth pages hardcode Aurora Light (no theme class pre-login)

**Derived from:** `app/(dashboard)/layout.tsx`, `components/ui/`, `features/`, 100+ `"use client"` files analysis.

---

### backend-api
**Purpose:** Ensure Python backend changes follow FastAPI conventions.

**Key rules:**
- All routes `async def`, HMAC-protected under `/internal`
- Error taxonomy: `AIClientError` → 422, AI failures → 502, `ValueError` → 422
- BYOK mixin for AI-powered endpoints
- No SQLAlchemy — direct Supabase REST via httpx
- Never log `voice_sample_text`

**Derived from:** `backend/api/app/main.py`, `routes/internal/`, `schemas/`, `services/ai/client.py`.

---

### database-safety
**Purpose:** Prevent destructive database changes.

**Key rules:**
- Additive only — never ALTER/DROP existing tables
- Every new table needs RLS policies
- Three Supabase clients: server (cookie-bound), browser, admin (service-role)
- Admin client requires manual ownership verification
- Cache invalidation after every write

**Derived from:** 83 migration files analysis, `lib/supabase/`, RLS policy patterns.

---

### server-actions
**Purpose:** Teach the `"use server"` pattern used for mutations.

**Key rules:**
- Actions in `lib/actions/<domain>.ts` with `"use server"` directive
- Barrel re-export via `lib/actions.ts`
- `_helpers.ts` must NOT have `"use server"` (exports sync functions)
- Always auth + ownership check + mutate + revalidate
- Client side: `useTransition` + `router.refresh()`

**Derived from:** `lib/actions/`, `lib/actions.ts`, client component usage patterns.

---

### ai-pipeline
**Purpose:** Guide agents working on the 7-step CV analysis pipeline.

**Key rules:**
- 7 steps with gate system (initial ATS < 50 → stop early)
- Semaphore-bounded concurrency (default 4)
- Cancellation polling before expensive steps
- AI client auto-retries JSON parse failures (3x)
- Prompt templates in `services/ai/prompts/`

**Derived from:** `backend/api/app/services/pipeline/orchestrator.py` (668 lines), step files, AI client (755 lines).

---

### security
**Purpose:** Comprehensive OWASP-top-10 coverage for this specific codebase.

**Key rules:**
- Ownership check at EVERY endpoint (IDOR defence-in-depth)
- Rate limit all state-changing endpoints (12 already covered)
- `useTransition` + `disabled` prevents double clicks
- SSRF validation on user-supplied URLs (backend has it, frontend `/scrape-url` is a known gap)
- Constant-time comparison for all signatures (`timingSafeEqual`, `compare_digest`)
- Generic error messages in production, stack traces server-side only
- CI script rejects routes without auth signals
- Race conditions mitigated via idempotency guards + unique constraints
- `dangerouslySetInnerHTML` only on static/escaped data (no user XSS vector)

**Derived from:** Full codebase security audit: IDOR patterns across 15+ endpoints, rate limiting on 12 endpoints, `useTransition` in 38 locations, SSRF guard in `security/ssrf.py`, timing-safe comparisons in HMAC + unsubscribe, CI guard script, race condition documentation in CV activation + worker notifications + billing webhook.

---

### type-system
**Purpose:** Prevent duplicate types and ensure correct imports.

**Key rules:**
- 8 canonical source files for types/constants
- Never define duplicate types
- Use `as const` objects, never TypeScript `enum`
- Feature-local types only in `features/*/types.ts`

**Derived from:** `lib/types.ts`, `lib/constants.ts`, `lib/ai/models.ts`, `lib/eligibility.ts`, import analysis across 200+ files.

---

### testing
**Purpose:** Write and run tests. Covers pytest (Python backend), vitest (Node worker), golden regression harnesses, mocking patterns, and when to write tests.

**Key rules:**
- **Every task that changes behavior should include tests** — not optional polish
- Write tests at task START (TDD-lite), not as an afterthought
- Frontend: `npx tsc --noEmit` after every change (zero frontend tests exist)
- Backend: `python -m pytest -x` for Python changes
- Worker: `npx vitest run` for Node.js changes
- Test design: regression-driven (cite origin), pure-function focus (no live DB/AI), self-contained files (no shared fixtures)
- Python: inline fixtures as constants, class-based grouping, `unittest.mock` only
- TypeScript: `vi.mock()` BEFORE `vi.mock()` BEFORE dynamic import, fake timers for timer logic
- Golden harnesses: JD precision/recall (`tests/golden/jds/`), rendered CV snapshots (`tests/golden/rendered/`)
- Adding new endpoints → add to `test_internal_route_surface.py` EXPECTED list
- New service functions → write unit tests with inline production data fixtures

**Derived from:** 62 test files (47 Python + 15 TypeScript), ~1,091 test cases, ~15,260 lines of tests, golden regression harnesses, full codebase test audit.

---

### pr-review
**Purpose:** Review PRs with categorized findings, scoring, and concrete fix suggestions.

**Key rules:**
- Start at 100 points, deduct per finding (Blocker -10, Warning -5, Suggestion -2, Nit -1, What's Good +3)
- Verdict: 90+ = APPROVE, 70-89 = APPROVE_WITH_NOTES, <70 = REQUEST_CHANGES
- Run CI checks (tsc, pytest, vitest, eslint, auth guard) before reviewing code
- Every finding must have `path:line` reference
- Blockers and Warnings need concrete code fix suggestions
- 6 review dimensions: security, correctness, architecture, performance, testing, naming
- Developer commits manually — never run `git commit`

**Derived from:** Existing auditor agent patterns, security audit methodology, CI guard scripts, full codebase review patterns.

## Anti-Patterns Reference

These are mistakes agents have made or could make. Every anti-pattern is derived from actual codebase analysis:

| Anti-Pattern | Why It's Wrong | Correct Approach |
|-------------|----------------|------------------|
| Defining duplicate types | Creates confusion, drift | Import from canonical source |
| Using `useActionState` | Not used in this codebase | Use `useTransition` |
| Adding `tailwind.config.js` | Tailwind 4 uses CSS-native config | Edit `globals.css` `@theme` |
| ALTER existing tables | Breaks production JobTrackr | Add new tables only |
| Calling backend/api from browser | Security: HMAC keys exposed | Use BFF (API routes) |
| Skipping ownership verification | Admin client bypasses RLS | Always verify manually |
| Logging voice_sample_text | Sensitive user content | Never log it |
| Using `enum` in TypeScript | Not the codebase convention | Use `as const` objects |
| Skipping `revalidatePath` | Stale data displayed | Always revalidate after writes |
| Using sync route handlers | All handlers must be async | Use `async def` |
| Importing `next/headers` in client | Server-only API | Use in server components only |
| Using browser Supabase for writes | RLS may block | Use server actions/API routes |

## Agent Rules

- **Never commit.** The developer commits manually. Agents run tests and verify, but `git commit` is the developer's job.
- **Never push.** Same reason.
- **Never create PRs.** Developer handles all git workflow.

## Engineering Principles

These principles are encoded in the skills and should guide all contributions:

- **KISS**: Simplest solution that works. No over-engineering.
- **YAGNI**: Don't build what isn't needed now. ponytail mode enforces this.
- **DRY**: Import from canonical sources. Never duplicate types/constants.
- **SOLID**: Single responsibility per file, clear interfaces.
- **Type Safety**: Strict TypeScript, Pydantic validation, no `any`.
- **Security First**: Auth at every boundary, encrypt sensitive data, validate inputs.
- **Additive Only**: Database changes only add, never remove or modify existing schema.
