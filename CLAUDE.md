# JobTrackr-CV — Claude Rules

This project integrates the cv-magic CV-tailoring pipeline into JobTrackr. **Read `docs/design.md` once at the start of every fresh conversation** — the phased plan, bridge contract, and data model live there. Then check `.claude/graph.json` for current state.

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

## Project Identity

- **Product**: JobTrackr-CV — JobTrackr + on-demand AI CV tailoring
- **Source projects**: JobTrackr (job discovery, deployed) + cv-magic (CV pipeline, separate SaaS)
- **Strategy**: Copy & adapt, do not modify either source project
- **Deployment**: Vercel previews + Fly.io workers from this repo. Production JobTrackr stays on its own repo.

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

## Phase Verification Gates (do not skip)

Before marking a phase `completed`, run the gate manually and capture the result in graph.json:

- **Phase 0:** Vercel preview URL loads JobTrackr unchanged.
- **Phase 1:** Manual SQL INSERT/SELECT on new tables works; Realtime fires.
- **Phase 2:** `curl` to backend/api `/health` returns 200 from Fly.io; signed `/internal/analyze` returns 202.
- **Phase 3:** Upload PDF, see extracted text, switch active CV.
- **Phase 4:** Paste real Anthropic key, validated, masked, saved.
- **Phase 5:** Click Analyze on a SEEK job → step 1 result appears via Realtime.
- **Phase 6:** Full pipeline runs end-to-end on preview, all cards render.
- **Phase 7:** Tailored PDF downloads and renders correctly.
- **Phase 8:** Adzuna scrape fallback works; re-run marks prior stale.
- **Phase 9:** Production-ready on preview URL.

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
