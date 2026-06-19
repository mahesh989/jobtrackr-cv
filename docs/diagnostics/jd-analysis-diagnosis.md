# JD-Analysis Subsystem — Design Diagnosis

**Status:** Diagnosis only. No code was changed. A separate task will decide fixes.
**Method:** Two independent read-only auditor passes (Sonnet 4.6 + Opus 4.8) over the same 8 files. Findings below are the merged, deduplicated set. Both passes independently produced 24 findings and named the **same three root causes** — strong signal these are real, not model artifacts.

## Files in scope
- `backend/api/app/services/ai/prompts/jd_analysis.py` — extraction rules (prompt)
- `backend/api/app/services/pipeline/steps/jd_analysis.py` — normaliser
- `backend/api/app/services/skills/post_process.py` — groundedness gate + recall floor
- `backend/api/app/services/pipeline/steps/keyword_feasibility.py` — filler filter
- `backend/api/app/services/pipeline/steps/tailored_rescoring.py` — sector-only filter
- `backend/api/app/services/eval/writers/skills_section.py` — non-skill render filters
- `backend/api/app/services/eval/enforce.py` — role-category labels
- `backend/api/app/services/pipeline/steps/cv_jd_matching.py` — consumer of extracted skills

## Data flow (verified, not assumed)
Prompt extracts `{skill, evidence}` → normaliser flattens to lowercase lists + `skill_evidence` map → `verify_skill_evidence` groundedness gate → lexicon post-process strips/canonicalises → **recall floor re-injects** lexicon canonicals → matching splits matched/missed + credential sidecar → feasibility filter drops JD-phrasing → rescoring re-classifies → render filters strip Skills lines.

> **Key structural fact:** the *scoring denominator* is fixed at an early stage; the *render filter* runs at a late stage. When the non-skill lists disagree across stages, a phrase can be **scored-but-unshowable** — permanently depressing the achievable score.

---

## Root causes (fix these and most findings collapse)

1. **No single source of truth for "is this a real skill."** The same judgment is reimplemented 6+ times as divergent frozensets and mega-regexes. → drives all of Section 1, every contradiction in Section 3, every drift in Section 7.
2. **Caps and weights are copied, not shared, and disagree.** Extraction 15/10/10 vs render 14/6/6. → structurally guarantees extracted-but-truncated skills and lift estimates that can't match the scorer.
3. **The grounding contract is advisory, not enforced.** The prompt's HARD "no evidence → do not extract" has no hard enforcer (legacy bare-string path bypasses the gate entirely), and two later stages re-inject content the gate dropped.

---

## HIGH severity (can produce wrong output on plausible input)

### H1 — `verify_skill_evidence` is a total no-op on the legacy bare-string path
- **Where:** `post_process.py:905-907`; `steps/jd_analysis.py:153-156`
- **Now:** If the model returns skills as bare strings (no objects), `skill_evidence` is empty and the gate early-returns: `if not isinstance(evidence_map, dict) or not evidence_map: return`. Every hallucinated skill survives.
- **Risk:** The prompt's HARD grounding rule has no hard enforcer; one schema-ignoring model response bypasses the entire gate.

### H2 — Recall floor re-injects skills the gate already dropped
- **Where:** `post_process.py:1064` (`enrich_required_skills_from_jd_body`); comment at 1059-1063
- **Now:** Re-adds lexicon canonicals literally present in JD text, with **no evidence requirement** and **no `skill_evidence` entry** (so the gate can never re-check them). A `soft_skills: continue` skip exists *only* for soft skills; technical/domain are unprotected.
- **Risk:** A correctly-rejected ungrounded skill is silently re-introduced as REQUIRED.

### H3 — "aged care": prompt MUST-extract vs render MUST-strip
- **Where:** `prompt:51-52` + `post_process.py:418-422` (keeps it) vs `enforce.py:39` + `skills_section.py:16` (strip it)
- **Trigger input:** `"5 years aged care experience"` on a residential aged care JD.
- **Now:** Extracted, counted in the JD denominator, matchable — but can never render in the tailored Skills section.
- **Risk:** Score demands a skill the writer is forbidden to show; negative score for genuinely matching candidates.

### H4 — Per-bucket caps disagree across three places
- **Where:** `prompt:132-135` (15/10/10) + `post_process.py:1006-1010` `_BUCKET_CAPS` (15/10/10) vs `enforce.py:30` `DEFAULT_SKILL_CAPS` (14/6/6)
- **Now:** Skills are extracted and scored at 15/10/10 but truncated at render to 14/6/6.
- **Risk:** Guaranteed "extracted-but-never-shown" skills (esp. soft skills 7-10), structurally capping the achievable score.

### H5 — Six independent "not-a-skill" recognisers with divergent membership
- **Where:** `post_process._SECTOR_SETTING_LABELS`, `enforce._ROLE_CATEGORY_LABELS`, `skills_section._NON_SKILL_EXACT/_PREFIXES/_PATTERN`, `keyword_feasibility._FILLER_KEYWORD_RE`, `cv_jd_matching._CREDENTIAL_PHRASE_RE`, plus `classifier.is_noise()` (called from only 2 of 6 sites).
- **Now:** Same decision, six lists, no shared source. "aged care", "home care", "community care", "disability support", "retirement living" each have different membership across lists.
- **Risk:** A phrase suppressed at one stage but not another yields inconsistent scored-vs-shown state (root of H3).

---

## MED severity (will diverge / rot over time)

### M1 — Rescorer never consults `_SECTOR_SETTING_LABELS`
- **Where:** `tailored_rescoring.py:155-160` unions `_NON_SKILL_EXACT + _ROLE_CATEGORY_LABELS + _NON_SKILL_PREFIXES + _NON_SKILL_PATTERN` only.
- **Risk:** A phrase stripped JD-side by design is reported by the rescorer as a "failed_to_inject" defect — false "writer failed" report.

### M2 — Credential recognition implemented 5× with disagreeing prefix lists
- **Where:** `post_process.py:290-298` (`_AU_UNIT_PREFIXES`, ~40 entries) vs `cv_jd_matching.py:341` (`chc|hlt(?:aid|hps)?|bsb|fsk|sit|cpp|ahc`) vs `keyword_feasibility.py:93-100`.
- **Risk:** A unit code / "Cert IV in X" caught JD-side may slip through matching-side, or vice versa.

### M3 — "experience in/of/with X" filler defined 3× with different token sets
- **Where:** `keyword_feasibility.py:87` (no "across/supporting") vs `skills_section.py:142` (has both) vs `_NON_SKILL_PREFIXES`.
- **Trigger input:** `"experience supporting residents"` — passes feasibility filter, stripped at render → counted as a gap, never shown.

### M4 — `inject_directly` groundedness is a downgrade, not a drop
- **Where:** `keyword_feasibility.py:644-692` (`_enforce_inject_directly_groundedness`)
- **Now:** Mislabeled-verbatim content is downgraded to `inject_with_inference` and still flows to the writer.
- **Risk:** Honesty contract silently softened from "must be verbatim" to "may be inferred."

### M5 — Soft-skill inference rules re-promote honest gaps
- **Where:** `keyword_feasibility.py:719-723, 806-817`
- **Now:** `cannot_inject → inject_as_extension` when a curated substring appears anywhere in CV (e.g. "empathy" from "dementia"), evidence literally `Source CV contains 'dementia'`.
- **Risk:** Over-claiming against the prompt's grounding intent.

### M6 — compassion↔empathy: JD side forbids the substitution, CV side performs it
- **Where:** `prompt:80` + `post_process.py:856-862` (synonym path disabled for soft skills) vs `keyword_feasibility.py:720` (`"empathy": [... "compassion" ...]`)
- **Trigger input:** JD soft skill "compassion", CV contains "compassion"/"dementia".
- **Risk:** Two sides disagree on the canonical, breaking matching to the JD's actual wording.

### M7 — Bucket boundaries undefined for care phrases; bucket changes the score
- **Where:** `prompt:32` ("duty of care" = soft_skill) vs `skills_section.py:191` (stripped at render); weights `keyword_feasibility.py:112-117` (technical 25 vs domain 5).
- **Risk:** Same phrase lands in different buckets across runs → non-deterministic ATS weight.

### M8 — Single shared content-token counts as groundedness proof
- **Where:** `post_process.py:844-854, 1310-1313` (`_phrase_in_blob`, derivable path)
- **Now:** "care planning" is "grounded" by evidence containing only "care" (any content token >3 chars, or its 4-char prefix).
- **Risk:** Over-broad acceptance defeats the gate for care phrases that all share "care".

### M9 — `_is_sector_only_phrase` defined as a closure inside `run_tailored_rescoring`
- **Where:** `tailored_rescoring.py:162-175` vs the module-level `skills_section._is_non_skill_phrase` (`skills_section.py:251-261`)
- **Risk:** The most safety-critical "is this junk" decision is untestable and not importable; it re-implements a function that is already module-level and testable.

### M10 — Credential equivalence split across two unconnected representations
- **Where:** `tailored_rescoring._KW_SYNONYM_MAP` (`:393-490`) vs `keyword_feasibility.user_has_credential` (`:273-357`, cross-imported by `cv_jd_matching.py:160`)
- **Risk:** A credential creditable in matching/feasibility may not be credited in rescoring, or vice versa — the documented honest-gap-vs-fabricated fight (`tailored_rescoring.py:216-224`).

### M11 — `_NON_SKILL_PATTERN` is a ~70-branch regex mixing data and logic
- **Where:** `skills_section.py:134-248`
- **Risk:** Unmaintainable/untestable as a unit; backtracking risk; much duplicates `_NON_SKILL_EXACT`.

### M12 — ATS keyword weights hand-copied
- **Where:** `keyword_feasibility.py:112-117` mirrors `ats_scoring._KEYWORD_WEIGHTS` with an "update both places" comment.
- **Risk:** Expected-lift estimate diverges from the actual scorer if either changes.

---

## LOW severity (cosmetic / symptomatic)

- **L1** — Fuzzy yield thresholds ("~800 characters", "~5 skills") with no enforcer. `prompt:69-73`.
- **L2** — `_collapse_children_to_parent` + `_dedupe_by_subsumption` overlapping passes for a 2-parent effect. `post_process.py:1413-1517`.
- **L3** — `_CREDENTIAL_PAREN_TAIL_RE` encodes one provider's literal parenthetical wording. `post_process.py:167-180`.
- **L4** — `_floor_formatting` patches a formatter regression symptom; can mask real regressions. `tailored_rescoring.py:271-293`.
- **L5** — Three divergent normalisers (`_normalise_for_match` / `_scan_text` dashes / `classifier.normalise`). `post_process.py:782-793, 977-980`.
- **L6** — `_CATEGORIES` tuple redefined in 5 modules (`jd_analysis`, `post_process`, `keyword_feasibility`, `tailored_rescoring`, `cv_jd_matching`).
- **L7** — `"first aid (hltaid011)"` vs `"cpr certificate"` fabrication-check edge, documented fragile in `tailored_rescoring.py:216-227` (currently consistent).

---

## Structural verdict
The pipeline **skeleton** (extract → ground → match → plan → rescore → render) is sound. The **classification layer** is not — it needs redesign around (a) one shared non-skill/skill classifier, (b) one shared caps/weights/equivalence config, and (c) a grounding gate that fails closed. The HIGH findings are not independent bugs; H3/H5 descend from root cause 1, H4 from root cause 2, and H1/H2 from root cause 3. Local fixes will keep re-emerging until those three are addressed.
