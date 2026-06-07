# Next Session Instructions — JobTrackr CV Backend

## Read first

- `project_jobtrackr_cv_eval.md` in Claude memory — full architecture, invariants, deploy notes
- This file — specific tasks for this session

---

## Current production state

**Branch:** `main`  
**Latest commit:** `50cf99b`  
**Production:** Fly.io `jobtrackr-cv-api` v230, 619 tests passing  
**Uncommitted changes:** none

---

## Commit and deploy workflow

Always follow this order:

```bash
# 1. Run tests BEFORE committing — must pass
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
# Must show: 587 passed (or more), 0 failed

# 2. Commit (from repo root)
cd /Users/mahesh/Documents/Github/jobtrackr-cv
git add <specific files — never git add -A>
git commit -m "fix(scope): <description>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

# 3. Deploy backend
cd cv-backend
fly deploy -a jobtrackr-cv-api
# Wait for "Machine is now in a good state"

# 4. Push
cd ..
git push origin main
```

**After every deploy — tell the user:**
- New Fly version number from deploy output
- What changed
- Which jobs to re-analyse for verification

---

## What was completed (v223–v227)

### Cross-vertical lexicon + rerouter — DONE, deployed v223–v227

**v223 (`6f1a326`) — lexicon gaps:**
- `_universal_noise.json`: +credential (own transport, full drivers licence, must have own car), +eligibility (australian permanent resident), +noise (passion for technology/coding/cleaning/data, fast/quick learner, results-driven, hardworking, strong work ethic, self-motivated, works well under pressure, presentable appearance, police clearance required, ability to obtain police clearance)
- `tech.json`: +24 domain_knowledge entries (OOP, functional programming, full-stack/backend/frontend dev, test automation, unit/integration testing, version control, cybersecurity, data analysis/science, business intelligence, API development, cloud computing, RPA, software engineering, penetration testing, load testing)

**v224 (`ec715c6`) — rerouter bugs:**
- DROP BUG fixed: `covered_cats` guard falls back to `src_cat` when `tgt_cat` not covered (domain_knowledge items no longer silently dropped for tech).
- DUPLICATE BUG fixed: `rendered_cats` set prevents bucket being rendered twice when two labels share same `_label_cat` result.
- +77 regression tests (571 total).

**v225 (`cb45404`) — NDIS false positive + canonical synonym dedup:**
- `_classify_jd_setting` regex strips NDIS credential phrases before keyword check — "NDIS Workers Check" in a residential JD no longer triggers NDIS bridge.
- `seen_canonicals` set in `reroute_skills_by_lexicon` — first item claiming a lexicon canonical wins; later synonyms dropped ("Mobility Assistance" + "Mobility Support" → only one kept).
- New test file `tests/test_jd_setting_classifier.py` (10 tests covering Bolton Clarke regression + NDIS real cases + other settings).

**v226 (`84d2b78`) — work-rights eligibility noise:**
- Added 5 work-rights-compliance variants to `_universal_noise.json` eligibility section: "australian work rights compliance", "australian work rights and compliance", "work rights compliance", "work rights requirements", "right to work requirements".

**v227 (`c57ab89`) — police-check compound phrases + safe-mobility nursing variant:**
- Added 6 compound police-check/NDIS-check phrases to `_universal_noise.json` credential section.
- Added 5 safe-mobility variants to `mobility support` canonical in `nursing.json`: "safe mobility and transfers", "safe resident mobility and transfers", "safe mobility and transfer assistance", "resident mobility and transfers", "self-care needs and mobility".

### Anglicare real-run fixes — DONE, deployed v228–v230

**v228 (`ffec789`) — role-category label filter + targeted bullet rewrites:**
- `_ROLE_CATEGORY_LABELS` frozenset in `enforce.py` (aged care, home care, community
  care, disability support, independent living support, domestic assistance + variants).
  These are job-type/sector descriptors — filtered from the Skills section in BOTH
  `reroute_skills_by_lexicon` (enforce.py) and `_approved_skill_entries` (writers.py).
  They belong in narrative (bullets/summary), never Skills. Note: 'elderly care' →
  canonical 'aged care' → now excluded too.
- `_targeted_bullet_rewrites` async pass in writers.py: for inject_as_extension
  keywords the composition LLM missed, runs focused per-bullet LLM calls. Wired into
  `_writer_w8_verified` after `enforce_summary_concreteness`.

**v229 (`20d2ca3`) — collision-proof targeted bullet rewrites:**
- BUG: two keywords with identical evidence resolved to the SAME bullet; concurrent
  rewrite calls clobbered each other → neither landed (Anglicare: only 2 of 4 extensions
  applied). FIX: group missed keywords by target bullet → ONE LLM call per bullet
  incorporating ALL its keywords. Broadened bullet detection to ("- ", "* ", "• ").
  Verify each keyword actually landed; keep rewrite only if ≥1 landed, else preserve
  original. Verbose logging of missed set + per-bullet outcome.

**v230 (`50cf99b`) — work-rights labels + gate GitHub/Website to tech CVs:**
- `build_credentials_line` (contact_line.py): "Citizen"→"Citizenship", "PR"→"PR",
  "Visa with work rights"+hours→"Work Rights (Full Time/Part Time)", visa w/o hours→
  bare "Work Rights" (no more "Work Rights (Visa with work rights)").
- `stamp_contact_line`/`_build_contact_parts`: new optional `role_family_id` param.
  GitHub/Portfolio/Website now show ONLY for `_DEV_LINK_FAMILIES = {tech, master}`;
  suppressed for nursing/manual/cleaning/general. LinkedIn always shows. Threaded
  `role_family.id` into the two w8 production call sites (writers.py 4197, 4714).
  Default None = show all (backward compat for eval/legacy paths).

**Known limitation flagged (not yet actioned):**
- Skills line is honest but NOT JD-relevance-ordered. Off-axis residential skills
  (infection control, manual handling) surface on home-care JDs that don't ask for
  them, earning 0 ATS while occupying slots. A JD-relevance ordering pass on the
  Care Skills line is the proposed fix — deferred (it's a ranking design choice with
  an honesty/breadth trade-off, not a bug).
- Honesty watch: "supporting retirement living residents" — candidate works in
  residential aged care / nursing homes, not retirement living. Feasibility gate
  approved it as inject_as_extension; v229 will now inject it into a bullet. If it
  reads as an overclaim, tune the feasibility honesty gate (separate concern).

---

## Primary next task

### Phase 3A real-run validation — tech + cleaning UI verification (STILL PENDING)

Run a **tech JD** and a **cleaning JD** through the production web dashboard and inspect the Skills section output.

**What to look for in Tech CV:**
- No noise phrases ("passion for technology", "fast learner") in Technical Skills
- OOP, CI/CD, agile: NOT dropped, NOT duplicated — they should appear exactly once
- Soft skills (teamwork, communication) on Soft Skills line, not Technical Skills
- No items duplicated across "Technical Skills" and "Other Skills" lines

**What to look for in Cleaning CV:**
- "passion for cleaning", "own transport", "presentable appearance" not in Core Skills
- Steam cleaning / floor care on Core Skills (domain_knowledge)
- Equipment (floor scrubber, polisher) on Other Skills (technical)
- No items appearing on multiple lines

**Note:** `pytest -k "eval"` collects 0 tests — those live-run eval tests don't exist yet.
The deterministic regression tests (587) cover the pipeline; real-run validation is manual UI only.

---

## Architecture invariants (never break these)

1. **Lexicon wins over deny-list**: if phrase is in lexicon as domain_knowledge, remove it from `_NON_SKILL_EXACT`
2. **`reroute_skills_by_lexicon`** must be wired into all 3 writer paths (w8_integrated + both post-verify blocks)
3. **`_inject_approved_skills` ordering**: `enforce_skills_section` FIRST → inject AFTER → no enforce after inject
4. **`run_tailored_cv_w8_verified`** must pass `vertical` derived from `jd_analysis["role_family"]` — never `vertical=None`
5. **619 tests must pass** before every commit (`--ignore=tests/test_pdf_adaptive.py`)
6. **Career Highlights deterministic passes run order** (in `_writer_w8_verified`): verify_claims → many deterministic passes → `_strip_canned_summary_phrase` → `_apply_setting_bridge` → `enforce_summary_concreteness` → final skills passes. **Never reorder these — each depends on the previous being complete**
7. **`_classify_jd_setting` precedence**: Theatre → Lifestyle → HOME → NDIS → Hospital → Residential. HOME before NDIS is intentional — home-care JDs incidentally mention 'disability' as client type. NDIS credential phrases are stripped before the keyword check (regex in writers.py).
8. **`seen_canonicals` dedup in rerouter**: first item claiming a lexicon canonical wins. Raw-text dedup (`seen` set) still runs first to handle exact duplicates before lexicon lookup.

---

## Key files reference

| File | Purpose |
|------|---------|
| `cv-backend/app/services/eval/writers.py` | W8 writer, all deterministic gates, JD setting classifier + bridge |
| `cv-backend/app/services/eval/enforce.py` | `reroute_skills_by_lexicon`, `enforce_skills_section` |
| `cv-backend/app/services/ai/prompts/tailored_cv.py` | TAILORED_CV_SYSTEM prompt + Career Highlights rules |
| `cv-backend/app/services/ai/prompts/variants/composition.py` | COMPOSITION_USER_TEMPLATE (W8 user prompt) |
| `cv-backend/app/services/skills/lexicons/nursing.json` | Nursing skill canonicals + variants |
| `cv-backend/app/services/skills/lexicons/tech.json` | Tech skill canonicals + variants (24 domain_knowledge entries added v223) |
| `cv-backend/app/services/skills/lexicons/_universal_noise.json` | Cross-vertical noise/credential/eligibility |
| `cv-backend/app/services/pipeline/steps/cv_jd_matching.py` | CV-JD matcher + credential promotion (Sprint L) |
| `cv-backend/tests/test_jd_setting_classifier.py` | JD setting classifier regressions (Bolton Clarke + NDIS real cases) |
| `web/src/app/(dashboard)/dashboard/beta/summary-audit/` | Career Highlights audit beta page |
| `web/src/app/(dashboard)/dashboard/beta/skills-audit/` | Skills Other-Skills audit beta page |
