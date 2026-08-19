# Handoff — Job Board Master-Detail Redesign (finish the v5 implementation)

> **Archived 2026-08-19** — this redesign shipped (`BoardDetailPanel.tsx`,
> `MatchScoreTab.tsx`, `TailoredCvTab.tsx` etc. are live and wired into
> `SmartFeed.tsx`/`DetailHeader.tsx`, `6de05f90`). Moved here as a completed
> record; not maintained.

Paste everything below into a fresh session as the opening prompt.

---

## Objective

Bring the split **master-detail** layout from the prototype `job-board-mockup-v5.html`
(repo root) into the REAL job board, **exactly** matching v5. The top of the page
(filter toolbar + "DISTANCE FROM HOME" ribbon) stays as-is and full-width; **below the
ribbon** the page splits into a **left job list** (the existing grouped feed — "Closest to
you", "Needs attention", etc.) and a **right detail pane** (v5 tabs). Clicking a job on the
left fills the right pane.

`job-board-mockup-v5.html` is the **source of truth** for layout, per-case tab sets, tab
content, and copy. Open it in a browser and match it pixel-for-behaviour.

## Where things stand

- Branch: **`feat/board-detail-redesign`** (off `dev-5`). A first implementation is already
  committed-in-progress (working tree, not committed). It compiles: `npx tsc --noEmit` and
  `npm run lint` both pass from `frontend/web`.
- Dev server: `cd frontend/web && npm run dev` → localhost:3000. Requires login (the human
  must sign in; you cannot type the password).
- The plan doc is `docs/archive/board-detail-redesign-plan.md`.

## THE FOUR THINGS THAT ARE WRONG (fix these — they're why the current build was rejected)

### 1. Column proportions are backwards
v5 CSS is the spec:
- `.left  { width: 440px; min-width: 400px; }`  ← the LIST is the NARROW, fixed column.
- `.right { flex: 1; min-width: 540px; }`        ← the DETAIL is the WIDE, flexible column.

Current code did the opposite (list = `flex-1`, detail = `max-w-[560px]`). **Swap it:** left
list fixed ~440px, right detail flexible and wider. On the real dashboard the outer content
area is already fairly wide, so this should feel like v5.

### 2. The DISTANCE ribbon must stay full-width ABOVE the split
User: *"keep the distance board as it is and divide below of this."*

Right now `DistanceRibbon` renders inside `SmartFeedBody`, which now lives inside the LEFT
column — so the ribbon got squeezed into the narrow list column. **Hoist the ribbon out** so
the vertical order is:

```
[ SmartToolbar ]                        ← full width (unchanged)
[ DistanceRibbon ]                      ← full width (unchanged)
[ left list (440px) | right detail ]   ← the split starts HERE, below the ribbon
```

The ribbon's state (`range`, `setRange`, `distanceMax`, `ribbonMax=50`) currently lives in
`SmartFeedBody` — lift it up to the `SmartFeed` component level and render `<DistanceRibbon>`
between `<SmartToolbar>` and the flex split. Keep its click-to-scroll (`onJobClick`) and
range-slider behaviour intact.

### 3. Match & Score tab is wrong — rebuild it to match v5 EXACTLY
Two hard problems:

**(a) It contains a FORBIDDEN link.** The current `MatchScoreTab.tsx` renders
*"See full analysis for category breakdown, feasibility plan & honesty check →"*. The user
**explicitly** said in an earlier round: *"no need for separate button See full analysis for
category breakdown, feasibility plan & honesty check →"*. **DELETE that link entirely.**

**(b) It's missing the category breakdown table** and other v5 sections. The v5 Match &
Score tab, in this exact order, is:

1. **ATS number + "Overall match score"** at the top (big number, colour by band; e.g. `93`).
   NO sub-score tiles (keyword/experience/formatting) and NO "Weighted from…" caption — those
   were moved to the full analysis page per the user.
2. `**CV ↔ JD matching** — which JD requirements your CV already covers, and which are gaps.`
3. **Match breakdown by category** — a TABLE with columns `Category | Required | Preferred |
   Match rate`. One row per category using `category_labels` (e.g. "Care Skills 3✓/3 — 100%",
   "Soft Skills 3✓ 1✗/4 — 75%"), then a `Required total … 86%` row and a `Preferred total …
   —` row ("no preferred keywords in JD" when none). This is the piece that's completely
   missing today — port it from v5 (and it mirrors the real `CvJdMatchingCard.tsx` in
   `features/cv/analysis/`, whose per-category counting logic you can reuse).
4. **Matched keywords** — grouped by category (green chips).
5. **Missing keywords** — grouped by category (red chips).
6. **Credentials & eligibility** — "Present" (green ✓ chips) / "Missing" (dashed chips), with
   the subline "Matched against your CV and saved profile credentials."

For the **not-a-fit** case (score below the initial gate, no matching data), v5 shows the red
"analysis stopped after scoring" callout instead of the table — keep that branch.

### 4. Per-case tab sets must match v5 EXACTLY
The current build renders tabs off generic `hasScore/hasCv/hasLetter` flags, which is close
but must be verified case-by-case against v5. The v5 cases and their EXACT tab sets:

| v5 case | State | Tabs (in order) |
|---|---|---|
| job1 | Applied (score, CV, letter, no email on file) | Job description · Match & score · Tailored CV · Cover letter · More |
| job2 | Ready to apply (full success) | Job description · Match & score · Tailored CV · Cover letter · More |
| job3 | Below target, recovered by tailoring | Job description · Match & score · Tailored CV · Cover letter · More |
| job4 | Below target, **cover letter skipped** | Job description · Match & score · Tailored CV · More |
| job5 | **Not a fit** (stopped after scoring) | Job description · Match & score  ← ONLY TWO |
| job6 | Failed run | Job description  ← ONLY ONE |
| job7 | Not analysed (rich JD) | Job description  ← ONLY ONE |
| job8 | Needs JD (thin, <1000 chars) | Job description  ← ONLY ONE |
| job9 | Has a contact email on file → send-directly flow | Job description · Match & score · Tailored CV · Cover letter · More |

Rules that produce the above (derive from real data, not hardcoded):
- **Job description** — always.
- **Match & score** — whenever a completed run with a `match_score` exists (covers not-a-fit,
  which still has a score but no tailored CV/letter).
- **Tailored CV** — when `tailored_cv_storage_path` exists.
- **Cover letter** — when a non-stale cover letter with `pass_3_final` exists.
- **More** — when there's at least a tailored CV OR a cover letter (holds Downloads + Email).
- Failed / not-analysed / needs-JD → Job description only.

Also verify the **More tab** matches v5's final form: **Downloads first** (a single "Download
ZIP" when both CV+letter exist; a single "Download CV PDF" when only a CV), **then Email
message**. The Email section has two shapes: **has contact_email** → shows recipient + a
"Send email" button (+ "Change" to edit); **no contact_email** → "No contact email on file"
note + "+ Add email" inline input + the drafted message to Copy. (job9 is the has-email
example; jobs 1–3 are the no-email example.)

## What's already built (reuse / fix, don't rewrite from scratch)

New files under `frontend/web/src/`:
- `app/api/jobs/[id]/board-detail/route.ts` — lean GET returning `{ run, cover_letter }` for
  the pane (latest analysis_run's JSON blobs + the cover letter row). Ownership: job→profile→
  user. **This is fine — keep it.**
- `features/jobs/lib/boardDetailTypes.ts` — TS shapes for the run/cover payload. Keep.
- `features/jobs/lib/useBoardDetail.ts` — fetch-on-select hook with stale-response guard. Keep.
- `features/jobs/components/detail/`:
  - `BoardDetailPanel.tsx` — orchestrator (header + Tabs). **Fix tab conditions per case (#4).**
  - `DetailHeader.tsx` — compact header (title, meta, status chip, Full analysis ↗, primary
    action, ⋯). In-place analyse/re-analyse/apply/dismiss (no navigation away). Mostly OK.
  - `JobDescriptionTab.tsx` — badges + categorised required/preferred skills + credentials +
    responsibilities; falls back to raw JD for thin/unanalysed; failed-run banner. Verify vs v5.
  - `MatchScoreTab.tsx` — **REBUILD per #3** (currently wrong: has the forbidden link, missing
    the breakdown table).
  - `TailoredCvTab.tsx` — lift chip + View PDF + feasibility reword cards + `CvInlinePreview`.
    Verify vs v5.
  - `CoverLetterTab.tsx` — preview + View PDF (uses existing `/api/jobs/[id]/cover-letter/
    [letter_id]/download?format=pdf`). OK.
  - `MoreTab.tsx` — Downloads (ZIP via `lib/downloadZip.ts`) + Email (draft via
    `/api/applications/[letter_id]/email-draft`, send via `/send-email`, add-email via PATCH
    `/api/jobs/[id]`). Verify ordering + both email shapes vs v5 (#4).
  - `useTailoredCvPdfAction.ts` — client CV→PDF render (no letter_id needed), reuses
    `renderTailoredCvBlob` + markdownHelpers. Keep.

Modified files:
- `features/jobs/components/SmartFeed.tsx` — added the split layout + `?job=` active state.
  **This is where #1 (proportions) and #2 (ribbon placement) get fixed.**
- `features/jobs/components/FeedCards.tsx` — card body `onClick` opens `?job=` (or toggles
  bulk-select in select mode); title link `stopPropagation`; active-job ring. Keep.
- `features/jobs/components/feedSelection.ts` — added optional `onOpenDetail` + `activeJobId`
  to the selection context. Keep.

## Architecture / invariants to PRESERVE (do not regress)

- The toolbar (`SmartToolbar.tsx`), distance ribbon (`DistanceRibbon.tsx`), grouping
  (`bucketJobs` / `buildGroups`), filter/sort (`jobFilters.ts`), and bulk-selection
  (`feedSelection` + `BulkActionBar` + `SelectModeButton`) all stay working. They're URL-param
  driven (`stage/triage/ats/sort/dir/min_distance/max_distance/location`) via shallow History
  nav — untouched.
- The active detail job is a **separate** concept: a single `?job=<id>` URL param, independent
  of the bulk-select `Set`. Clicking a card body opens detail; clicking the checkbox (in
  select mode) toggles bulk-select.
- The existing full analysis page `/jobs/[id]/analyze/[run_id]` stays; "Full analysis ↗" in
  the detail header links to it (that page keeps the deep stuff: sub-scores, feasibility
  detail, honesty/structure checks).
- **Profile board parity is automatic**: `profiles/[id]/jobs/page.tsx` → `ProfileJobBoard`
  renders the same `SmartFeed`, so fixing SmartFeed fixes both. Verify the profile board too.
- This is a **customised Next.js 16** — see `frontend/web/AGENTS.md`. Check
  `node_modules/next/dist/docs/` before using unfamiliar Next APIs.

## How to verify (browser, per case)

Run the dev server, have the human log in, then walk the "AIN Sydney" profile (it has all the
states). For each of the 9 v5 cases: confirm the **exact tab set**, that **Match & score**
matches v5 (breakdown table present, NO "see full analysis" link, no sub-score tiles), the
**left column is ~440px and the detail is the wider column**, and the **distance ribbon spans
full width above the split**. Test filters/sorts/chips/selection still work with a detail pane
open. Then check the per-profile board (`/profiles/[id]/jobs`).

## Definition of done

1. Layout matches v5: full-width toolbar + ribbon, then a ~440px list | wider detail split.
2. Per-case tabs exactly match the table above (incl. not-a-fit = 2 tabs, failed/unanalysed/
   needs-JD = 1 tab).
3. Match & score = v5 structure (ATS number → CV↔JD intro → breakdown table → matched →
   missing → credentials), with the "see full analysis" link REMOVED and no sub-score tiles.
4. More tab = Downloads-first (single ZIP / single CV) then Email, both email shapes correct.
5. All existing filters/sorts/grouping/selection still work; profile board matches.
6. `npx tsc --noEmit` + `npm run lint` clean.
