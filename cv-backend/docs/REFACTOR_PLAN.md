# writers.py Refactor Plan

## Why

`writers.py` is 4858 lines. It mixes unrelated concerns:
- The production W8 writer (used by every analysis run)
- Legacy eval-only writers (W1, W2, W4, W8-critique)
- Deterministic post-processors (skill hygiene, body polish, awards)
- JD setting classifier + bridge
- Summary enforcement utilities
- Bullet rewrite utilities

Goal: split into focused modules **without changing any behaviour**. Every
phase is a pure structural move — no logic changes, no signature changes.

---

## Frozen interface — NEVER change these

These are the symbols that external files import from `writers.py`. They must
remain importable from `app.services.eval.writers` even after any phase.

```
# Production pipeline (HIGHEST PRIORITY — breaking these kills job analysis)
run_tailored_cv_w8_verified   ← orchestrator.py line 263
_NON_SKILL_EXACT              ← tailored_rescoring.py line 140
_NON_SKILL_PREFIXES           ← tailored_rescoring.py line 140
_is_non_skill_phrase          ← pipeline/steps/tailored_cv.py line 680
get_writer                    ← eval/runner.py line 32

# Test-imported symbols (breaking these fails 619 tests)
_classify_jd_setting                   ← test_jd_setting_classifier.py
_targeted_bullet_rewrites              ← test_targeted_bullet_rewrites.py
split_awards_and_certifications        ← test_sprint_a_awards_split.py
sort_experience_chronologically        ← test_sprint_b_experience.py
normalise_experience_tense             ← test_sprint_b_experience.py
_parse_role_date_range                 ← test_sprint_b_experience.py
_parse_month_year                      ← test_sprint_b_experience.py
_convert_bullet_tense                  ← test_sprint_b_experience.py
canonicalise_body_spelling             ← test_sprint_c_polish.py
normalise_heading_title_case           ← test_sprint_c_polish.py
normalise_date_formats                 ← test_sprint_c_polish.py
_title_case_phrase                     ← test_sprint_c_polish.py
_apply_body_spelling_subs              ← test_sprint_c_polish.py
enforce_summary_concreteness           ← test_sprint_e_summary.py
_extract_present_employers_from_experience ← test_sprint_e_summary.py
_extract_cv_named_tools_for_summary    ← test_sprint_e_summary.py
_s2_has_concrete_evidence              ← test_sprint_e_summary.py
_compose_concrete_s2                   ← test_sprint_e_summary.py
_surface_cv_named_tools                ← test_sprint_h_tool_placement.py
_move_misplaced_technical_skills       ← test_sprint_h_tool_placement.py
_is_non_skill_phrase                   ← test_skills_hygiene.py
_strip_non_skill_phrases               ← test_skills_hygiene.py
_relabel_awards_only_certifications    ← test_skills_hygiene.py
_normalise_awards_entries              ← test_skills_hygiene.py
ensure_awards                          ← test_skills_hygiene.py
_extract_original_credentials          ← test_skills_hygiene.py
_strip_ungrounded_credentials          ← test_skills_hygiene.py
_smartcase_skill                       ← test_skills_hygiene.py
_normalise_skills_case                 ← test_skills_hygiene.py
_canonicalise_skill_spelling           ← test_skills_hygiene.py
_dedupe_skills_across_lines            ← test_skills_hygiene.py
_inject_approved_skills                ← test_skills_hygiene.py
_drop_subsumed_generic_skills          ← test_skills_hygiene.py
_approved_skill_entries                ← test_skills_hygiene.py
_tidy_skill_qualifiers                 ← test_skills_hygiene.py + test_phase15_regressions.py
_format_award_entry                    ← test_phase15_regressions.py
```

**Rule:** After every phase, every symbol above must still be importable from
`app.services.eval.writers`. The pattern is: move the definition to a new
module, then add `from .new_module import symbol` in writers.py. All external
callers continue working unchanged.

---

## Pre-flight facts (confirmed by audit, do not re-check)

- `_ROLE_CATEGORY_LABELS` is **NOT defined in writers.py** — it is imported
  from `app.services.eval.enforce` at line 55. Do NOT include it in any move.
  writers.py re-exports it for users of `writers`; enforce.py is its home.

- All Phase 4 symbols (body polish, experience tense, tool placement) are
  **defined in writers.py**, NOT in enforce_w3.py. Phase 4 is real work, not
  a no-op.

- `_targeted_bullet_rewrites` is defined in writers.py (~line 4385) and used
  inside `_writer_w8_verified`. It is imported by one test. Move it in Phase 5
  alongside summary utilities (it uses the same client pattern).

- `_kw_norm` (~line 4380) is a tiny helper used only by `_targeted_bullet_rewrites`.
  Move it together with `_targeted_bullet_rewrites` in Phase 5.

---

## What MUST NOT be touched (at all, in any phase)

- `app/services/pipeline/orchestrator.py`
- `app/services/pipeline/steps/` (any file)
- Worker code (`worker/src/`)
- Web frontend (`web/src/`)
- Database models / migrations
- Any Supabase queries
- Test files — they must pass unchanged; never edit a test to make a phase pass

---

## Phase status tracker

| Phase | Status | Commit | Deployed |
|-------|--------|--------|----------|
| Phase 0 — Audit (this doc) | ✅ Done | — | — |
| Phase 1 — JD Setting Bridge | ⬜ Pending | — | — |
| Phase 2 — Skill Hygiene | ⬜ Pending | — | — |
| Phase 3 — Awards & Credentials | ⬜ Pending | — | — |
| Phase 4 — Body Polish | ⬜ Pending | — | — |
| Phase 5 — Summary + Bullet Utilities | ⬜ Pending | — | — |
| Phase 6 — Eval-only Writers | ⬜ Pending | — | — |

---

## Phase 1 — Extract JD Setting Bridge

**New file:** `cv-backend/app/services/eval/summary_bridge.py`

**Move these definitions out of writers.py (lines ~3898–4139):**
```python
_SETTING_HOME
_SETTING_HOSPITAL
_SETTING_NDIS
_SETTING_LIFESTYLE
_SETTING_THEATRE
_SETTING_RESIDENTIAL
_SETTING_BRIDGES
_S1_RESIDENTIAL_RE
_CANNED_SUMMARY_RE
_HIGHLIGHT_HEADINGS_SET
_classify_jd_setting()
_build_jd_setting_block()
_strip_canned_summary_phrase()
_apply_setting_bridge()
```

**In writers.py, replace definitions with:**
```python
from app.services.eval.summary_bridge import (
    _SETTING_HOME, _SETTING_HOSPITAL, _SETTING_NDIS,
    _SETTING_LIFESTYLE, _SETTING_THEATRE, _SETTING_RESIDENTIAL,
    _SETTING_BRIDGES, _S1_RESIDENTIAL_RE, _CANNED_SUMMARY_RE,
    _HIGHLIGHT_HEADINGS_SET,
    _classify_jd_setting, _build_jd_setting_block,
    _strip_canned_summary_phrase, _apply_setting_bridge,
)
```

**Why this is safe:** All of these are only used inside `writers.py` itself
(in `_writer_w8_integrated` and `_writer_w8_verified`), except
`_classify_jd_setting` which is imported by one test. Re-exporting it from
writers.py keeps that test working unchanged.

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
# Must show: 619 passed, 0 failed
python3 -c "from app.services.eval.writers import _classify_jd_setting; print('OK')"
python3 -c "from app.services.eval.summary_bridge import _classify_jd_setting; print('OK')"
```

---

## Phase 2 — Extract Skill Hygiene

**New file:** `cv-backend/app/services/eval/skill_hygiene.py`

**Move these out of writers.py (lines ~1962–2566 and ~2265–2565):**
```python
_NON_SKILL_EXACT           (large set constant, ~line 1962)
_NON_SKILL_PREFIXES        (tuple constant, ~line 2063)
_NON_SKILL_PATTERN         (compiled re, ~line 2080 — internal, but move with the above)
_is_non_skill_phrase()
_tidy_skill_qualifiers()
_strip_non_skill_phrases()
_smartcase_atom()          (internal helper for _smartcase_skill)
_smartcase_skill()
_normalise_skills_case()
_canonicalise_skill_spelling()
_norm_item()               (internal helper for _inject_approved_skills)
_dedupe_skills_across_lines()
_inject_approved_skills()
_drop_subsumed_generic_skills()
_approved_skill_entries()
```

**Do NOT move:** `_ROLE_CATEGORY_LABELS` — it is imported FROM enforce.py, not
defined in writers.py. Leave that import line in writers.py unchanged.

**In writers.py:** replace all moved definitions with:
```python
from app.services.eval.skill_hygiene import (
    _NON_SKILL_EXACT, _NON_SKILL_PREFIXES, _NON_SKILL_PATTERN,
    _is_non_skill_phrase, _tidy_skill_qualifiers,
    _strip_non_skill_phrases, _smartcase_atom, _smartcase_skill,
    _normalise_skills_case, _canonicalise_skill_spelling,
    _norm_item, _dedupe_skills_across_lines, _inject_approved_skills,
    _drop_subsumed_generic_skills, _approved_skill_entries,
)
```

**Critical pipeline re-exports — these MUST remain importable from writers.py:**
- `_NON_SKILL_EXACT` → tailored_rescoring.py
- `_NON_SKILL_PREFIXES` → tailored_rescoring.py
- `_is_non_skill_phrase` → pipeline/steps/tailored_cv.py

The re-export from writers.py (the import line above) satisfies all three.

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
# Must show: 619 passed, 0 failed
python3 -c "
from app.services.eval.writers import _NON_SKILL_EXACT, _NON_SKILL_PREFIXES, _is_non_skill_phrase
from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
from app.services.pipeline.steps.tailored_cv import build_tailored_cv
print('Pipeline skill imports OK')
"
```

---

## Phase 3 — Extract Awards & Credentials

**New file:** `cv-backend/app/services/eval/awards_credentials.py`

**Move these out of writers.py (lines ~2567–3703):**
```python
_is_valid_date()
_add_desc_sentence()
_parse_award_parts()
_strip_duplicate_trailing_word()
_strip_au_location()
_format_award_entry()
_format_award_bullet()
_classify_entry_line()
_looks_like_location()
_split_award_name_org()
_parse_award_raw_entry()
_is_description_only_entry()
_normalise_awards_entries()
_relabel_awards_only_certifications()
_entry_is_award()
_entry_is_cert()
_registration_section_text()
_credential_already_in_registration()
split_awards_and_certifications()
_drop_sections_by_ranges()
_is_cred_heading()
_cv_heading_word()
_extract_original_credentials()
_awards_section_text()
ensure_awards()
_strip_ungrounded_credentials()
```

**In writers.py:** replace with imports from `awards_credentials`. All
test-visible symbols must remain re-exported:
```python
from app.services.eval.awards_credentials import (
    _format_award_entry, _normalise_awards_entries,
    _relabel_awards_only_certifications, split_awards_and_certifications,
    _extract_original_credentials, ensure_awards, _strip_ungrounded_credentials,
    # ... all other moved symbols
)
```

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
python3 -c "
from app.services.eval.writers import (
    split_awards_and_certifications, _format_award_entry,
    _relabel_awards_only_certifications, _normalise_awards_entries,
    ensure_awards, _extract_original_credentials, _strip_ungrounded_credentials,
)
print('Awards/credentials imports OK')
"
```

---

## Phase 4 — Extract Body Polish

**Confirmed by audit:** All Phase 4 symbols are defined in writers.py.
This is real work — not a no-op.

**New file:** `cv-backend/app/services/eval/body_polish.py`

**Move these out of writers.py (lines ~506–1900, mixed in with experience/polish):**
```python
# Experience tense + sorting
_parse_month_year()
_parse_role_date_range()
_is_present_role()
_find_experience_section()
_split_into_entries()
_find_role_line()
sort_experience_chronologically()
_strip_trailing_blank()
_convert_bullet_tense()
normalise_experience_tense()

# Spelling + heading polish
_case_preserve_replace()
canonicalise_body_spelling()
_apply_body_spelling_subs()
_title_case_token()
_title_case_phrase()
normalise_heading_title_case()
normalise_date_formats()

# Tool placement
_matched_surface_terms()    (internal helper)
_line_starts_label()        (internal helper)
_surface_matched_skills()   (internal helper)
_surface_cv_named_tools()
_move_misplaced_technical_skills()
```

**In writers.py:** replace all with imports from `body_polish`. All
test-visible symbols must remain re-exported.

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
python3 -c "
from app.services.eval.writers import (
    sort_experience_chronologically, normalise_experience_tense,
    _parse_role_date_range, _parse_month_year, _convert_bullet_tense,
    canonicalise_body_spelling, normalise_heading_title_case,
    normalise_date_formats, _title_case_phrase, _apply_body_spelling_subs,
    _surface_cv_named_tools, _move_misplaced_technical_skills,
)
print('Body polish imports OK')
"
```

---

## Phase 5 — Extract Summary + Bullet Utilities

**New file:** `cv-backend/app/services/eval/summary_utils.py`

**Move these out of writers.py (lines ~1638–1960 and ~4380–4572):**
```python
# Summary utilities (~lines 1638–1960)
_find_summary_section()
_extract_summary_prose()
_extract_present_employers_from_experience()
_extract_cv_named_tools_for_summary()
_distinctive_employer_tokens()
_s2_has_concrete_evidence()
_compose_concrete_s2()
enforce_summary_concreteness()
_log_tailoring_report()     (can stay in writers.py if tightly coupled — judge on context)

# Bullet rewrite utilities (~lines 4380–4572)
_kw_norm()
_targeted_bullet_rewrites()
```

**Note on `_targeted_bullet_rewrites`:** This function takes an `AIClient` and
is async. It is only called from `_writer_w8_verified`. Moving it to
`summary_utils.py` is clean because that module will import `AIClient`. If the
circular-import risk feels high (summary_utils ← writers ← summary_utils),
keep `_targeted_bullet_rewrites` in writers.py and move only the pure
summary helpers.

**In writers.py:** replace with imports from `summary_utils`.

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
python3 -c "
from app.services.eval.writers import (
    enforce_summary_concreteness,
    _extract_present_employers_from_experience,
    _extract_cv_named_tools_for_summary,
    _s2_has_concrete_evidence, _compose_concrete_s2,
    _targeted_bullet_rewrites,
)
print('Summary/bullet imports OK')
"
```

---

## Phase 6 — Separate Eval-only Writers

**This is the largest and riskiest phase. Do last.**

**New file:** `cv-backend/app/services/eval/writer_variants_eval.py`

**Move writer functions that are NOT used by production:**
```python
_writer_w1_current()  and  run_w1()
_writer_w2_general()  and  run_w2()
_writer_w4_chat()     and  run_w4()
_writer_w3_composition()   (legacy)
_writer_w5_surfacing()     (legacy)
_writer_w6_general()       (legacy)
_writer_w7_converged()     (legacy)
_writer_w8_critique()  /  run_w8_critique()
_postprocess()             (called by legacy writers only — verify before moving)
_run_upstream()            (called by legacy writers only — verify before moving)
_inject_keyword_set()      (called by legacy writers only — verify before moving)
```

**Keep in writers.py (production path):**
```python
WriterResult                   (dataclass — keep here or move to a shared types file)
get_writer()                   (must import from writer_variants_eval for the legacy variants)
run_tailored_cv_w8_verified()
_writer_w8_integrated()
_writer_w8_verified()
```

**Approach for `get_writer()`:** Keep `get_writer()` in writers.py. Import the
legacy writer functions from `writer_variants_eval` so the registry continues
to work. Do not move `get_writer()` itself — `runner.py` imports it from
writers.py and must stay unchanged.

**Why riskiest:** If any legacy writer calls a symbol that was moved in an
earlier phase but the import wasn't threaded through correctly, eval runs will
fail silently. Run the full eval harness (`runner.py`) on a real CV/JD pair
after this phase, not just tests.

**Validation:**
```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
python3 -c "
from app.services.eval.writers import get_writer, run_tailored_cv_w8_verified
from app.services.eval.runner import run_eval
print('Eval runner imports OK')
"
# Also: trigger one real eval run via the API to confirm w1/w2/w4 still work
```

---

## Validation checklist (run after EVERY phase)

```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend

# 1. All tests pass
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
# Expected: 619 passed (or more), 0 failed

# 2. ALL frozen symbols still importable from writers.py
python3 -c "
from app.services.eval.writers import (
    # Production pipeline
    run_tailored_cv_w8_verified,
    _NON_SKILL_EXACT, _NON_SKILL_PREFIXES,
    _is_non_skill_phrase,
    get_writer,
    # JD setting bridge
    _classify_jd_setting,
    _targeted_bullet_rewrites,
    # Awards / credentials
    split_awards_and_certifications,
    _relabel_awards_only_certifications,
    _normalise_awards_entries,
    ensure_awards,
    _extract_original_credentials,
    _strip_ungrounded_credentials,
    _format_award_entry,
    # Experience / body polish
    sort_experience_chronologically,
    normalise_experience_tense,
    _parse_role_date_range,
    _parse_month_year,
    _convert_bullet_tense,
    canonicalise_body_spelling,
    normalise_heading_title_case,
    normalise_date_formats,
    _title_case_phrase,
    _apply_body_spelling_subs,
    _surface_cv_named_tools,
    _move_misplaced_technical_skills,
    # Summary utilities
    enforce_summary_concreteness,
    _extract_present_employers_from_experience,
    _extract_cv_named_tools_for_summary,
    _s2_has_concrete_evidence,
    _compose_concrete_s2,
    # Skill hygiene
    _strip_non_skill_phrases,
    _smartcase_skill,
    _normalise_skills_case,
    _canonicalise_skill_spelling,
    _dedupe_skills_across_lines,
    _inject_approved_skills,
    _drop_subsumed_generic_skills,
    _approved_skill_entries,
    _tidy_skill_qualifiers,
)
print('All frozen symbols OK')
"

# 3. Pipeline imports intact
python3 -c "
from app.services.pipeline.orchestrator import run_analysis_pipeline
from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
from app.services.pipeline.steps.tailored_cv import build_tailored_cv
from app.services.eval.runner import run_eval
print('All pipeline + eval runner imports OK')
"
```

---

## Session instructions for the executing agent

Read this file at the start of the session. Check the phase status table.
Confirm the previous phase's commit is present in git log before proceeding.

**Per-phase workflow:**
1. Read this file and identify the current pending phase.
2. Grep every symbol in the "move" list to confirm their exact line numbers
   before touching anything. Never assume line numbers from this doc are current.
3. Create the new module file with the moved definitions.
4. Replace the definitions in writers.py with the import block.
5. Run the validation checklist. If anything fails — `git checkout -- .` and
   report. Do NOT fix forward.
6. Commit with message: `refactor: phase N — extract <module name>`
7. Update this file: mark phase ✅, record commit hash.
8. Stop. Do not start the next phase in the same session.

**Do not deploy after a refactor phase** — these are structural-only changes
with zero behaviour change. The next production deploy will pick them up.

---

## After each phase: update this file

Mark the phase as ✅ in the status table and record the commit hash.
Update `graph.json` `_meta.updated` field.

---

## Guiding principle

> If tests fail after a phase, **REVERT immediately** (`git checkout -- .`)
> and report which symbol caused the failure. Do not try to fix forward.
> A failed refactor phase is worse than no refactor.
