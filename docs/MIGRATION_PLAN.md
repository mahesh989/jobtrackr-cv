# JobTrackr-CV — Migration Plan (Decision Record)

> Companion to `docs/ARCHITECTURE_MAP.md` (commit 604a495). Evaluates the three
> candidate finer-grained splits for a solo-developer production deployment.
> Verdict summary: **no-go on all three today; fix deploy cadence and harden
> the existing three-service shape instead.** Each no-go carries an explicit
> trigger condition for revisiting.

## 1. Scope decision

### 1a. Sources ingestion service (peel `backend/worker/src/sources/`) — NO-GO

- The stated benefits of an ingestion split are independent scaling, failure
  isolation, and rate-limit management. At current scale none of these binds:
  the worker runs concurrency=1 on a single 512MB VM, so there is nothing to
  scale independently yet; per-source failure isolation already exists in code
  (each adapter fails its slice of a run, the orchestrator continues); and
  rate limits are handled per-adapter, not per-process.
- The one real pressure signal — Jora disabled for OOM at 512MB — is a
  **VM-sizing problem**. `memory = '1gb'` in `fly.toml` (~$5/mo) buys more
  headroom than a service split, at zero operational cost. A split would add:
  a second Fly app, a second manual-or-CI deploy, an internal contract for
  handing fetched jobs back to the pipeline (today an in-process array), and a
  new way for `main` to lag production. For one operator that is strictly more
  ways to break.
- The 36 adapters behind `sources/index.ts` (6,361 LOC) are the *easiest*
  future extraction in the repo precisely because they are already behind one
  dispatch point — that option stays open and gets no cheaper by exercising it
  early.
- **Revisit trigger:** sustained memory/throughput problems *after* the VM is
  bumped to 1–2GB and concurrency raised; or a source requiring dedicated
  egress IPs / residential-proxy pools that must scale separately from the
  pipeline; or run duration growing past the point where one sequential
  process can complete the daily schedule.

### 1b. Split `cover_letter/` + `company/` out of backend/api — NO-GO

- These modules are already independently *invocable* (own `/internal/*`
  routes, own BackgroundTasks, coupled only through the shared AI client).
  What they are not is independently *deployed* — and for a solo dev that is a
  feature, not a bug: one Python service, one test suite (1,167 tests), one
  Dockerfile, one deploy.
- Extraction would buy zero robustness: same 512MB Fly pattern, same Supabase,
  same AI providers. It would cost: duplicating the AI client + HMAC middleware
  + usage tracking into a second Python service (or creating the repo's first
  shared runtime package, which §6 of the map notes doesn't exist — a real
  cost the current architecture deliberately avoids), plus a third Fly app to
  keep in sync with `main`.
- The failure mode this split guards against — a runaway cover-letter workload
  starving the CV pipeline — is better handled inside one service (FastAPI
  worker/semaphore limits) until it is actually observed.
- **Revisit trigger:** measured latency contention between the 7-step analysis
  pipeline and cover-letter generation under real load; or cover-letter volume
  requiring different machine sizing than PDF rendering.

### 1c. Micro-frontends (mf-jobs / mf-cv-studio / mf-applications / mf-account) — NO-GO (strongest of the three)

- Micro-frontends solve an organisational problem: multiple teams needing
  independent release cadence on one product surface. There is one developer.
  Every cost lands (N Vercel projects or an edge-router layer, shared
  design-token/theme versioning across apps, cross-app auth/session handling,
  N×CI) and the sole benefit — team decoupling — is structurally unavailable.
- The specific stack makes it worse: the app leans on App Router RSC, a
  5-theme CSS-token system with a FOUC script in the root layout, shared
  middleware auth, and TanStack Query caches. All of that is trivially shared
  inside one Next.js app and painful across app boundaries.
- The route groups (`(dashboard)`, `auth`, `api/admin`, `api/billing`) already
  deliver the useful part of the isolation: distinct guards, distinct
  middleware paths, code-splitting per route. That is the correct amount of
  modularity for this team size.
- **Revisit trigger:** a second regular contributor with ownership of a
  distinct product area; or a hard requirement to ship one surface (e.g.
  billing) on a different cadence/compliance track than the rest.

## 2. Extraction sequences

Not applicable — no split is a "go". The Strangler-Fig outlines below are
recorded only so the trigger conditions in §1 have a ready-made shape when hit:

- **Sources (if triggered):** new Fly app consuming a `fetch_jobs` queue
  (BullMQ, same Redis), returning normalised listings to a `raw_jobs` staging
  table the orchestrator drains — keeps the multi-writer contracts untouched
  because the pipeline (not the fetcher) remains the sole writer of
  `jobs`/`global_jobs`. Cut over one adapter at a time via a flag in
  `sources/index.ts`; rollback = flip the flag back, delete nothing.
- **cover_letter/company (if triggered):** second FastAPI app behind the same
  HMAC middleware; web's `lib/cvBackend.ts` already centralises the base URL,
  so cutover is an env-var per endpoint; the api service keeps writing
  `cover_letters` rows until the new service proves out, then ownership moves
  wholesale (never split row-ownership mid-migration — see §6 contract).

## 3. Micro-frontend mechanism

Not applicable (1c is no-go). For the record, if the trigger in 1c ever fires,
the right mechanism for this stack is **separate Next.js apps behind Vercel
rewrites in a monorepo with a shared design-system package** — not Module
Federation (poor fit with App Router/RSC and Turbopack; runtime coupling
recreates the version-skew problem it claims to solve). But do not build the
shared-package plumbing speculatively; it only pays for itself with a second
team.

## 4. Deploy-lag fix — DO THIS, and do it first

This is the single highest-leverage robustness action available, and it is a
prerequisite for *any* future split (more services on a manual deploy cadence =
more silent lag). Current state: CI has **no deploy jobs at all**; worker and
api ship only when `flyctl deploy` is run by hand, and graph.json records
repeated multi-day lags.

Recommendation — one new workflow, `.github/workflows/deploy.yml`:

- Trigger: `push` to `main`, gated on the existing CI hard gates passing
  (`needs:` the guard/typecheck/pytest jobs, or a separate workflow with
  `workflow_run` on CI success).
- Path-filtered jobs: `backend/worker/**` changes → `flyctl deploy --config
  backend/worker/fly.toml --remote-only`; `backend/api/**` changes → same for
  api. Uses `superfly/flyctl-actions` + a `FLY_API_TOKEN` repo secret
  (deploy-scoped token per app, via `fly tokens create deploy`).
- Concurrency group per app (`concurrency: deploy-worker`) so stacked merges
  don't race.
- Keep manual `flyctl deploy` working as the break-glass path.

Sequencing: **Phase 0, before anything else in this plan** — it also
immediately fixes today's real bug (stage 10c setting-classifier is merged to
main but not live because the worker deploy is pending, per graph.json).

## 5. Agent / execution org chart

Mapped to the hardening work that replaces extraction (all runnable in this
repo; worktree isolation only where files overlap):

| Phase | Work | Agent role | Allowed to touch | Worktree? |
|---|---|---|---|---|
| 0 | `deploy.yml` (deploy-on-merge for both Fly apps) | main session (Sonnet) | `.github/workflows/` only | No — tiny, isolated |
| 0-gate | Verify first auto-deploy end-to-end | `auditor` (Opus, read-only) | read-only | No |
| 1 | Worker VM bump to 1GB + re-enable/verify memory-bound paths | main session | `backend/worker/fly.toml` | No |
| 2 | Worker test harness (vitest; start with pipeline pure functions: dedup, filters, normalise) | `general-purpose` (Sonnet) | `backend/worker/**` + CI job addition | Yes — long-running, parallel to daily work |
| 3 | Alerting: Fly health-check alerts + a `run_logs` failure-notification path | main session | `backend/worker/src/notifications/`, fly.toml checks | No |
| 4 | Document the multi-writer bridge contracts as invariants (extend `docs/ARCHITECTURE_MAP.md` §3 or a new `docs/CONTRACTS.md`) | `planner` (Haiku) drafts, main session lands | `docs/` only | No |
| any migration touchpoint | — | `migration-checker` (mandatory per CLAUDE.md) | read-only | No |

Fable/Opus stay in bounded review-only roles (phase gates), never as executors —
consistent with the project's model-routing rules.

## 6. Risk flags (must hold before any future extraction)

1. **Deploy cadence must be automated first** (§4). Splitting services while
   deploys are manual multiplies the existing lag bug per new service.
2. **The multi-writer bridge contract is an invariant, not debt**:
   `run_logs`/`analysis_runs`/`cover_letters` are intentionally
   web-creates-row, owning-service-updates-row. Any extraction must preserve
   the create/update split (event or callback), never "fix" it into single
   ownership mid-migration.
3. **Worker is untested**: zero test harness today. Extracting untested code
   into a new service converts unknown behaviour into a distributed unknown.
   Harness first (Phase 2), split later if ever.
4. **No shared runtime code exists across services** — a deliberate asset.
   Any split that would introduce the repo's first shared package (the 1b
   case) should be treated as adding a new architectural liability, priced
   accordingly.
5. **Shared Supabase with retired-but-present production JobTrackr tables**:
   additive-only migration rule and the manual SQL-editor apply process stay
   binding for any future service's tables.
6. **512MB ceilings on both Fly apps** are the current genuine scaling
   constraint — cheaper to raise than to architect around.
