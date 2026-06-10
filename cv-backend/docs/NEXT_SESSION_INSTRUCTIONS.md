# NEXT SESSION — Deep dive on categorisation, summary composition, feasibility & injection

**Updated:** 2026-06-10 (post-deploy: 6fca5e3, 8c79922, 1336734, 21667b6)

User's brief for this session: **"I would like to analyse how categorization works on cv, jd, how profile summary written, how keywords feasibility works and injected, would like to improve all these."**

Read this entire doc before changing code. Don't ship until you understand the existing flow.

---

## 0. State of the world after today (2026-06-10)

**Last 4 commits deployed to `jobtrackr-cv-api`:**

| Commit | What it shipped |
|---|---|
| `6fca5e3` | Lexicon: NDISWC abbreviation + `flexibility for X shifts` family added to credential/noise. |
| `8c79922` | `enrich_required_skills_from_jd_body()` in `skills/post_process.py` — scans JD body against vertical-lexicon `domain_knowledge` canonicals; surfaces care skills the LLM missed. Wired into orchestrator BEFORE `post_process_jd_analysis`. |
| `1336734` | Three summary honesty gates in `eval/writers.py`: `_tools_attributable_to_employer` (S2 must not falsely attribute tools across employers); `_cv_has_hospital_experience` gate on `_apply_setting_bridge` (no HOSPITAL bridge unless CV evidences acute work); `_classify_jd_setting` weak/strong signal tiers (corporate-boilerplate "acute care" can't promote residential AIN to HOSPITAL). |
| `21667b6` | Three pattern recognisers in `skills/post_process.py`: `_split_conditional_phrase` + demoter (`X or willing to apply` → preferred); `_looks_like_language` (route languages to `technical`, not `domain_knowledge`); `_is_au_unit_code` (HLTHPS007/CHCCCS015 → credential sidecar). |

**Verify before changing anything else:** re-analyse Rashmi's Australian Unity AIN job. Expected after redeploy:
- Care Skills bucket non-empty (personal care, aged care, emotional support …)
- Required Other Skills bucket empty (ndiswc demoted + stripped)
- Preferred Care Skills no longer contains languages (they moved to Other Skills)
- S1: no "and acute clinical settings" appended
- S2: no "Currently delivering care at Uniting using BESTMed and MedMobile" (will be "Recent experience at Uniting." or similar)
- Overall ATS: ~85–92 (up from 69)

If anything above isn't right, fix that BEFORE doing the deep-dive work.

---

## 1. JD analysis — categorisation flow

### Where it happens

```
orchestrator.py
  ├── run_jd_analysis()                       # AI extract, IT-centric prompt
  ├── resolve_role_family()                   # nursing/tech/manual/master
  ├── enrich_required_skills_from_jd_body()   # NEW today — lexicon JD-body scan
  └── post_process_jd_analysis()              # lexicon re-classify + dedupe + sidecar
```

### Files

| Concern | File |
|---|---|
| JD analysis system prompt | `cv-backend/app/services/ai/prompts/jd_analysis.py` (UNCHANGED — IT-centric, only domain_knowledge examples are GDPR/data warehouse/IFRS/agile) |
| JD analysis runner | `cv-backend/app/services/pipeline/steps/jd_analysis.py` |
| Role-family resolver | `cv-backend/app/services/eval/role_families.py` (`resolve_role_family`, `category_labels`, `category_order`) |
| Lexicon classifier | `cv-backend/app/services/skills/classifier.py` (`classify`, `normalise`, `is_noise`) |
| Lexicon post-process | `cv-backend/app/services/skills/post_process.py` (`post_process_skills`, `post_process_jd_analysis`, the three new recognisers, the new JD-body scan) |
| Lexicons | `cv-backend/app/services/skills/lexicons/{_universal_noise,nursing,tech,cleaning}.json` |
| Orchestrator wiring | `cv-backend/app/services/pipeline/orchestrator.py:155-217` |

### Known weaknesses to investigate (improvement candidates)

1. **The JD analysis prompt is generic.** Domain-knowledge examples are all SaaS/IT. Today we patched around this with the JD-body lexicon scan, but the AI still mis-buckets things at extraction. Options:
   - Vertical-aware prompt variant (when family resolved BEFORE the AI call — requires a pre-pass to detect family from title/text)
   - Stronger structured constraints in the existing prompt (force the AI to extract from `RESPONSIBILITIES` field, with examples)
   - Two-pass: first pass extracts raw phrases, second pass categorises with vertical context
2. **Equivalence table is small.** `rf.equivalences` in `role_families.py` powers `promote_matched_equivalents`. Likely undersized for nursing — review what real JDs ask for vs what candidates write.
3. **Unknown-phrase fallback is silent.** `sidecar.unknown` entries stay in their LLM bucket and never grow the lexicon. We have `/dashboard/beta/skills-audit` for monitoring but no auto-suggestion loop.
4. **No JD-body scan for `soft_skills` or `technical` canonicals.** The new scan only fires on `domain_knowledge`. A JD that says "must be comfortable with electronic medication systems" doesn't get BESTMed-class technical surfaced.

### Diagnostic commands

```bash
# See what the AI extracts vs what the post-processor produces.
# Add at orchestrator.py:181 (after run_jd_analysis returns):
logger.info("RAW JD analysis: %s", jd_analysis)

# After enrichment + post-process, log the sidecar:
logger.info("Lexicon meta: %s", jd_analysis.get("lexicon_meta"))
```

---

## 2. CV analysis — categorisation flow

### Where it happens

CV skills are categorised at **upload time** (separate from JD analysis), then re-used at every run.

| File | Role |
|---|---|
| `cv-backend/app/services/cv/skill_categoriser.py` | AI categoriser (per-CV, one-time, cached on `cv_versions.skill_categories`) |
| `cv-backend/app/services/ai/prompts/cv_skill_categorisation.py` | Categoriser system prompt (HAS nursing/care examples — unlike JD) |
| `cv-backend/app/services/skills/post_process.py:post_process_cv_skills` | Universal-noise filter ONLY (no vertical lexicon — CV-side vertical is unknown at upload time) |

### Known weaknesses

1. **CV-side categorisation never gets the vertical lexicon's re-bucketing.** Comment in `post_process_cv_skills` says: *"current symptom of the bug is on the JD side"*. That assumption is overdue for re-evaluation — Rashmi's nursing CV may be carrying mis-bucketed items the JD-side rerouter then has to fix.
2. **Cached categories never refresh.** When the lexicon grows (we added 100s of entries this week), existing CVs don't pick up the new classifications until re-uploaded.
3. **The CV categoriser DOES have nursing examples in its prompt** (lines 24-27 of `cv_skill_categorisation.py`). Why doesn't `jd_analysis.py`? Parity is the easy fix.

### Investigate

- Compare `cv_skill_categorisation.py` prompt with `jd_analysis.py` — port the care-skill examples over to JD.
- Add an admin tool to re-classify ALL existing `cv_versions.skill_categories` against the current lexicon (one-time migration, idempotent).

---

## 3. Professional Summary composition

### Pipeline

```
build_composition_system()           # variants/composition.py — universal honest-tailoring
  + jd_analysis.summary               # AI-paraphrased JD context
  + jd_analysis.responsibilities      # JD body in structured form
  + cv_text                           # original CV text
  → COMPOSITION call (W8 writer)
  → tailored markdown w/ ## Professional Summary

Post-composition deterministic passes (writers.py):
  enforce_summary_dedup               # drop S2 if it re-lists S1
  enforce_summary_skills_dedup        # drop S2 clause that's just skills re-list
  enforce_summary_identity            # off-axis identity trim
  enforce_summary_breadth_consistency # strip `at <Org>` when S1 uses breadth
  _strip_canned_summary_phrase        # remove "Currently delivering care at X using BESTMed"
  _classify_jd_setting + _apply_setting_bridge  # S1 setting bridge (GATED today by CV evidence)
  enforce_summary_concreteness        # if S2 generic, rebuild from CV employers + tools
    └── filtered by _tools_attributable_to_employer (NEW today)
```

### Files

| File | Role |
|---|---|
| `cv-backend/app/services/ai/prompts/variants/composition.py` | The big universal-engine prompt + nursing pack |
| `cv-backend/app/services/eval/writers.py:1632-1900` | Summary post-processors (concreteness, breadth, dedup) |
| `cv-backend/app/services/eval/writers.py:3900-4100` | Setting classifier + bridge phrases |
| `cv-backend/app/services/eval/writers.py:1736-1810` | `_compose_concrete_s2` deterministic template |
| `cv-backend/app/services/eval/enforce_w3.py` | `enforce_summary_identity` |

### Known weaknesses

1. **The deterministic S2 template "Currently delivering care at {emp} using {tools}" is canned.** Every Rashmi-like profile gets the same shape. Worth replacing with something more JD-relevant or stripping entirely if the AI's S2 is already concrete.
2. **`_strip_canned_summary_phrase` + `enforce_summary_concreteness` fight each other.** Strip removes the canned phrase, then concreteness rebuilds the SAME canned phrase from CV employers+tools. The net effect is "canned phrase appears anyway, just synthesised."
3. **Mid-sentence employer leak (open from previous sessions).** `enforce_summary_breadth_consistency` only catches trailing `at <Org>.` — mid-sentence `at Jesmond Miranda Nursing Home and provided…` isn't stripped.
4. **`_classify_jd_setting` settings are coarse.** Only 6 buckets (residential/home/hospital/NDIS/theatre/lifestyle). A JD that's "community aged-care + some home visits" defaults to residential — bridges don't fire.

### Investigate

- Is the deterministic concreteness template still worth it? Audit how often it's the source of "canned"-feeling summaries on real runs.
- Make the template JD-relevance-aware: pick verbs / scope phrases that mirror the JD's own language.
- Consider deleting `_strip_canned_summary_phrase` and adjusting concreteness to detect+preserve a concrete AI summary.

---

## 4. Keyword feasibility + injection

### Pipeline

```
keyword_feasibility.run_keyword_feasibility()         # AI call
  classifies every JD-required keyword (the missed ones) into:
    inject_directly       → CV has strong evidence
    inject_as_extension   → reframable from existing achievements
    inject_with_inference → adjacent evidence; defensible in interview
    honest_gaps           → not in CV; real upskilling needed

orchestrator
  ↓ feasibility passes through to writer:

writers._writer_w8_verified
  ├── composition AI call (sees full feasibility plan in user prompt)
  ├── verify_claims (AI honesty gate)
  ├── _targeted_bullet_rewrites (NEW-ish, per-bullet AI rewrites for missed extensions)
  ├── enforce_skills_section + _inject_approved_skills (cap-aware)
  └── _drop_subsumed_generic_skills + _normalise_skills_case + _dedupe_skills_across_lines
```

### Files

| File | Role |
|---|---|
| `cv-backend/app/services/pipeline/steps/keyword_feasibility.py` | The feasibility AI call + qualification filter |
| `cv-backend/app/services/ai/prompts/keyword_feasibility.py` | Feasibility prompt |
| `cv-backend/app/services/eval/writers.py:`_inject_approved_skills`` | Cap-aware injector (Fix C, family-aware) |
| `cv-backend/app/services/eval/writers.py:`_targeted_bullet_rewrites`` | Per-bullet AI rewrites for missed inject_as_extension keywords |
| `cv-backend/app/services/eval/writers.py:`_drop_subsumed_generic_skills`` | Removes generic skill once a specific child surfaces |
| `cv-backend/app/services/eval/role_families.py:`promote_matched_equivalents`` | Sprint L: synonym promotions + cert hierarchy |

### Known weaknesses

1. **`honest_gaps` are surfaced to UI but never re-evaluated.** A candidate could upload an updated CV with the gap closed; we don't recheck.
2. **`inject_with_inference` keywords get added but recruiters may flag them as overclaim.** No interview-prep coaching surfaces — the user is left to defend the inference cold.
3. **`_targeted_bullet_rewrites` is expensive** (one AI call per missed extension). Could be batched.
4. **Approved-skill injection is order-sensitive.** Fix C established `enforce_skills_section FIRST, then inject, NO enforce after` (else approved tail gets truncated). If anyone adds a post-inject enforcement, this regresses.
5. **`promote_matched_equivalents` table is hand-curated and small.** Likely undersized for nursing — every Sprint-L-class fix added one or two synonym pairs. Worth a systematic audit.

### Investigate

- Tally real production runs: how many `inject_directly` / `extension` / `inference` / `honest_gaps` per role family? Does the AI over-classify into `inference` (the riskiest bucket)?
- Compare what landed in the Skills section vs what the feasibility plan promised. We have `_log_tailoring_report` at the end of W8 already (`role_family / matched / direct / ext / inf / gaps / first_gaps / skills_entries`).

---

## 5. Recommended order of work

1. **Verify today's deploys with a real re-analyse** before any code change. Use Rashmi + Australian Unity. Confirm the math (ATS ~85–92, Care Skills populated, S1 honest, S2 honest).
2. **Read the four sections above end-to-end.** Don't optimise blindly.
3. **Pick ONE area to deep-dive first.** Recommended order if undecided:
   1. **JD analysis** — biggest leverage (drives every downstream bucket).
   2. **Professional Summary** — most user-visible.
   3. **Feasibility + injection** — most subtle, least visible until it goes wrong.
   4. **CV categorisation** — quietest area, but worth porting nursing examples from CV prompt to JD prompt.
4. **For each area: instrument before changing.** Add `logger.info("RAW <step>: %s", obj)` lines, run 2-3 representative analyses, READ the logs. Then propose a change.
5. **Test every change against 2+ verticals.** Nursing variance was hidden until cross-vertical (tech, manual) runs flagged it.

---

## 6. Quick-reference file map

| Concern | File |
|---|---|
| Orchestrator (pipeline glue) | `cv-backend/app/services/pipeline/orchestrator.py` |
| JD analysis AI step | `cv-backend/app/services/pipeline/steps/jd_analysis.py` |
| JD analysis prompt | `cv-backend/app/services/ai/prompts/jd_analysis.py` |
| CV-JD matching AI step | `cv-backend/app/services/pipeline/steps/cv_jd_matching.py` |
| CV-JD matching prompt | `cv-backend/app/services/ai/prompts/cv_jd_matching.py` |
| ATS scoring (deterministic) | `cv-backend/app/services/pipeline/steps/ats_scoring.py` |
| Feasibility AI step | `cv-backend/app/services/pipeline/steps/keyword_feasibility.py` |
| Lexicon classifier | `cv-backend/app/services/skills/classifier.py` |
| Lexicon post-process (incl. JD-body scan + 3 recognisers) | `cv-backend/app/services/skills/post_process.py` |
| Skill lexicons | `cv-backend/app/services/skills/lexicons/{_universal_noise,nursing,tech,cleaning}.json` |
| Role families + equivalences | `cv-backend/app/services/eval/role_families.py` |
| Production tailored-CV writer | `cv-backend/app/services/eval/writers.py:_writer_w8_verified` |
| Composition prompt (W8 user msg) | `cv-backend/app/services/ai/prompts/variants/composition.py` |
| W3 enforcement (apply_w3_gates) | `cv-backend/app/services/eval/enforce_w3.py` |
| Summary honesty gates | `cv-backend/app/services/eval/writers.py:1632-1900, 3900-4280` |
| Skills-section hygiene tests | `cv-backend/tests/test_skills_hygiene.py` |
| Lexicon post-process tests | `cv-backend/tests/test_skills_post_process.py` |
| Summary honesty tests | `cv-backend/tests/test_summary_honesty_fixes.py` |
| JD setting classifier tests | `cv-backend/tests/test_jd_setting_classifier.py` |
| Sprint E summary concreteness tests | `cv-backend/tests/test_sprint_e_summary.py` |
| Skills audit beta page | `web/src/app/(dashboard)/dashboard/beta/skills-audit/` |
| Summary audit beta page | `web/src/app/(dashboard)/dashboard/beta/summary-audit/` |
