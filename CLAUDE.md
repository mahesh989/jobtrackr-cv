# JobTrackr-CV — Claude Rules

This project integrates the cv-magic CV-tailoring pipeline into JobTrackr. **Read `DESIGN.md` once at the start of every fresh conversation** — the phased plan, bridge contract, and data model live there. Then check `.claude/graph.json` for current state.

## How to Use This Repo Efficiently

**SESSION START — mandatory:**
1. Read `.claude/graph.json` in full
2. Read `DESIGN.md` (skim if already familiar)
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

1. **Two services, one DB.** JobTrackr's Next.js + worker stay TypeScript. cv-backend stays Python (FastAPI). Communicating via HMAC-signed HTTP. Shared Supabase.
2. **No logic porting.** cv-magic's pipeline orchestrator, 7 step files, ReportLab PDF generator, AI prompts — all stay Python verbatim.
3. **Strip cv-magic of:** Clerk auth, Stripe billing, quota, Resend email, webhooks, user/company/cv_versions routes (we add our own).
4. **BYOK only.** Users supply Anthropic / OpenAI keys. Encrypted with the same AES-256-GCM helper JobTrackr already uses for Apify.
5. **Realtime everywhere.** Frontend subscribes to Supabase `postgres_changes` on `analysis_runs` row for live step status. No polling.
6. **Additive DB changes only.** Never ALTER existing JobTrackr tables. Only INSERT new tables (`cv_versions`, `analysis_runs`) and extend the `user_integrations.provider` value set.
7. **Phased rollout with manual verification.** Each phase ends with a checkpoint to be tested on the Vercel preview URL before moving to the next.
8. **One CV active per user.** Many `cv_versions` rows, partial unique index on `(user_id) WHERE is_active = true`.

## Code Conventions

- **Frontend** — same as JobTrackr: TypeScript, Next.js App Router, Tailwind, TanStack Query, Supabase browser client only for Realtime.
- **Worker** — unchanged from JobTrackr. Don't extend it for CV work; that's cv-backend's job.
- **cv-backend** — Python 3.11+, FastAPI, async-only, httpx, Supabase service-role client (no SQLAlchemy session for this project — direct REST writes are simpler).
- **Bridge** — internal HMAC-SHA256(timestamp + body), shared secret in env. Never expose cv-backend endpoints to the browser.

## Phase Verification Gates (do not skip)

Before marking a phase `completed`, run the gate manually and capture the result in graph.json:

- **Phase 0:** Vercel preview URL loads JobTrackr unchanged.
- **Phase 1:** Manual SQL INSERT/SELECT on new tables works; Realtime fires.
- **Phase 2:** `curl` to cv-backend `/health` returns 200 from Fly.io; signed `/internal/analyze` returns 202.
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
