# writers.py decomposition — plan & protocol

Decomposing the 5,145-line `app/services/eval/writers.py` monolith into a
package, **strictly behaviour-preserving**, one test-gated increment at a time.

## The contract (non-negotiable)
- **`./.venv/bin/pytest -q` must report `826 passed` after every increment.**
  If it doesn't, revert that increment (`git checkout -- <files>`) and re-analyse.
- **No logic changes.** Only move code and re-wire imports. Moved code is verbatim
  (pre-existing style quirks, e.g. compact `if x: y`, are preserved — not "fixed").

## Structure (done)
- `writers/_impl.py` — the implementation (shrinking as groups are extracted).
- `writers/__init__.py` — barrel; programmatically re-exports **every** name
  (public + `_private`) from `_impl`, so all ~50 symbols the app + tests import
  keep resolving. As groups move out, `_impl` re-imports them, so the barrel
  stays complete automatically.

## The extraction pattern (proven on `awards_parsing`)
For a cohesive group G:
1. **Analyse deps.** List G's functions/constants. Find every writers-internal
   symbol G calls that is NOT defined in G (the "external back-refs"):
   `sed -n 'A,Bp' _impl.py | grep -oE '\b_[a-z][a-z0-9_]+\(' | sort -u` minus G's own names.
2. **Move** the contiguous block to `writers/<g>.py` (verbatim) with a minimal
   header (`from __future__ import annotations` + the stdlib it uses).
3. **Break cycles:** for each external back-ref, replace the call with a
   **lazy import inside the function** (`from app.services.eval.writers._impl import X`).
   Never import `_impl` at `<g>.py` top level.
4. **Re-import in `_impl`:** replace the moved block with an explicit
   `from app.services.eval.writers.<g> import (…all moved names…)` so `_impl`'s
   remaining code + the tests still see them unqualified.
5. **Gate:** `pytest -q` → must be `826`. Commit. Move to the next group.

## Candidate modules (from dependency analysis; order = fewest back-refs first)
- ✅ `awards_parsing` — DONE (1 back-ref: `_canonicalise_skill_spelling`).
- `_structure` / `_md` — **do this next.** The shared experience/markdown parsing
  helpers (`_find_experience_section`, `_find_role_line`, `_is_present_role`,
  `_split_into_entries`, `_strip_trailing_blank`, …). These are the BASE that
  dates/summary/awards-highlevel all depend on — extracting them first makes the
  topic modules acyclic (topic → `_structure` → stdlib).
- `dates_tense` — `_parse_month_year`, `_parse_role_date_range`,
  `normalise_date_formats`, `sort_experience_chronologically`,
  `normalise_experience_tense`, `_convert_bullet_tense` (depends on `_structure`).
- `spelling_case` — `canonicalise_body_spelling`, `_apply_body_spelling_subs`,
  `_smartcase_skill`, `_canonicalise_skill_spelling`, `_title_case_phrase`
  (scattered 1397–2558; pure string transforms, small helper cluster).
- `skills_section` — `_NON_SKILL_*`, `_is_non_skill_phrase`, `_strip_non_skill_phrases`,
  `_normalise_skills_case`, `_dedupe_skills_across_lines`, … (skills hygiene/case).
- `bridges` — `_classify_jd_setting`, `_apply_setting_bridge`, the `_CV_*_MARKERS_RE`,
  `_cv_has_*_experience` gates, `_SETTING_*`, `_BRIDGE_EVIDENCE_GATES`.
- `summary` — `_compose_concrete_s2`, `_s2_has_concrete_evidence`,
  `enforce_summary_concreteness`, `_extract_*_for_summary`, … (depends on several above).
- `awards_highlevel` — `ensure_awards`, `split_awards_and_certifications`,
  `_normalise_awards_entries`, `_relabel_awards_only_certifications` (uses `awards_parsing`).
- Leave the W8 orchestration entrypoints (`run_tailored_cv_w8_verified`, `get_writer`,
  the registry class) in `_impl` as the package "core" until last.

## Watch-outs
- Constants can reference functions (e.g. `_BRIDGE_EVIDENCE_GATES = {…: _cv_has_*}`)
  — keep such a constant in the SAME module as the functions it references.
- The test-suite imports ~49 internals directly; the barrel's programmatic
  re-export covers them, but if you ever switch the barrel to explicit lists,
  regenerate from: grep `from app.services.eval.writers import` across `app/` + `tests/`.
