# Next-session handoff — review form: two real fixes

Branch: `feat/structured-cv-review` · last commit `a2539d9` (Vercel preview live, fly.io backend deployed, migrations 058+059 applied).

The review form at `/dashboard/cv/[id]/review` works end-to-end (load → edit → 10s autosave → "Save & use" → analyze route reads `normalized_cv_text`). Two specific things the user wants fixed. **Both fixes are minimal — do not re-architect.**

---

## Fix 1 — Skills regressed: 28–32 → ~16

### Why it broke
This session folded skill categorisation **into** the single structurize AI call (to save one API call). The new `CV_STRUCTURIZATION_SYSTEM` prompt's `skills` block has no breadth incentive — no caps, no rules — so the model returns a thin set.

The previous, proven path was a **dedicated** `categoriseCv` call using `CV_SKILL_CATEGORISATION_SYSTEM`, which has:
- Explicit caps: `technical` up to 30, `soft_skills` up to 15, `domain_knowledge` up to 20
- Explicit "extract EVERY skill, dedupe, lowercase, canonical short names" rules

That prompt was returning 28–32 skills for Rashmi before this branch existed. **Restore that exact call.**

### The fix (minimal)

**Don't touch `cv_skill_categorisation.py` or `skill_categoriser.py`** — they still exist on this branch, untouched. Re-wire to use them again.

1. **`backend/api/app/services/ai/prompts/cv_structurization.py`** — strip the skills concern out of the structurize prompt:
   - Remove the `"skills": { ... }` object from the JSON SCHEMA block (the prompt continues to extract contact / summary / experience / education / certifications / references — that's its only job now).
   - Remove the skills bullet in CLASSIFICATION RULES ("Skills: extract from … Lowercase, de-duplicated …").

2. **`backend/api/app/services/cv/cv_structurizer.py`**:
   - Leave `_normalise_skills_from_ai()` in place — it now just returns `{}` when the AI omits the block, which is fine.
   - Skills in `structured_cv.skills` will come from `categorised_skills`, populated by the caller (web layer). The structurizer itself stays skills-agnostic.

3. **`frontend/web/src/app/api/cv/route.ts`** (upload handler):
   - Restore the `categoriseCv()` call that was deleted on this branch. Look at `git log -p main -- frontend/web/src/app/api/cv/route.ts` for the exact code; it was a try/catch with a model retry — copy it back verbatim.
   - After `structurizeCv()` returns, **merge** `categorised` into the structured CV before persisting:
     ```ts
     const merged = { ...result.structured_cv, skills: categorised ?? result.structured_cv.skills };
     ```
   - Persist `structured_cv: merged` and `categorised_skills: categorised` (both columns; sources of truth stay in sync).
   - Re-render canonical text from the merged version (call `renderCanonicalCv({ structured_cv: merged })` so `normalized_cv_text` includes the full skill list).

4. **`frontend/web/src/app/api/cv/[id]/structurize/route.ts`** (on-demand structurize for existing CVs):
   - Same change: call `categoriseCv` alongside `structurizeCv`, merge, persist, re-render.
   - Slightly more code than the upload path but it's the same logic; lift it into a small `runStructurizeAndCategorise(cv_text, …)` helper if you want.

5. **`frontend/web/src/app/api/cv/[id]/structured/route.ts`** (PATCH for autosave):
   - When the user edits skills in the form, the PATCH already updates `structured_cv` wholesale. Also update `categorised_skills` from `structured_cv.skills` on every PATCH so the two columns stay aligned.
   - Already calls `renderCanonicalCv` — no change needed there.

6. **`frontend/web/src/components/cv/CvReviewClient.tsx`** — no skill UI changes. The form already reads from `doc.skills` (the structured CV); that field now carries the full categoriseCv output, so it'll show 28–32 chips automatically.

**Cost trade:** back to 2 AI calls at upload (structurize + categorise). The user has accepted this: "no need to apply different logic to extract skill. please go back how we did it."

---

## Fix 2 — Kill the "Re-parse from original" button; refresh stale data automatically

User: *"no need for reparse, please find a way to fix it."* They explicitly want the button gone. The trigger for re-parse is stale data from before fixes landed (e.g. bullet-split CVs structurized before the merger shipped).

### The fix (minimal)

**A tiny version marker — no new migration, no new UI, no heuristics.**

1. **`backend/api/app/services/cv/cv_structurizer.py`** — add a module constant + emit it in the structured CV:
   ```python
   STRUCTURED_CV_VERSION = 2   # bump whenever parser logic changes

   def normalise_structured_cv(raw):
       ...
       structured["_version"] = STRUCTURED_CV_VERSION
       structured["gaps"] = detect_gaps(structured)
       return structured
   ```
   The `_version` field rides inside the existing `structured_cv` JSONB — no migration.

2. **`frontend/web/src/app/(dashboard)/dashboard/cv/[id]/review/page.tsx`** (server component):
   - Before rendering, check `(cv.structured_cv?._version ?? 0) < STRUCTURED_CV_VERSION`.
   - If stale: call `POST /api/cv/[id]/structurize` once (the endpoint already exists), then re-fetch.
   - Then render with the fresh data.
   - User sees a one-time ~3s delay on the first load after a version bump. No button.

3. **`frontend/web/src/components/cv/CvReviewClient.tsx`** — **REVERT the reparse changes from commit `a2539d9`**:
   - Delete `reparse()`, `reparsing` useState, "Re-parse from original" button, and shrink the save bar back to its previous shape.
   - Easiest: `git revert a2539d9` then re-apply any non-reparse bits if needed.

**What this means for the existing Rashmi case:** when she opens her review form, server-side sees `_version` missing (old parse), silently calls structurize via her saved `cv_text`, gets the merged bullets + full skills list, then renders. Nothing for her to click.

**Where to expose the constant to the frontend:** simplest is hard-code `STRUCTURED_CV_VERSION = 2` in `frontend/web/src/lib/cvBackend.ts` (mirror of the Python value). Bump both whenever the parser logic changes. They're a tiny pair to keep in sync.

---

## Files that must change (full list, minimal diff each)

| File | Change |
|---|---|
| `backend/api/app/services/ai/prompts/cv_structurization.py` | Drop the `skills` schema block + CLASSIFICATION line |
| `backend/api/app/services/cv/cv_structurizer.py` | Add `STRUCTURED_CV_VERSION`; emit `_version` in result |
| `frontend/web/src/app/api/cv/route.ts` | Restore `categoriseCv` call; merge into structured_cv before persist + render |
| `frontend/web/src/app/api/cv/[id]/structurize/route.ts` | Same merge as upload route |
| `frontend/web/src/app/api/cv/[id]/structured/route.ts` | PATCH writes `categorised_skills` from `structured_cv.skills` to keep both columns aligned |
| `frontend/web/src/app/(dashboard)/dashboard/cv/[id]/review/page.tsx` | Stale-version check → call `structurize` → re-fetch |
| `frontend/web/src/components/cv/CvReviewClient.tsx` | Revert `a2539d9` (remove reparse button + state) |
| `frontend/web/src/lib/cvBackend.ts` | Add `STRUCTURED_CV_VERSION = 2` constant |

**No new SQL migrations.** The `_version` lives inside the existing `structured_cv` JSONB.

---

## What NOT to do

- ❌ Don't re-architect skills extraction. The old `categoriseCv` path **already works**; just re-enable the call.
- ❌ Don't add a UI re-parse button or any user-visible "refresh" control.
- ❌ Don't add new SQL columns. `_version` rides inside `structured_cv`.
- ❌ Don't touch the canonical renderer (`cv_renderer.py`) or the analyze route's `normalized_cv_text` preference. Those are working.
- ❌ Don't add heuristics like "if a bullet starts lowercase, re-parse". The deterministic merger already exists in the structurizer; the version check is the trigger to re-run it.

---

## Test plan

1. Backend pytest from `backend/api`:
   ```
   ./.venv/bin/python3.12 -m pytest tests/test_cv_structurizer.py tests/test_cv_renderer.py -q
   ```
   Update the structurizer tests that assert `skills` shape — the structurize call no longer returns skills. Test that `_version` is emitted.

2. Web typecheck: `cd frontend/web && npx tsc --noEmit`.

3. Manual on Vercel preview:
   - Open Rashmi's CV review page directly. Server-side stale check fires → structurize re-runs → bullets are merged + skills jump back to ~28–32. No button visible.
   - Edit a skill, save. Reload → still present.
   - Run an analyse on a JD → tailored CV should include the broader skills set.

4. Push branch + `fly deploy` from `backend/api`.

---

## Context user gave verbatim (worth re-reading)

> *"no need for reparse, please find a way to fix it. no need to make the code heavy, we already have cv_text after uploading cv, we can make use of that."*
>
> *"earlier we used to have 28-32 skills for rashmi cv, now in the last analysis i got 16, or so. Why? no need to apply different logic to extract skill. please go back how we did it. then re use in the form for skills."*
>
> *"then make use of cv_text to extract contents of the cv."*

That last line is the key insight you should design around: **`cv_text` is persisted on upload and never changes.** Every refresh of `structured_cv` and `categorised_skills` reads from that source. No re-upload, no PDF re-parse, just AI calls against existing text. That's why the silent version-bump refresh works.
