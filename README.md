# JobTrackr-CV

JobTrackr with an integrated CV-tailoring pipeline (ported from cv-magic).

This is a **separate project** copied from JobTrackr — production JobTrackr is untouched until we squash-merge a finished feature back into it (or decide to keep them split). Every push to this repo redeploys a Vercel preview + Fly.io worker for live testing.

## Repo layout

```
web/         Next.js 14 — JobTrackr frontend + new CV/analysis UI
worker/      Fly.io Node.js — existing JobTrackr pipeline (untouched)
cv-backend/  FastAPI Python — CV-tailoring pipeline (added in Phase 2)
supabase/    Migration SQL — additive only, new tables for CV/analysis
.claude/     graph.json (project model), settings.json (Stop hook)
DESIGN.md    Full integration plan — read this first
CLAUDE.md    Build rules + session protocol
```

## What's new vs. JobTrackr

| Feature | Where |
|---|---|
| Upload CV (PDF) with versioning + active flag | `/cv` page, `cv_versions` table |
| BYOK Anthropic/OpenAI keys | `/settings/ai-keys` page, `user_integrations` table (extended) |
| "Analyze" button on each job card | `/jobs/[id]/analysis/[run_id]` page |
| 7-step CV-tailoring pipeline | `cv-backend/` FastAPI service |
| Tailored CV PDF download | Supabase Storage + `analysis_runs.tailored_pdf_storage_path` |

## Source of truth

- **Build plan & status:** `.claude/graph.json` → `build_state` + `build_plan`
- **Architecture & decisions:** `DESIGN.md`
- **Session rules:** `CLAUDE.md`

Read `DESIGN.md` for the full integration plan including phased rollout, bridge contract, data model, and verification gates.

## Local dev

Same as JobTrackr until Phase 2 adds cv-backend:

```bash
cd web    && cp .env.example .env.local && npm install && npm run dev
cd worker && cp .env.example .env       && npm install && npm run dev
```

Once cv-backend is added:

```bash
cd cv-backend && cp .env.example .env && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8001
```

## Deploy targets

| Service | Provider | Name |
|---|---|---|
| `web/` | Vercel | `jobtrackr-cv` |
| `worker/` | Fly.io | `jobtrackr-cv-worker` |
| `cv-backend/` | Fly.io | `jobtrackr-cv-api` (added Phase 2) |
| Postgres + Storage + Realtime | Supabase | (shared with production JobTrackr — additive tables only) |
