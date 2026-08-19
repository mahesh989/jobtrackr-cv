# Job Board → Master-Detail Redesign — Plan

> **Archived 2026-08-19** — this redesign shipped; see the companion
> handoff doc in this same folder. Moved here as a completed record; not
> maintained.

Branch: `feat/board-detail-redesign` (off `dev-5`)
Status: PLAN — awaiting confirmation before implementation.

## Goal (as I understand it)

Bring the split **list + detail** layout from the `job-board-mockup-v5.html` prototype into
the real app, **without changing** the top of the page or the grouping/filtering behaviour.

- Keep everything from the top down through the **distance ribbon** exactly as it is now
  (toolbar: Distance / Sort / location search + JOBS / ANALYSIS / ATS / STAGES / JDs chips,
  then the DISTANCE FROM HOME strip). Same on the per-profile board.
- Keep the **grouped sections** (Closest to you / Fresh today / Needs attention / Everything
  else, plus the stage-driven distance/time buckets) as the LEFT list.
- Every existing **sort, filter, chip, and selection** keeps working on that left list.
- Add a **right-hand detail pane** (the v5 tabs: Job description · Match & score · Tailored CV ·
  Cover letter · More) that fills in when you click a job — replacing the need to leave the
  board for most tasks. The existing full `/analyze/[run_id]` page stays, reached via
  "Full analysis ↗".

## What exists today (reviewed)

| Piece | File | Keep? |
|---|---|---|
| Dashboard board (all profiles) | `app/(dashboard)/dashboard/page.tsx` → `JobBoard` | wrap |
| Profile board (one profile, homeAddress) | `app/(dashboard)/profiles/[id]/jobs/page.tsx` → `ProfileJobBoard` | wrap |
| Toolbar (filters/sort/search) | `features/jobs/components/SmartToolbar.tsx` | **untouched** |
| Distance strip | `features/jobs/components/DistanceRibbon.tsx` | **untouched** |
| Feed shell + grouping render | `features/jobs/components/SmartFeed.tsx` (`bucketJobs`) | extend |
| Filter/sort/group logic | `features/jobs/lib/jobFilters.ts` (`filterJobs`/`sortJobs`/`buildGroups`) | **untouched** |
| Cards | `features/jobs/components/FeedCards.tsx` (`JobCard`/`HeroCard`) | slim + make selectable |
| Bulk selection | `feedSelection.ts` + `BulkActionBar.tsx` + `SelectModeButton.tsx` | **untouched** |
| Full analysis (detail source of truth) | `app/(dashboard)/jobs/[id]/analyze/[run_id]/page.tsx` | keep as deep view |

Everything view-side is **URL-param driven** (`stage`/`triage`/`ats`/`sort`/`dir`/
`min_distance`/`max_distance`/`location`) via shallow History nav. The detail pane will add
**one new param `?job=<id>`** for the active/open job — independent of the bulk-select set.

## How existing behaviour is preserved

- **Sort / filter / chips**: unchanged. They already produce the `filtered`/`groups` arrays
  that feed `SmartFeed`. The left list renders exactly those, so all of it works verbatim.
- **Grouping**: `bucketJobs` / `buildGroups` untouched — the left column renders the same
  sections. Only the card width/shape adapts to the narrower column.
- **Bulk selection**: the checkbox multi-select + `BulkActionBar` stay as-is. The new
  "active job" is a *separate* single-value concept (`?job=`). Clicking a card **body** opens
  detail; clicking the **checkbox** (in select mode) toggles bulk-select — no collision.
- **Distance ribbon**: untouched, still click-to-scroll and range-slider driven.
- **Profile board**: shares `SmartFeed`, so it inherits the same treatment for free
  (verified: `ProfileJobBoard` renders the same `SmartFeed` + `SmartToolbar`).

## Phases

- **P0 · Data** — BFF route `GET /api/jobs/[id]/board-detail` returning the detail payload
  (latest run's jd_analysis / cv_jd_matching / ats / feasibility summary + cover letter +
  tailored-CV path + email draft + contact email). Reuses the analyze page's server queries.
- **P1 · Shell** — 2-column master-detail below the ribbon (list left, detail right) on wide
  screens; list-only on narrow with detail as a drawer/route. Add `?job=` active state.
- **P2 · Detail pane** — port the v5 tabs as a React component fed by the P0 payload,
  state-aware (which tabs exist per job). "Full analysis ↗" links to the existing page.
- **P3 · Left cards** — slim `JobCard` for the narrow column; clicking sets `?job=`; keep
  star / menu / analyze / full-analysis / progress affordances + selection.
- **P4 · Profile parity + responsive + polish**.
- **P5 · Verify in browser** — every filter, sort, chip, ribbon interaction, selection/bulk,
  active-job detail + tabs, on both dashboard and profile boards.

## Open decisions (need your call)

1. **Detail source** — right pane fetches a lean per-job payload on click (fast, keeps the
   list light) and "Full analysis ↗" still opens the exhaustive existing page. Agree?
2. **Narrow screens** — on mobile, detail opens as a full-screen drawer over the list
   (recommended) vs. navigating to a detail route. Which?
3. **Scope of this branch** — build the whole thing, or land P0–P2 first (shell + detail
   working on dashboard) and iterate?
