# UI Backlog — Handoff for a Fresh Session

> Pending **web/UI** work batched out of a long worker-focused session (2026-06-26).
> All items are frontend (`frontend/web`) and need a **Vercel preview** to verify —
> do NOT blind-push to `main` (it auto-deploys to production). This repo's Next.js
> is flagged as breaking-changed (see `frontend/web/AGENTS.md`) — read its docs
> before writing.
>
> Worker-side prerequisites are ALREADY DONE & live: 30km auto-analyze gate,
> platform-key auto-analyze, title-only keyword filter, bucket engine.

## 1. "Recently added" sort (+ make it the DEFAULT)
- New sort option: **"Recently added"** = jobs with `created_at` **today** (>= local start-of-day), ordered by **`posted_at` DESC** within that set. (Confirmed scope: "added today"; if none today it naturally shows nothing for today — that's acceptable per the user.)
- Make it the **default sort** (replaces `posted_at` as the dropdown default).
- Files: `frontend/web/src/components/jobs/SmartToolbar.tsx` (SORT_OPTIONS ~line 33-35, `currentSort` default ~line 111), `frontend/web/src/components/jobs/jobFilters.ts` (`sortJobs`, ~line 220-260 — add a `recently_added` branch: filter to today's created_at, then `posted_at` desc).
- Note: there's already a `created_at` ("Date added") option — this is DIFFERENT (it scopes to today + sorts by posted_at).

## 2. "New · unseen" badge → clickable filter
- The `13 New · unseen` badge (PipelineFunnel `counts.newCount`, `PipelineFunnel.tsx` ~line 210) is currently passive. Make it **clickable** → filters the board to **unseen** jobs (`seen_at IS NULL`, not applied, not dismissed — mirrors `isNew` in `JobTable.tsx:218`).
- Clicking it should land on the **"Recently added"** view (item 1) — unseen ≈ recently added.
- Wire via the existing filter/param system (`SmartToolbar` triage/stage params + `jobFilters.ts`). Add a triage value like `unseen` and a `filterJobs` branch for `!seen_at && !applied_at && !dismissed_at`.

## 3. Profile form: default selections + 30km copy
File: `frontend/web/src/components/ProfileForm.tsx` (automation pipeline section).
- **Default "Tailor" to Auto** (auto-generate tailored CV + cover letter) for new profiles.
- **Default "Send" to "Auto-send after I verify"** (drafts wait in outbox until Verify).
- **Add help copy** under the Tailor option explaining the live behavior:
  > "Auto-analysis runs only for jobs within **30 km** of your home address. Jobs farther away (or if no address is set) are **not** auto-analysed — run those manually with Analyze."
- ⚠ These are **behavior-changing defaults** (auto-tailor by default = AI spend per new profile). Verify on preview; confirm with the user that new profiles should default to auto.

## 4. BUG: dashboard "keeps refreshing/loading" during analysis
- Repro: edit a thin JD → full JD → save → auto-analysis starts → after a while the dashboard repeatedly reloads/flashes.
- Root pattern: the board updates via full **`router.refresh()`** (re-runs the whole query-heavy server component) instead of patching the affected row from Realtime. Refresh triggers compound during an active run:
  - `LiveRunStatus.tsx` — 3s poll + `router.refresh()` on transitions
  - `RunNotifier.tsx` — 20s backstop + refresh on run_logs terminal
  - `JobEditModal.tsx:118` — refresh after triggering re-analysis
  - the only `analysis_runs` Realtime sub is `AnalysisRunClient.tsx:284` (the dedicated analyze page — correct there)
- **Fix direction:** stop full-page `router.refresh()` for live job state on the board; instead subscribe to `analysis_runs` `postgres_changes` and patch the single job row's analysis state client-side (the board already holds the job list). Needs **browser DevTools (Network tab) on a preview** to confirm which trigger fires repeatedly before changing it.

## 5. Role type — DECISION: keep the dropdown (do NOT remove)
- The user asked to remove "Role type" and derive the vertical from the CV. **Investigated: `target_verticals` IS used for fetching** — `orchestrator.ts:494-496` gates sector-specific source adapters (NSW/VIC/QLD Health etc.) on it; it also drives ATS thresholds (healthcare 55/65) and CV-tailoring pipeline routing.
- **Recommendation: keep the field.** It's a search/sourcing parameter, not a CV attribute; the worker needs it deterministically at scrape time without parsing the CV. Optional convenience: **pre-fill** it from the active CV's detected domain (smart default, still editable) — but do not remove the control.

## Done already (this session, on `main`, deployed) — for context
- 30km auto-analyze gate (`triggerAutoAnalyze.ts`, `1acd794`)
- auto-analyze uses platform AI key, not BYOK (`447b072`)
- "Title must include" is title-only, no teaser rescue (`87b0b5c`)
- pipeline-running box single-hue colour (`ed78f2e`)
- bucket engine + cleanup (see `docs/global-job-bucket-plan.md`)
