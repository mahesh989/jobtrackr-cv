# JobTrackr-CV — System Invariants

> Rules that aren't visible from reading the code, and that a well-meaning
> "cleanup" could break by accident. Companion to `docs/ARCHITECTURE_MAP.md`
> (structural facts, regenerate-don't-hand-edit) and `CLAUDE.md` (project
> rules) — this file is for the *why*, hand-authored, meant to survive a map
> regeneration. Added per `docs/MIGRATION_PLAN.md` §5 Phase 4.

Each entry: the rule, why it exists, and what breaks if it's violated.

## 1. The multi-writer bridge contract

**Rule.** Three tables are intentionally written by two services each, split
by lifecycle stage — never collapse this to single ownership:

| Table | Creates the row | Updates the row |
|---|---|---|
| `run_logs` | **web** (`POST /api/profiles/[id]/run`) | **worker** (progress writes as the pipeline runs) |
| `analysis_runs` | **web** (`POST /api/jobs/[id]/analyze`) | **api** (service-role step-progress writes) |
| `cover_letters` | **web** (also owns PATCH/DELETE/`pick` routes) | **api** (service-role generation) |

**Why.** The client (web) is what the user is looking at — it creates the
row the instant an action is triggered, so the UI has something to subscribe
to via Supabase Realtime (`postgres_changes`) immediately, before the
owning backend service has even picked up the job. The owning service then
streams progress into that same row as it works. This is *by design*, not
an accident of two teams writing to the same table — `ARCHITECTURE_MAP.md`
§3 labels all three "Hotspot (by design)" for exactly this reason.

**Breaks if violated.** If a future service extraction "fixes" this into
single ownership (e.g. worker/api creates its own row instead of web), the
Realtime subscription the frontend already has wired up breaks — there's no
row to subscribe to until the backend service starts, so the UI shows
nothing during the gap between "user clicked the button" and "backend
picked up the job." Any future extraction of `worker` or `api` into a
standalone service must preserve the create/update split via an event or
callback — never resolve it into one service owning the whole row
lifecycle.

## 2. Deploy jobs must run from the app's own directory

**Rule.** In `.github/workflows/deploy.yml`, both `deploy-worker` and
`deploy-api` set `defaults.run.working-directory` to `backend/worker` /
`backend/api` respectively, and invoke `flyctl deploy --remote-only
--config fly.toml` (a bare relative path, not `backend/worker/fly.toml`).
Do not remove the `working-directory` or "simplify" the `--config` path
back to a repo-root-relative one.

**Why.** Two facts compound in a non-obvious way:
- The `dockerfile` field in `fly.toml`'s `[build]` section (`dockerfile =
  "Dockerfile"`) resolves relative to the directory containing `fly.toml`,
  not the process's cwd.
- The Docker build *context* (what `COPY` instructions in the Dockerfile can
  see) always follows the process's cwd, independent of where the
  `dockerfile` field points — this is a documented Fly quirk, not a bug.

Both `backend/worker/Dockerfile` and `backend/api/Dockerfile` write their
`COPY` instructions relative to their own directory as context root (e.g.
`COPY package.json ./`, `COPY src ./src`). If the deploy job's cwd is the
repo root instead of the app directory, the dockerfile path still resolves
correctly (first fact) but the build context is wrong (second fact) — the
Dockerfile compiles but can't find `/package.json`, `/src`, etc.

**Breaks if violated.** Confirmed the hard way in production: the first two
live runs of `deploy-worker` both failed for exactly this reason — one for
"no Dockerfile found" (before the config had a `dockerfile` field at all),
one for "COPY sources not found" (dockerfile field added, but cwd still
repo root). Both errors look like normal build breakage in CI logs, not
like a configuration mismatch, so this is easy to misdiagnose without this
note. A future "cleanup" that collapses `working-directory` + `fly.toml`
back into a single `--config backend/worker/fly.toml` from repo root will
silently reintroduce the second failure.

## 3. Worker crash recovery is automatic; crash notification is not

**Rule.** Do not assume an OOM kill or crash on `backend/worker` will page
anyone. Recovery and notification are two separate concerns with very
different maturity:

- **Recovery — solved, zero config.** Fly's default `restart_policy`
  (`on-failure`) auto-restarts a machine whose process exits/crashes,
  including a SIGKILL from an OOM event. Nothing in this repo configures
  this explicitly (`backend/worker/fly.toml` has no `[[restart]]` block) —
  it's the platform default, already in effect today.
- **Notification — in-code half closed.** `src/index.ts` now distinguishes
  a deploy-triggered SIGTERM (expected — writes a Redis "expected
  shutdown" marker via `notifications/restartDetection.ts` before exiting,
  stays quiet on next boot) from anything that skips that path: an
  uncaught exception/unhandled rejection (new `process.on` handlers,
  alerts immediately with the real error before exiting) or an OOM
  SIGKILL (no handler runs, but the *absence* of the expected-shutdown
  marker at the next startup — which happens within seconds, thanks to
  `restart_policy` — triggers the same alert, `errorAlert.ts`'s
  `sendWorkerRestartAlert()`, deduped so a crash loop sends one email per
  window, not one per restart). This is a real improvement over the old
  stale-lock-only detection (minutes-to-days lag) even for the OOM case,
  since the worker process itself restarts fast even though it can't
  alert *before* dying.
- **Still open — pure crash-loop-before-first-boot.** If the process
  never completes a startup (a bug that throws before the marker-check
  code even runs), nothing in `backend/worker` can ever alert, because
  nothing in `backend/worker` ever finishes running. This is structurally
  a Fly-platform-detection problem, not a code problem — see the
  follow-up options below. Not yet done: confirming Fly's org-level
  crash-loop failure-alert emails are switched on for this account
  (dashboard setting, zero code), or a log-drain watching for Fly's OOM
  log signature for true zero-latency detection independent of whether
  the worker code ever runs again.

**Why the first attempt at this didn't work.** A `fly.toml` `[[checks]]`
exec-type liveness probe was built and then deliberately removed in Phase 3
(see PR #27 history) after review surfaced two problems: (1) it assumed the
app is PID 1 inside the container, but Fly injects its own init process
ahead of the app, so a `/proc/1/comm`-style check reads Fly's init, not the
worker; (2) even fixed, a failing check doesn't do anything for a non-HTTP
background worker — check failures don't drive `restart_policy` (that's
keyed on process exit, not check status) and there's no `http_service` to
reroute traffic away from. It would only flip a status flag in
`fly checks list` that nothing reads. This dead end is recorded here so
it isn't re-derived from scratch next time someone reaches for "just add a
Fly health check" — the working answer turned out to be in-process
(signal handlers + a Redis marker), not a Fly config change.

**Breaks if violated (i.e. if the remaining gap is mistaken for "already
handled").** The in-code mechanism only reports a restart *after* the
worker successfully boots again. Anyone assuming "the worker alerts on
literally any crash scenario" will be surprised specifically by the
crash-loop-before-first-boot case above — everything else (deploy, normal
crash, OOM) is covered.

## 4. No shared runtime code across `frontend/web` / `backend/worker` /
   `backend/api`

**Rule.** Each of the three deployable services vendors its own
dependencies independently. `shared/supabase/` holds only SQL migrations —
no shared npm/pip package, no shared runtime library. Do not introduce one
without treating it as a deliberate, priced architectural decision.

**Why.** `ARCHITECTURE_MAP.md` §6 notes this absence is itself the asset: a
future service split "carries no shared-library untangling cost — the
boundary already exists at the source level." `MIGRATION_PLAN.md` (§1b, the
no-go on splitting `cover_letter`/`company` out of `backend/api`) explicitly
flags that creating the repo's first shared package would be "a real cost
the current architecture deliberately avoids."

**Breaks if violated.** Introducing a shared package (even a small one, e.g.
"just the HMAC helper") creates the repo's first cross-service build/version
dependency — a change to the shared code now needs to be tested against
every consumer, and a version-skew bug becomes possible for the first time.
For a solo-developer team, this is exactly the kind of "N×CI, cross-app
versioning" cost `MIGRATION_PLAN.md` §1c independently flags as the reason
micro-frontends are a no-go. Treat any proposal to add shared runtime code
the same way: a new liability to price, not free deduplication.

## 5. 512MB memory ceiling and `concurrency: 1` are coupled

**Rule.** `backend/worker`'s BullMQ `Worker` is configured with
`concurrency: 1` (`src/index.ts`). Do not raise this without also raising
`backend/worker/fly.toml`'s `[[vm]] memory` above `512mb` — the two must
move together.

**Why.** The worker's own code comment explains it directly: Jora spawns a
Playwright Chromium instance per pipeline run, at roughly 200–300MB
resident. Two concurrent pipeline runs on a 512MB machine send the VM into
swap thrashing, and Jora hangs silently inside its own browser-launch code
with no error logged — a failure mode that's expensive to debug because
nothing *fails*, it just stalls. `MIGRATION_PLAN.md` §1a independently
identifies this exact constraint ("Jora disabled for OOM at 512MB") as a
**VM-sizing problem**, not a signal to split the worker into a separate
ingestion service — bumping memory (`~$5/mo`) is strictly cheaper than a
service split and buys more headroom.

**Breaks if violated.** Raising `concurrency` without raising memory
reintroduces the exact silent-hang failure mode that got Jora disabled in
the first place — but now affecting the whole pipeline, not just one
source adapter, since concurrent runs (not just concurrent adapters within
one run) would be competing for the same 512MB.

## 6. Additive-only migrations — because the Supabase project isn't just this project's

**Rule.** Never `ALTER` an existing table. Only `INSERT` new tables (already
stated as a non-negotiable decision in `CLAUDE.md`).

**Why the blast radius is bigger than it looks.** This isn't just
conservative schema hygiene for this codebase — the same Supabase project
also holds **retired-but-present tables from production JobTrackr**
(`ARCHITECTURE_MAP.md` §8). An `ALTER` here isn't scoped to
`jobtrackr-cv`'s own tables; it's a schema change against the same physical
database a separate, live product's tables live in. There is no
project-level isolation enforcing this — it's a discipline, not a
constraint the database itself enforces.

**Breaks if violated.** An `ALTER` (even one that looks safe — e.g. widening
a column) risks touching production JobTrackr's assumptions about that
database if applied carelessly (e.g. via a broad `ALTER TABLE ... ALL` or a
migration tool that doesn't scope by table name precisely), and there is no
automatic safeguard beyond the `migration-checker` subagent process
(`CLAUDE.md`) and this documented discipline. Treat every migration as
touching shared, cross-product infrastructure, not a private schema.
