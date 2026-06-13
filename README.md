# JobTrackr-CV

JobTrackr with an integrated CV-tailoring pipeline (ported from cv-magic).

This is a **separate project** copied from JobTrackr — production JobTrackr is untouched until we squash-merge a finished feature back into it (or decide to keep them split). Every push to this repo redeploys a Vercel preview + Fly.io worker for live testing.

## Repo layout

```
frontend/
  web/             Next.js 16 — JobTrackr frontend + CV/analysis UI (Vercel)
backend/
  api/             FastAPI Python — CV-tailoring pipeline (Fly: jobtrackr-cv-api)
  worker/          Node.js BullMQ — job-discovery pipeline (Fly: jobtrackr-worker)
shared/
  supabase/        Migration SQL — additive only, shared by both backends
docs/              Architecture, design, database, cover-letter spec
.claude/           graph.json (project model), settings.json (Stop hook), agents
CLAUDE.md          Build rules + session protocol
docs/design.md     Full integration plan — read this first
```

## What's new vs. JobTrackr

| Feature | Where |
|---|---|
| Upload CV (PDF) with versioning + active flag | `/cv` page, `cv_versions` table |
| BYOK Anthropic/OpenAI keys | `/settings/ai-keys` page, `user_integrations` table (extended) |
| "Analyze" button on each job card | `/jobs/[id]/analysis/[run_id]` page |
| 7-step CV-tailoring pipeline | `backend/api/` FastAPI service |
| Tailored CV PDF download | Supabase Storage + `analysis_runs.tailored_pdf_storage_path` |

## Source of truth

- **Build plan & status:** `.claude/graph.json` → `build_state` + `build_plan`
- **Architecture & decisions:** `docs/design.md`
- **At-a-glance map:** `docs/architecture-overview.md`
- **Session rules:** `CLAUDE.md`

Read `docs/design.md` for the full integration plan including phased rollout, bridge contract, data model, and verification gates.

## Local dev

```bash
cd frontend/web    && cp .env.example .env.local && npm install && npm run dev
cd backend/worker  && cp .env.example .env       && npm install && npm run dev
cd backend/api     && cp .env.example .env       && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8001
```

## Deploy targets

| Service | Provider | Name |
|---|---|---|
| `frontend/web/` | Vercel | `jobtrackr-cv` |
| `backend/worker/` | Fly.io | `jobtrackr-worker` |
| `backend/api/` | Fly.io | `jobtrackr-cv-api` |
| Postgres + Storage + Realtime | Supabase | (shared with production JobTrackr — additive tables only) |
