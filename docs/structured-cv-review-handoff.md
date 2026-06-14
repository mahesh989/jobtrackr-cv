# Structured CV Review — handoff for next session

> **STATUS: IMPLEMENTED on branch `feat/structured-cv-review-v2`,
> [PR #2](https://github.com/mahesh989/jobtrackr-cv/pull/2) (open as of
> 2026-06-14). Backend deployed to fly. Awaiting merge to `main`.**
>
> See `.claude/graph.json → architecture.structured_cv_review_form` for the
> live shape, key files, and behaviour notes. The narrative below is kept
> for historical context.

This is a **complete instruction set** for picking up the structured-CV /
review-form feature in a new session. The previous attempt was rolled back
from `main` (preserved on branch `feat/structured-cv-review`); migrations
058 + 059 are applied on Supabase. Start fresh from `main`, cherry-pick
sparingly, and follow this plan.

## Mission

A **post-upload review form** that normalises every uploaded CV into the
same skeleton — same sections, same heading labels, same date format,
same conventions — so that when 1000s of CVs pass through the analysis
pipeline, the input variance is removed at the source. The form is
**rearrangement, not rewriting**. The candidate's own words stay verbatim.

> *"we are not changing much things in the original cv, we are just
> rearranging, replacing to make the input consistent so that ai will
> always gives the correct output no matter what kind of cv is used."*

> *"we already have cv_text after uploading cv, we can make use of that."*

## What's different from the previous attempt

Three explicit changes the user clarified after the rollback:

### 1. NO contact section in the review form

The form must not show / extract / edit contact details. Contact info comes
from the user's existing profile (`user_preferences.contact_details`) via
the existing `stamp_contact_line()` mechanism in the renderer. **The
structurize prompt should NOT emit a `contact` block.** Drop that field
from the structured CV schema entirely.

### 2. Add an Awards section (we missed it)

The previous form had no Awards/Recognition section. Rashmi's CV has a
"Recognition" block ("Staff Excellence Award, The Jesmond Group …
August 2025") that ended up mis-routed to Certifications. Awards belong in
their own section, between Education and Certifications.

### 3. Skills are REUSED from upload — not a second call

The previous attempt folded skill extraction into the single structurize AI
call. Skill count regressed from ~28-32 (Rashmi via the dedicated
`categoriseCv` prompt) to ~16. The user wants the existing
`categoriseCv()` call **kept as-is** at upload time; the structurize call
returns structure only (no skills). The review form reads skills from
`cv_versions.categorised_skills` — the column that already exists.

> *"earlier we used to have 28-32 skills for rashmi cv, now in the last
> analysis i got 16, or so. Why? no need to apply different logic to extract
> skill. please go back how we did it. then re use in the form for skills."*

## End-to-end data flow

```
1. Upload PDF/DOCX
   → Supabase Storage (direct upload, never Vercel)
   → cv-backend /internal/extract-cv-text → cv_text (raw extracted text)

2. Two PARALLEL AI calls at upload time (this is the proven path):
   a) /internal/categorise-cv → categorised_skills
        {technical[], soft_skills[], domain_knowledge[]}
        ~28-32 entries for Rashmi (uses CV_SKILL_CATEGORISATION_SYSTEM
        with explicit breadth caps).
   b) /internal/structurize-cv → structured_cv (NEW — no contact block)
        {summary, experience[], education[], awards[],
         certifications[], references[], gaps[], _version}

3. INSERT cv_versions row:
     cv_text                TEXT
     categorised_skills     JSONB  (from call 2a)
     structured_cv          JSONB  (from call 2b)
     structured_cv_status   TEXT   ('parsed')
     normalized_cv_text     TEXT   (rendered canonical markdown)

4. Forced redirect → /dashboard/cv/[id]/review

5. User edits in the form. Every change → 10-second debounced autosave:
     PATCH /api/cv/[id]/structured
       body: { structured_cv, verified? }
   Backend re-renders normalized_cv_text from the edited structured_cv
   (PURE function — no AI call) via cv-backend /internal/render-canonical-cv.
   Persists both structured_cv and normalized_cv_text.
   Skills edits in the form: PATCH ALSO updates categorised_skills so
   the two columns stay aligned.

6. "Save & use this CV" → PATCH with verified=true → status='verified' →
   collapse every section on the page (no redirect; user stays).

7. Later, user clicks Analyse on a job:
     analyze route reads cv_versions.normalized_cv_text first,
     falls back to cv_text only when normalized_cv_text is null.
     That tidy markdown flows through every pipeline step.
```

## Bucketing rules (no change from the v1 attempt)

| Rule | Behaviour |
|---|---|
| **Care VET quals → Education** | Cert III/IV in Ageing Support / Individual Support / Disability / Community Services / health → land under Education, not Certifications. Carry a `_moved_from_certifications` flag for a UI badge. |
| **Certifications conditional** | Hidden when empty (after Cert IV moves out). |
| **Awards section** | NEW. Between Education and Certifications. Shape: `{name, issuer, location, date, description}`. |
| **Section order in render** | Skills → Summary → Experience → Education → Awards → Certifications → References. (Contact line stamped at top by `stamp_contact_line()` from user profile.) |
| **References collapsed by default** | Everything else expanded by default. |
| **Dates verbatim or blank** | Never inferred. Source "Completed 2021" → stored as "Completed 2021". No dates in source → "" (empty) + amber "missing — add or leave blank" flag in UI. |
| **Bullets verbatim, prefix stripped** | Leading `•/-/*/·` stripped (the renderer adds `- `). Line-wrapped bullets merged via the continuation-detector that already exists on the branch. |
| **No vertical filtering** | All roles kept. All bullets kept. The form is pure rearrangement; no analysis-time decisions leak into the form. |

## Architecture — concrete plan

### Backend changes

1. **`backend/api/app/services/ai/prompts/cv_structurization.py`**
   - Remove the `contact` block from the JSON schema in
     `CV_STRUCTURIZATION_SYSTEM`.
   - Remove the `skills` block (already pulled per the previous handoff —
     the categoriseCv call returns them separately).
   - **Add** an `awards` block:
     ```json
     "awards": [
       {
         "name":        "",
         "issuer":      "",
         "location":    "",
         "date":        "",
         "description": ""
       }
     ]
     ```
   - Add a CLASSIFICATION RULE: "An award / recognition / commendation /
     scholarship / honour → awards, NOT certifications. Examples:
     'Staff Excellence Award', 'Dean's List', 'Employee of the Month'."

2. **`backend/api/app/services/cv/cv_structurizer.py`**
   - `normalise_structured_cv()` — drop the contact normalisation; add
     `_normalise_award()`; carry `awards` through the same pattern as
     experience/education.
   - Bump `STRUCTURED_CV_VERSION = 2` (or whatever the next integer is —
     it's a marker for the silent-refresh path on review-page load).
   - Keep the care-VET-→-education router.
   - Keep `_merge_split_bullets()`.
   - Keep `_strip_bullet_prefix()`.

3. **`backend/api/app/services/cv/cv_renderer.py`**
   - Drop contact-line rendering (the orchestrator's `stamp_contact_line()`
     already adds it from user profile).
   - Add an `## Awards` section block between Education and Certifications.
   - Award line format: `- {Name} · {Issuer} ({Date})` followed by the
     description on the next line if present.

4. **`backend/api/app/routes/internal/cv.py`**
   - `/internal/structurize-cv` → unchanged path; response shape stays
     `{ structured_cv, normalized_cv_text }`.
   - `/internal/render-canonical-cv` → unchanged; PURE function, no AI.

### Frontend changes

5. **`frontend/web/src/app/api/cv/route.ts`** (upload)
   - Keep `categoriseCv()` call. **Important: do not delete it.**
   - Add `structurizeCv()` call alongside. Both calls run; results land
     in different columns.
   - INSERT row with both `categorised_skills` AND `structured_cv` +
     `structured_cv_status='parsed'` + `normalized_cv_text`.
   - Return `redirect_to: /dashboard/cv/{id}/review` so the upload
     handler navigates the user to the review form.

6. **`frontend/web/src/app/api/cv/[id]/structurize/route.ts`** (on-demand)
   - For existing CVs that don't have `structured_cv` yet. Also runs both
     calls (or only structurize if `categorised_skills` is already
     populated).

7. **`frontend/web/src/app/api/cv/[id]/structured/route.ts`**
   - PATCH handler accepts the edited structured_cv.
   - Re-renders normalized_cv_text via `/internal/render-canonical-cv`.
   - Persists structured_cv + normalized_cv_text.
   - **Also writes categorised_skills** from
     `structured_cv.skills_mirror` (see the form section below) so the
     two columns stay synced.

8. **`frontend/web/src/app/(dashboard)/dashboard/cv/[id]/review/page.tsx`**
   - Server component. Load cv_versions row (id + label + structured_cv +
     structured_cv_status + categorised_skills + cv_text).
   - **Stale-version check**: if `structured_cv._version < STRUCTURED_CV_VERSION`,
     silently POST `/api/cv/[id]/structurize` once before rendering. No
     button, no confirmation.
   - Pass categorised_skills as a separate prop to the client.

9. **`frontend/web/src/components/cv/CvReviewClient.tsx`**
   - **REMOVE the Contact section entirely.** No `contact` state, no
     contact card.
   - **ADD an Awards section** (collapsible, default expanded). Same shape
     as Education: row with Name / Issuer / Location / Date + description
     textarea below. + Add / × remove buttons.
   - Skills section reads from a NEW prop `initialCategorisedSkills`
     (which the page passes in). The form treats this as `doc.skills` for
     UI editing. On every change → mirror into `structured_cv.skills_mirror`
     before PATCH so the backend can sync both columns.
   - Keep section order: Skills → Summary → Experience → Education →
     **Awards** → Certifications & licences → References (collapsed).
   - Keep "Save & use this CV" → on-page collapse, no redirect.

### Database

- Migrations 058 (`structured_cv`, `structured_cv_status`) and 059
  (`normalized_cv_text`) are **already applied** on Supabase. No new
  migration needed unless you decide awards needs a dedicated column.
- Awards live INSIDE structured_cv JSONB. No new column.

## What NOT to do (anti-patterns from the v1 attempt)

- ❌ **Don't extract or edit contact in the form.** Profile is the source
  of truth.
- ❌ **Don't fold skills into the structurize prompt.** Keep the dedicated
  `categoriseCv` call. The form reads `categorised_skills`.
- ❌ **Don't add a "Re-parse from original" button.** Use the silent
  version-refresh on page load instead.
- ❌ **Don't add UI for a quality-flags banner that's amber-themed.**
  Match the dashboard theme — `var(--border)`, `text-text`,
  `bg-[var(--brand)]`. Only the alert icon stays tinted.
- ❌ **Don't fabricate dates to "pad" missing ones.** Empty stays empty.
  Show an amber "missing" hint and let the user choose.
- ❌ **Don't filter / drop / re-rank roles or bullets in the form.** The
  form is rearrangement only. Vertical filtering and bullet density are
  analysis-time concerns and stay in honesty_guard / composer.

## Where the previous attempt lives

`feat/structured-cv-review` branch on origin. Useful commits to
cherry-pick (but adapt each per the three clarifications above):

| Commit | Purpose |
|---|---|
| `9332ed6` | Phase 1: schema + structurizer + gap detection |
| `1408261` | Phase 2: renderer + autosave PATCH + pipeline rewire |
| `8944be7` | Theme-matched UI + collapsibles |
| `f03c36b` | Review button on existing CV rows |
| `279dff1` | Bullet merger + neutral theme |
| `612a2a3` | Restore categoriseCv skills + silent version refresh |

The `612a2a3` commit is the closest to the v2 intent — it already restores
`categoriseCv`, adds `_version`, removes the reparse button. Start from
that commit's changes and layer in: drop contact, add awards.

## Test plan

1. Backend pytest:
   ```
   cd backend/api && ./.venv/bin/python3.12 -m pytest
       tests/test_cv_structurizer.py tests/test_cv_renderer.py -q
   ```
   Update tests that asserted `contact` in the structured shape; add tests
   for the awards block + the care-VET rule.

2. Web typecheck:
   ```
   cd frontend/web && npx tsc --noEmit
   ```

3. fly deploy backend.

4. Manual on Vercel preview:
   - Upload Rashmi's CV → land directly on `/dashboard/cv/{id}/review`.
   - Verify: no Contact section · Skills section shows ~28-32 chips
     (matches the pre-rollback behaviour) · Awards section present and
     populated with "Staff Excellence Award" · Cert IV in Ageing Support
     under Education with the "moved here" badge.
   - Edit a bullet, wait 10s — Saved badge fires. Reload — change persists.
   - Click "Save & use this CV" — sections collapse on the page; no redirect.
   - Analyse a JD → the tailored CV's input is the verified normalized_cv_text.

5. Re-run the audit harness (`backend/api/scripts/audit_40.py`) against
   Shanti + Rashmi to confirm honesty_guard still passes 100% on the
   normalized inputs.

## Reminder — what's already on main right now

- `honesty_guard` (date / years / setting / skills-label guards)
- ATS thresholds 40/65 for healthcare
- Quality flags badge on analysis page
- Google account picker fix
- **Credential lexicon + cv_jd_matching sidecar + composer credential-claim
  guard + summary word-floor flag** (just shipped this session)

None of that gets undone by adding the structured-CV review form back.
They're complementary: the review form makes the input consistent; the
honesty_guard fixes drift after composition.
