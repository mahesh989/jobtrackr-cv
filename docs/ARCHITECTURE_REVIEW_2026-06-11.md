# JobTrackr-CV — Architecture & Refactor Review

> Senior review, 2026-06-11. Branch: `refactor/architecture-review`.
> Hard constraint honoured throughout: **the CV-tailoring pipeline and the
> sourcing pipeline are not to be touched.** Everything proposed below is
> non-behavioural — renames, moves, boundaries, docs, tooling, security,
> DB hygiene. No logic inside `cv-backend/app/services/pipeline/**`,
> `cv-backend/app/services/eval/**`, or `worker/src/pipeline/**` changes.

---

## 0. What the system actually is (the thing your friend couldn't see)

Three runtimes, two clouds, one database:

| Service        | Runtime            | Host        | Job                                              |
|----------------|--------------------|-------------|--------------------------------------------------|
| `web/`         | Next.js 14 (TS)    | Vercel      | Frontend **and** ~40 backend API routes          |
| `worker/`      | Node + BullMQ (TS) | Fly.io      | Job sourcing pipeline (scrape → normalise → save) |
| `cv-backend/`  | FastAPI (Python)   | Fly.io      | CV-tailoring pipeline (the precious one)          |
| Supabase       | Postgres+Storage+Realtime | managed | Shared DB, 27 tables, 26 with RLS          |
| Upstash, Apify | —                  | managed     | Redis queue, scraper actors                       |

**Why it reads as messy at a glance:**
- `web/` is not "the web" — it's a full-stack app (frontend + a backend). The
  name hides half its job.
- There are **two** backends (`worker`, `cv-backend`) in two languages. Nothing
  at the top level says which does what or how they relate.
- The repo root has a near-empty `package.json` (one stray dep) but no
  workspace/monorepo tooling — three independent manifests, no orchestration.
- 30 committed markdown files, several of them session detritus
  (`SESSION_2026_06_05.md`, `NEXT_SESSION_INSTRUCTIONS.md`, two `CLAUDE.md`,
  `AGENTS.md`). Signal is buried.

The fix for the *perception* problem is cheap (Section 1). The deeper items
(Sections 2–4) are the real engineering.

---

## 1. Project & file architecture

**Findings**
- `web/src/components` mixes ~18 flat top-level components with feature
  subfolders (`jobs/`, `applications/`, `cv/`…). Inconsistent.
- Large files concentrating risk: `SmartFeed.tsx` 1417, `JobFeedBetaClient` 987,
  `ApplicationCardV2` 986, `CoverLetterPanel` 812, `PipelineDonut` 807,
  `lib/actions.ts` 727 (god-module of server actions), `lib/cvBackend.ts` 658.
- `dashboard/beta/**` — 8 experimental routes shipped inside the production app
  tree (job-feed, applications, sources, summary-audit, skills-audit, …).
- Python side has its own giants: `pdf_generator.py` 1324,
  `tailored_structural_validation.py` 1265, `ai/prompts/tailored_cv.py` 1234.
  (Most are pipeline-internal → leave logic alone, but they're worth a
  module-split that preserves behaviour — already started for `eval/writers`.)
- No shared type contract between `web` (TS) and `cv-backend` (pydantic). The
  request/response shapes are hand-mirrored in two languages.

**Recommended target layout (rename for clarity, no behaviour change)**
```
apps/
  frontend/      ← was web/      (Next.js UI + thin API/BFF layer)
  worker/        ← was worker/   (sourcing pipeline)
  cv-service/    ← was cv-backend/ (tailoring pipeline)
packages/
  contracts/     ← shared request/response types (TS) + generated pydantic parity
infra/
  supabase/      ← was supabase/  (migrations + RLS)
docs/            ← consolidated; session logs moved out of the tree
```
- Adopt a workspace tool (pnpm workspaces or turborepo) so `apps/*` share lint,
  tsconfig, and one `install`/`build`/`test` entrypoint.
- Split `lib/actions.ts` into `lib/actions/<feature>.ts`. Same for the 800+
  line client components — extract presentational sub-components.
- Move `dashboard/beta/**` behind one `BETA` flag dir or out of the prod tree.

**Cost / risk:** mostly mechanical, low risk. Renames are the only thing that
touch deploy config (Vercel root dir, Fly working dirs) — do those in lockstep.

---

## 2. Database architecture

**Findings**
- 63 migration files, 27 tables, **26 RLS-enabled** — good security discipline.
- **Two migrations share number `027`** (`027_add_company_address_to_jobs.sql`
  and `027_cover_letter_variants.sql`). Apply-order is ambiguous.
- Migrations are applied **by hand in the Supabase SQL editor** (memory notes
  "apply 055 in SQL editor"). No runner, no CI gate, no drift detection. Prod
  schema and the migration files can silently diverge.
- The "additive-only, never ALTER" rule (sound in spirit) has made `jobs` a
  bolt-on table: `has_email` (generated), `manual_jd`, `company_address`,
  `hiring_manager`, `starred`, `distance`, … It keeps accreting columns.
- One Supabase project shared by all three services, each holding a
  service-role key → single blast radius.

**Recommendations**
- Introduce a real migration tool (Supabase CLI `db push`/`migration`, or
  sqitch) and a CI check that `db diff` is empty against `main`. Stop hand-running SQL.
- Renumber the duplicate `027` and add a CI lint that fails on number
  collisions / gaps.
- Generate a single `docs/database.md` ERD from live schema (already a stub) and
  keep it generated, not hand-written.
- Longer term: a periodic squash of the 63 migrations into a baseline + recent
  tail, so a fresh environment isn't replaying two months of history.
- Consider splitting service-role access: per-service DB roles with least
  privilege instead of one god key everywhere.

---

## 3. Microservices & boundaries

**Findings**
- `web` API routes both **proxy to cv-backend over HMAC HTTP** (good) and **do
  heavy work themselves** via server actions. The line between "lives in a Next
  route" and "lives in cv-backend" is blurry.
- `worker` and `cv-backend` never talk directly — they coordinate **through
  shared DB rows** (`analysis_runs`, `run_logs`). The row *is* the message bus
  (Realtime). It works, but it's an undocumented schema-as-API with no
  versioning; any column rename is a cross-service breaking change.
- No contract tests between services. The HMAC bridge shape is the only
  formalised boundary.

**Recommendations**
- Write down the boundary: a one-page "service contract" doc — what each service
  owns, which tables are its private state vs shared bus, which columns are the
  contract. Cheap, high leverage.
- Treat `analysis_runs`/`run_logs` columns used cross-service as a versioned
  contract (the `packages/contracts` idea). Add a contract test that fails CI if
  the shape drifts.
- Decide and document the BFF rule: Next API routes orchestrate + auth only;
  anything CPU/AI-heavy goes to cv-backend. Migrate the few heavy server actions
  that violate it (non-pipeline ones).
- Do **not** merge worker and cv-backend — two languages, two scaling profiles;
  the split is correct. Just formalise the seam.

---

## 4. Security (the headline, including your Vercel/IP concern)

**P0 — fix first**
1. **No edge protection on the Vercel deployment.** The only gate is Supabase
   auth inside `middleware.ts`. There's no Vercel Deployment Protection, no
   Cloudflare/WAF, no edge rate limiting. Two concrete actions:
   - Turn on **Vercel Deployment Protection** (or front it with **Cloudflare**:
     proxied DNS, WAF, bot/rate rules, and restrict the origin to Cloudflare IPs
     so the raw `*.vercel.app`/IP can't be hit directly). This is exactly the
     "I could log in via IP" problem.
   - Add edge rate limiting (Upstash Ratelimit — you already run Upstash) on
     `/api/auth/*`, signup, and the AI/analyze endpoints.
2. **`/api/**` is exempt from the middleware auth redirect** (`!isApiRoute` at
   `middleware.ts:50`). That's a deliberate design (routes self-guard), but it
   means **every** route must check auth itself. Needs a one-pass audit that all
   ~40 routes call `getAuthUser()`/role checks — a single unguarded route is a
   data leak. Recommend a shared `withAuth()` wrapper so it can't be forgotten.
3. **Real JWT in a tracked example file.** `worker/.env.example` ships a live
   Supabase JWT (decodes to `role: anon`, project ref `ltcqqlfsomqxuwfcxxbe`).
   Anon is public-safe, so not catastrophic — but example files must use
   placeholders. The untracked local `web/.env.example` on disk holds a real
   **service_role** key (full RLS bypass); it's gitignored so not leaked via
   git, but it's a loaded gun in the tree. Scrub both to placeholders; rotate the
   service-role key if that file was ever shared.

**P1**
- `cv-backend` CORS uses `allow_methods=["*"]`. Origins are restricted, but
  pin methods to what's used.
- BYOK AI keys + no rate limiting = a cost-abuse vector. Cap per-user spend at
  the edge as well as in `costCap.ts`.
- CSP intentionally omits `script-src`/`connect-src` (acknowledged in
  `next.config.ts`). Plan the nonce rollout to close it.

**Already good (keep)**
- RLS on 26/27 tables. HMAC-SHA256 bridge with router-level `Depends(verify_hmac)`.
- A dedicated `app/security/ssrf.py` module. Baseline security headers + HSTS
  preload. Sentry wired. No `node_modules`/`.env`/`.pyc` committed.

---

## 5. Suggested execution order (each phase is independently shippable)

1. **Security P0** (days): Cloudflare/Vercel protection + edge rate limit;
   `withAuth()` wrapper + route audit; scrub example files + rotate key.
2. **Repo legibility** (days): top-level rename to `apps/*` + `infra/`, workspace
   tooling, consolidate docs, move `beta/` behind a flag. Deploy-config in lockstep.
3. **DB hygiene** (days): migration runner + CI drift gate, fix duplicate `027`,
   generated ERD.
4. **Boundaries** (ongoing): service-contract doc, `packages/contracts`, BFF rule,
   split `lib/actions.ts` and the 800+ line components.

**Untouched by all of the above:** `cv-backend/app/services/pipeline/**`,
`cv-backend/app/services/eval/**`, `worker/src/pipeline/**`,
`worker/src/sources/**`. The pipeline keeps running exactly as it does today.
