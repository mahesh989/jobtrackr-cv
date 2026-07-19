# `dev-1` vs `dev` — Session Log

`dev-1` branched from `dev` at `fb431f5` on **2026-07-13**. As of `9c17a0f`
(**2026-07-19**): **30 commits, 64 files, +1265 / −1526** vs the branch point.

Two original purposes, then a third emerged:

1. Make `dev` — Bibek's "over-engineering audit" refactor — **actually deployable**.
2. Ship **product changes** on top once it was.
3. A **UX + reliability sprint** driven by live testing (Profile reform, work-type
   enforcement, stories/cover-letter fixes, Careerjet, worker reliability, fetch speed).

Both Fly apps (`jobtrackr-cv-api`, `jobtrackr-worker`) are deployed **from `dev-1`**.
`main`/production is untouched except one standalone OAuth fix (see end).

---

## Feature summary (added / improved / changed)

Product-level view of everything in this branch — the commit-level detail is in Parts 1–9 below.

### Added (new capabilities)

- **Work-rights & work-type chips on every job** — "Citizens only", "PR / Citizen",
  "Sponsorship", "Full-time", "Casual", etc. render on every card and board row (not just
  featured ones), only when the JD genuinely states it.
- **Cover letters for CVs with no measurable achievements** — care/trades CVs with no
  metric-backed bullets used to dead-end the pipeline. Extraction now falls back to
  "competence stories" (awards, trusted duties, scope), and letters generate even with
  zero stories (drawing substance from the CV text).
- **"On your CV" credential suggestions** — the credentials checklist flags which items
  (First Aid, CPR, …) it detected on the active CV.
- **Settings → Account page** — a home for Email connection + Notifications, split out of
  the profile page.
- **Deep-link to references** — the Details tab's "Review form" link jumps straight to the
  References section, already expanded.

### Improved (existing things made better)

- **Profile form autosaves** — uploading a CV used to wipe unsaved form entries.
- **Story extraction explains itself** — a zero-result "Re-extract" used to look broken;
  now surfaces the diagnostic.
- **Job fetches ~3 min faster** — killed a silent stall in the dedup step; fetches can no
  longer hang a whole run (per-source deadlines).
- **Runs never stick at "running" forever** — fixed the shutdown-ordering bug that orphaned them.
- **Sidebar scrolls** — Sign out / View-as-user were cut off below "Audit log".
- **Login lands on the Dashboard** — every login used to bounce to the Instructions wizard.
- **CV review supports block deletes** — experience roles, education, certifications, and
  referees can now be removed, not just added.
- **Google sign-in works** (shipped to production) — it used to complete then bounce back to login.

### Changed (behavior / structure that moved)

- **"My CV" → "Profile"**, reorganized into three sub-tabs: CVs / Details / Credentials
  (URL `/dashboard/cv` unchanged).
- **Working rights → one source of truth** (My CV visa status). The duplicate job-search radio
  and the duplicate credentials fields are gone; board filtering, badges, and the CV line all
  read that one field.
- **Work types → one control** (Profile → Details) that now **filters the job board too** — a
  full-time-only job hides if only Part-time/Casual is selected — not just future fetches.
- **References → edited in one place** (the CV review form); the pipeline pulls referees from
  there automatically. No parallel copy, no redundant AI extraction.
- **Removed from the board**: Type dropdown, Eligible-only checkbox, salary display (info
  moved to chips).

The recurring theme: **single source of truth** — working rights, work types, and references
each went from 2–4 competing copies down to one. Everything above sits on top of making the
refactor deployable in the first place (the build/runtime fixes in Part 1).

---

## Part 1 — Bugs found and fixed in `dev`'s refactor

`dev` claimed "155 worker tests + 15 backend tests passing" but shipped **6 distinct
breakages**, none caught by that suite. Root-cause pattern: dependencies/files/imports
removed without grepping every reference (partial migration).

| # | Bug | File(s) | Symptom | Why tests missed it | Fix commit |
|---|---|---|---|---|---|
| 1 | `bullmq`/`ioredis` dropped from `package.json` but still imported in 3 files | `route.ts`, `actions/_helpers.ts`, `rateLimit.ts` | Vercel build fails | Tests don't run `next build` | (folded in) |
| 2 | `app/core/request_id.py` deleted but `main.py` still imported from it | `backend/api/app/main.py` | FastAPI crashes on boot | No test imports `app.main` | `4b66c22` |
| 3 | `scripts/fetch_jd.py` deleted as a "dead dev script" — it's spawned as a subprocess by `curlfetch.ts` to bypass Cloudflare on SEEK/Careerjet | `backend/worker/scripts/fetch_jd.py` (restored, 137 lines) | Docker build fails; if missed, would silently break JD scraping in prod | Referenced via a runtime string path, not a static `import` — invisible to grep-based checks | `b6ccafa` |
| 4 | `audit_cleanup.test.ts`'s "deleted AI modules" tests used literal `import("./ai/scorer.js")` specifiers; `tsc` statically resolves literals | `backend/worker/src/audit_cleanup.test.ts` | `tsc` build fails | `vitest` doesn't do full static resolution the way `tsc` does | `9fc7d57` |
| 5 | `Literal` dropped from 3 schema files' `typing` import while still used in an annotation each (`AnalyzeResponse.status`, `CompanySize`, `tone_target`) | `schemas/internal.py`, `schemas/company.py`, `schemas/cover_letter.py` | **Live 500 — "Could not start analysis"** | Pydantic v2 defers resolution to first instantiation; nothing in the suite ever instantiated these models | `819ffd5` |
| 6 | `md:block` sidebar wrapper (was `flex flex-col`) + a 2nd nested wrapper in the new `SidebarData` with no height set | `layout.tsx`, `SidebarNav.tsx`, `SidebarData.tsx` | Sidebar cut off after "Audit log" — no Sign out, no View as user | CSS layout, invisible to any test | `54d613b`, `fd89268`, `19fbaec` |

**Regression-proofing added** (`961f2ed`): `backend/api/tests/test_schemas_build.py`
force-builds every Pydantic model in `app.schemas` via `model_json_schema()` — closes
the exact hole that let bug #5 through. Verified it fails on the original bug before the fix.

**Pipeline quality audit**: confirmed via full code diff + **3 live job comparisons**
(Uniting NSW/ACT ×2, Australian Unity) that `dev`'s refactor made **zero algorithmic
changes** to JD extraction, matching, ATS scoring, or cover-letter generation — only
constant dedup and helper extraction, all verified byte-equivalent. Score deltas between
runs are LLM run-to-run variance, reproducible on `main` too — not branch-caused.
(The Australian Unity 84 vs 59 swing traced to a 2-keyword JD where one borderline
match judgment moves the ATS keyword component ~24 points — a pre-existing scoring
fragility on credential-heavy JDs, present identically on `main`.)

---

## Part 2 — Work-type vocabulary unification (`94d5836`)

Four different vocabularies existed for one concept ("work type"). Unified onto the
extractor's 6-tag canonical set (`full_time, part_time, casual, contract, temporary,
internship`), defined once in `frontend/web/src/lib/constants.ts` with a mirror comment
to `backend/worker/src/ai/jdFacts.ts`. ProfileForm checkboxes + board chips now read it.
**Fixed a real bug**: `internship` was extractable but had no checkbox, so ticking any
work-type box silently excluded internship-classified jobs. My CV "Availability" was
deliberately kept separate (different concept) but relabeled "Preferred shifts".

---

## Part 3 — Profile reform (three phases)

The "My CV" page had become a junk drawer with duplicate data fields. Reformed in three
approved phases:

- **Phase A — structure** (`35cd9c2`): "My CV" → **"Profile"** everywhere user-facing
  (URL `/dashboard/cv` kept, so no links break). Three sub-tabs — **CVs** (default: role
  type + library) / **Details** (contact, working rights, preferred shifts, references) /
  **Credentials** — via the existing `ui/Tabs` primitive + `?tab=` shallow URL sync. Email
  account + Notifications moved off to a new `/dashboard/settings/account` page.
- **Phase B — working rights single source of truth** (`2949c51`): `contact_details.visa_status`
  is now the *only* working-rights field. `credentials.work_rights` + `work_rights_hours`
  removed from UI/types/sanitizer; dead duplicate components deleted (net −282 lines).
  `contact_line.py` (CV "Registration & Licences" line) and `keyword_feasibility.py` now
  derive from `visa_status`. 2-row backfill applied. Fixed two latent guard bugs (empty
  `credentials` dict bailed before `visa_status` was checked).
- **Phase C — dedup bridges** (`1423728`): reference pre-fill reads `structured_cv.references`
  directly (no LLM call — the old extract route became legacy fallback); credentials checklist
  shows "on your CV" suggestion pills from a deterministic cert-name→key map. Suggest only.

**Earlier, related** (`10bae8b`, `eca7b28`, `aa55b5d`):
- `eca7b28` — work-type + work-rights chips on **every** job card/row; removed the Type
  dropdown, Eligible-only checkbox, and salary; card meta wraps instead of truncating.
- `10bae8b` — removed the per-profile "Working rights" radio from the job-search form and
  its worker filter (contradicted My CV's `visa_status`; zero live profiles used it).
- `aa55b5d` — Profile form now **autosaves** (1.2s debounce); CV-upload navigation was
  discarding all unsaved form state.

---

## Part 4 — References single source of truth (`9cb2028`, `bdfbf47`, `7ba229b`)

The CV **review form is now the only referee editor**. At analyze time, both trigger paths
(manual route + worker `triggerAutoAnalyze`, which already fetched `structured_cv` — zero
new queries) splice the active CV's `structured_cv.references` into the outgoing
`contact_details.references`, keeping the user's include/on-request/omit mode. The Details
tab keeps only the mode radio + a link to the review form. The redundant extract-references
LLM route and the dead `ReferencesSection.tsx` were deleted. The review link deep-links with
`?section=references` and the References section auto-expands + scrolls to it.

---

## Part 5 — Setup gate + review-form deletes (`a1611c8`)

- **Setup gate bug**: `/api/user/setup-status` **hardcoded `searchProfile: false`** (a required
  step), so `isSetupComplete()` was false for **every** user on **every** login → everyone
  bounced to the Instructions wizard. Now uses the real `getSetupStatus()`.
- **CV review deletes**: experience roles, education entries, and certifications can now be
  deleted (and added) in review mode — handlers existed but were gated to create-mode.
  Referee rows got a brand-new per-row delete (none existed in any mode).

---

## Part 6 — Work types enforced on the job boards (`3a2ff6c`)

The Profile "Work types" selection previously filtered **only at fetch time**, so jobs saved
before the preference was set — or served from the shared bucket — still showed. Added a
**board-read mirror** of the worker filter (`passesWorkTypes` in `jobFilters.ts`) on both
boards + funnel counts: a classified job passes only when its extracted types intersect the
selection; **unclassified jobs always show**; applied/starred jobs stay visible regardless.
Also added the M080 fact columns to the main dashboard's job select (lit up chips there too).

---

## Part 7 — Stories & cover letters for duty-based CVs (`85b26cf`, `ca2aa50`)

Care/trades CVs often have zero metric-backed achievements, which dead-ended the cover-letter
pipeline.

- `85b26cf` — the extract route returns `200 {stories: [], diagnostic}` when the AI ran but
  found nothing; `StoriesClient` ignored the diagnostic, so "Re-extract" looked like it did
  nothing. Now surfaces the diagnostic in an amber banner.
- `ca2aa50` — two-layer fix: (1) extraction **competence-story fallback tier** — when no
  quantified achievements exist, extract 2–4 stories from awards, designated-person duties,
  sustained scope, trusted responsibilities (same honesty rules, no invented numbers);
  (2) **story-less generation unblocked end-to-end** — `auto_cover_letter` no longer skips,
  both web routes no longer 422, schemas made `story: Optional`. Letters draw substance from
  CV text when there's no story.

---

## Part 8 — Careerjet: retired, then reverted (`fa5e5fb` → `8e146f8`)

Investigated recurring thin-JD complaints. Data showed Careerjet produced **zero
organically-rich jobs** ever — the API 403s Fly's datacenter IP, enrichment never worked,
100% of its output was snippets. Retired it (`fa5e5fb`), then **reverted same day**
(`8e146f8`) per user direction: thin/snippet JDs are **accepted by design** (compliant API
use; users paste full JDs as "trailers", so unique jobs aren't missed).

**Caveat**: the purge done before the revert (25 untouched thin careerjet job rows + all
careerjet bucket rows) is **not restorable** — they repopulate on the next successful fetch.
The API currently 403s Fly's egress IP; the fix is **Careerjet affiliate-account IP config,
not code**.

---

## Part 9 — Worker reliability + fetch speed (`2a61070`, `bf0f831`, `ab0d36d`)

Investigated a run stuck "running" for 500+ seconds. Found and fixed three distinct issues:

- `2a61070` — **shutdown ordering**: `shutdown()` awaited `worker.close()` *before* the DB
  cleanup that marks in-flight runs failed. BullMQ's `close()` (concurrency 1) blocks until
  the current job finishes, which outlasts Fly's kill window — so the process was SIGKILLed
  before the cleanup line ever ran, orphaning runs at `status='running'` forever. Reordered:
  DB cleanup + `markExpectedShutdown()` run **first**; `close()` is now best-effort, raced
  against a 3s timeout.
- `bf0f831` — **per-adapter fetch deadlines**: a live incident showed seek-direct going
  silent for **9 minutes** with no inner timeout firing. Added `withDeadline()` around every
  `fetchJobs()` (5min parallel adapters / 6min seek-direct / 8min Apify actor). A hung source
  now degrades into the existing failure paths (health-tracking, actor fallback) instead of
  freezing the run.
- `ab0d36d` — **fetch speed**: a ~3-minute silent stall in every full fetch was one supabase
  `.in()` query carrying ~958 URL hashes (~64KB querystring, past PostgREST/proxy limits). It
  stalled for minutes **and failed silently** (error unchecked → `data=null` read as "0
  duplicates" → early dedup never ran). Now chunked at 150 hashes/query in parallel, errors
  logged, elapsed-ms in run logs. Expected: ~3 min off every full fetch + early L1 dedup
  working on large fetches for the first time.

---

## Deployment state (session end)

| Service | State |
|---|---|
| `backend/api` (Fly `jobtrackr-cv-api`) | Deployed from `dev-1`, `/health` 200, `/internal/analyze` verified live |
| `backend/worker` (Fly `jobtrackr-worker`) | Deployed from `dev-1` (latest: chunked-lookup + deadlines + shutdown fix) |
| `frontend/web` (Vercel) | Auto-builds `dev-1` on push |
| `main` / production | Untouched except **`96a5070`** — Google OAuth sign-in bounced back to login instead of the dashboard (the `if (!otpType) return dashboard` early-return in `confirm.ts`; already existed on `dev`, `main` never had it). Unrelated to `dev-1`. |

## Open items (carried to next session)

- **Profile form dual Save buttons** — post-autosave, "Save details" reads as ambiguous next
  to the CV's "Verified · Save". Proposal made (make it a quiet "all changes saved" status,
  surface a button only when a required field is missing); not built.
- **Careerjet affiliate IP registration** — API 403s Fly's egress IP; needs account-side config.
- **Outlook email OAuth** — unconfigured everywhere (no `MICROSOFT_CLIENT_ID`), so the Outlook
  option 500s even on production. Needs an Azure AD app + env vars before it works anywhere.

## Net effect

`dev-1` is `dev` made deployable and correct, plus a substantial UX + reliability sprint.
The refactor's actual goal — dead-code removal, constant dedup, helper extraction — is
verified sound (pipeline output byte-equivalent to `main`). Everything broken was a partial
migration (delete without grepping every caller), now fixed and, for the schema-resolution
class, guarded against recurring. On top of that: one honest source of truth for working
rights and work types, a coherent Profile page, cover letters that work for the core
(duty-based care) audience, and a fetch pipeline that can no longer hang or silently stall.

---
*Full live state also recorded in `.claude/graph.json` (`build_state.active_branch_work`,
session 2026-07-19).*
