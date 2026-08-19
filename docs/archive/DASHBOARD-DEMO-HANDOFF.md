# JobTrackr Dashboard Demo — Handoff Report

> **HISTORICAL — this handoff is complete and its target file no longer exists.**
> The work described here shipped in commit `6de05f90` ("feat(web): dashboard
> job-board redesign to match demo prototype"), and `user-dashboard-demo.html`
> was deleted on 2026-08-19 because its mock CV pane carried a real user's name,
> mobile number and email in a public repo. Kept only as a record of the design
> rationale; do not go looking for the demo file. The live implementation in
> `frontend/web` is the reference now.

**Target file (deleted):** `user-dashboard-demo.html` (repo root) — 2,127 lines, standalone clickable replica of the JobTrackr user dashboard (no build step; open in browser).
**Goal (done):** implement the validated design decisions into `frontend/web` (dashboard + job board).

---

## 1. What the demo is today

A single-file HTML + CSS + JS replica of the **/dashboard** page and its job board. It mirrors the "Default" theme tokens from `frontend/web/src/app/globals.css` (GitHub-style palette: `--brand #0969DA`, `--surface #FFF`, `--bg #F6F8FA`, `--border #D0D7DE`, system fonts). Demo-only mechanics (no backend): 16 mock JOBS, simulated analysis run, toast/popover/modal helpers.

### Page structure (top → bottom)

1. **Sidebar** (dark GitHub palette) — nav (Dashboard, Saved Views, Favourite, Applied, Analyses, Personalisation), user block, resizable via drag handle.
2. **Summary row** — pipeline donut (sourcing/analysis/applied, clickable legend slices → lens modal), stat cards.
3. **Tabs row** — `All | Not analysed | Analysed | Archive` + divider + `⭐ Ready | 📍 Close` (count badges).
4. **Filter bar** (new — see §2.4).
5. **Board** — job cards grouped into sections ("Closest to you", "Fresh today", "Needs attention", "Everything else", "Already applied") unless a filter/tab is active (then a flat card list).
6. **Detail pane** — job detail, score card (Initial → Tailored → ATS gate), action buttons, modal add-JD flow.
7. **Full-analysis pane** (one mock job, `full:true`) — tabbed: Match & score / Tailored CV / Cover letter / Email / Report.

### Job card (current canonical design — validated, user-approved)

```
┌──────────────────────────────────────────────────────────────┐
│  Senior Frontend Engineer  ☆                       (gauge)  │
│  Canva  ·  Sydney NSW · Full-time · Posted 4h ago           │
│  $170k–$195k                                                │
│  [● LinkedIn]  [● Ready to apply]           [Analyse] [⧉][⋯] │
└──────────────────────────────────────────────────────────────┘
```

- **No logo/monogram slot** (removed — see §3.5). Title line starts at the left edge.
- Title (16px/600) + star toggle (18px) on one line; company + meta line (13px); salary (14px); right-aligned 74px score gauge showing `score` + "from initial" (or "— /no score"); footer: source pill (colored dot + source name), state chip (colored dot + state label), spacer, action button, then 2 icon buttons (open listing + ⋯ menu).
- Card: `border:1px solid var(--border)`, radius 12px, `padding: 27px 18px`, `gap:14px` between cards.
- Applied cards: green left border. Selected card: brand ring.

---

## 2. Changes made in this session (most recent first — implement ALL)

### 2.1 Slide-over choreography (detail pane)
- **True slide-over:** the pane glides in on a long decel curve — `cubic-bezier(0.22, 1, 0.36, 1)` at 320ms — and content staggers up in waves (head, then body blocks at ~50ms intervals) instead of appearing all at once.
- **Focus dimming:** opening a job dims every other card to **35% opacity**; the selected card keeps its brand ring and reads as the only "live" surface (`body.pane-open .section-cards .card:not(.selected)`).
- **Soft scrim:** a subtle dark wash (`rgba(13,17,23,.14)`, 240ms fade) covers the page behind the pane — clicking it dismisses.
- **Keyboard navigation:** `←` / `→` steps through the **currently filtered board** (`state.visibleIds`; wraps around; works even with the pane closed); `Esc` still closes the pane + any modal.
- **Auto-scroll:** the selected card scrolls into view (`scrollIntoView({ behavior:"smooth", block:"nearest" })`) so the board stays in sync behind the pane.
- **Empty state:** the pane is no longer a blank slab on load — a "No job selected" placeholder shows the `←` `→` keyboard hint (re-appears ~340ms after close unless reopened).
- **Scroll-lock body class:** `body.pane-open` is set/cleared with the pane — the real app can hook it for analytics and a11y (announce pane to screen readers, `aria-hidden` the board behind it).

### 2.2 Card typography + sizing (final approved numbers)
- **+1px fonts inside the job box:** title 15→16px, meta/company 12→13px (explicit px, not `--t-label`), salary 13→14px, source pill 11→12px, state chips 12→13px (dot 6→7px), card buttons 12.5→13.5px, star 17→18px, gauge score font 17→18px, drop-down icon-btns 14→15px.
- **Card 15% taller:** `padding: 16px 18px` → `27px 18px`; footer margin-top 8→10px.
- **Card spacing +15%:** `.section-cards` gap 12px → **14px**.

### 2.3 Filter UI — REPLACED (was: "Filter results" card with 4 collapsible `<details>` sections + native `<select>`)
New: **one compact filter-bar card** below the tabs row:

```
┌────────────────────────────────────────────────────────────────┐
│ [ 🔍 Location or company…              ]  Sort: Date posted ▾  │
│ DATE [Any][24h][3d][7d]  ATS [70+][50–69][<50]  JD [Full][Thin] │
└────────────────────────────────────────────────────────────────┘
```

- **Sort** = pill button showing the active option → opens a **popover** (reuses existing `.popover` + `.pop-item` w/ `.radio` selected state) listing 5 options: Date posted / Date added / ATS score / Distance / Recently analysed.
- **Facets** = segmented pill groups (`Date / ATS / JD`), each with live counts, single-select + "Any" reset. Active segment = brand-tinted (bg `color-mix(brand 10%)`) + bold.
- **✕ Clear filters** appears in the top row only when a filter is active.
- Implementation notes: state changed from multi-select `atsSet/jdSet` to single-value-outcome Sets (`atsF/jdF`) with toggle-clearing `applyAts/applyJd`; date filter `applyDate(v)`; lens-slice handlers on the dashboard donut still set Sets directly (works). Empty state text: "Adjust the filters above…".

### 2.4 Gauge score semantics (from earlier iteration — still in)
- Gauge is the **only** score display in the card. Removed: "ATS 48 → 66" text + "+N lift" chip next to gauge; "✓ Applied" duplicate chip in card footer; ATS stat tile in full-analysis pane header (score now shown only in "Match & score" tab).
- Gauge rings: track `--border-muted`, initial-score arc (text-3, 40% opacity), current score arc colored by threshold (≥70 success / ≥50 warning / else danger; applied jobs always success). Label under score: `from {initial}`.

### 2.5 Tabs use full cards
Favourite / Applied views render the **same gauge cards** as the main feed (was: flat rows with a small "Tailored N/100" box). Flat row markup retained in code but unused.

### 2.6 Monogram logo REMOVED
- The renderer referenced `job.mono` which **never existed** in JOBS data → every logo square rendered empty (a live bug).
- Decision after review: **no company icon at all** — cards start with the title text. Rationale in §3.5. `job.mono`/`monogram()` helper and `.spot-logo` CSS deleted.

### 2.7 Misc polish
- Section-head `border-bottom` divider removed (headings separated by whitespace only).
- Card action button suppressed for applied jobs (no stale action button; footer shows applied chip + icons only).
- **Card ⋯ menu** = popover with *Open listing / Add JD (if not full) / Favourite toggle / Dismiss from feed* — this is the only dismiss path; Archive tab depends on it.
- **Popover bug fixed:** outside-click now ignores clicks *inside* the popover (previously any mousedown removed the node before `click`, so menu/sort items never fired).

### 2.8 Audit cleanup (dead code removed)
- JS: `cardMenu` was re-wired (see 2.6) — NOT dead; removed unused `hasFilter` var, unused `totalRow`, unused `ICONS.spark`/`ICONS.stop`.
- CSS: removed `.card-top`, `.card-actions`, `.card-menu-btn`, `.lift-chip`, `.btn.ghost-brand` (×2), `.detail-actions`, `.pop-group-title`, `.chip.sm`, `.stack-bar`, `.stack-legend`.
- `clearFilters()` now guards a missing search input (no crash outside dashboard view).
- `renderFlatRow` intentionally retained (unused; documented). `initResizer` is a self-invoking IIFE (sidebar drag-resize works).

---

## 3. Iteration history (what was tried and REJECTED — do not re-suggest)

1. **Colored "spotlight" card tints** — rejected (too much color). Then "feature-card" gradients — rejected.
2. **Card variant experiments** (A–E compact/hero/strip/flat/panel; then spec/meter/ticket/signal/cover) — all rejected.
3. **Three mixed archetypes** (editorial borderless rows / premium rounded w/ big title+score / split information-rail with 150px MATCH panel) — user rejected all; restored the gauge baseline card.
4. **Filter UI**: old 3-row toolbar (many chips + sort popover) → replaced by the reference-style collapsible panel → **replaced again by the segmented bar (§2.2)** which the user now accepts.
5. **Logo alternatives** (hash-color monogram, role/vertical icons, source-brand tints, profile monogram, state icons) — user reviewed 9 options, chose **none**; logo slot removed. Wait — it was removed only as "not liking any option", a future real-logo source (e.g. Clearbit) could re-add it.

---

## 4. Implementation guidance for the real project

- **Design tokens:** card sizes are now hard numbers in the demo — in the app, express as Tailwind classes (`text-[16px]`, `py-[27px] gap-[14px]` etc.) or CSS vars; keep the same relative scale.
- **Component mapping:**
  - Job card → `frontend/web/src/features/dashboard` JobTable/board card component (check `features/jobs/components` and `components`). Apply: gauge-only score, +1px sizes, 27px vertical padding, no logo column, applied-card green border, no redundant chips.
  - Filter bar → the board filter UI (`JobFilterBar` per docs/build_log). New pattern: sort popover button + 3 segmented groups with counts + Clear-filters. Single-select semantics per facet.
  - Tabs (`All/Not analysed/Analysed/Archive` + Ready/Close) already exist in the real app as board filters — verify visual parity (count badges).
- **Behavioral rules to preserve:** gauge triple-state (score / initial arc / "from N"); "any active filter ⇒ tabs' Ready/Close state clears" (`applyTab`/`applySavedView` cooperativeness); empty state messages per tab.
- **Do NOT touch:** backend, DB schema (no new tables needed), auth. This is pure UI work in `frontend/web`.

---

## 5. Files

- ~~`user-dashboard-demo.html`~~ — the demo (deleted 2026-08-19, see the note at the top).
- `DASHBOARD-DESIGN-BRIEF.md` — the design principles brief (keep).
- `frontend/web/src/app/globals.css` — token source of truth (reference only, never edited).