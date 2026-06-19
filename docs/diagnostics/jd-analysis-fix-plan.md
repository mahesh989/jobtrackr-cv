# JD-Analysis Subsystem — Fix Plan

**Companion to:** `jd-analysis-diagnosis.md` (24 findings, 3 root causes).
**Goal:** Fix the classification-layer defects **without regressing the professional summary or any other section.**
**Working mode:** Plan only. User tests after each phase; we analyse results before the next phase.

---

## 0. The regression risk, stated precisely

The professional summary, the skills section, and the experience bullets are **all written by a single LLM call** in `tailored_cv.py` that receives the **entire `jd_analysis` object** (`tailored_cv.py:47`, `jd_analysis_json=...`) plus the feasibility plan.

**Consequence:** any change to *what skills are extracted, how they are bucketed, their evidence, or the caps* changes the `jd_analysis_json` string the summary prompt sees — so the summary prose can shift even when we "only touched skills." This is the mechanism behind "I fix one feature and another breaks."

**Therefore the plan is built around one rule:**
> No behavioural change ships until a golden-output baseline proves the **professional summary and every other section** are unchanged (or changed exactly as intended) on a fixed set of real JD+CV pairs.

We separate **"move code" (behaviour-preserving)** from **"change behaviour"** and never mix them in one step.

---

## Phase A — Safety harness FIRST (no production code changes)

Nothing below this line is touched until Phase A exists. This is the single most important phase for your "another feature broke" pain.

### A1. Capture a golden baseline
- Pick **5–8 representative JD+CV pairs** (include at least: one residential aged-care JD, one with 15+ technical skills, one soft-skill-heavy JD, one with credentials/unit codes, one where the LLM historically returns bare strings).
- Run the **current** pipeline end-to-end on each and snapshot, per pair:
  - `jd_analysis` object (skills per bucket + evidence map)
  - feasibility plan
  - matched / missed skill sets + scores
  - **the full rendered CV markdown**, section by section: **Professional Summary**, Skills, Experience, Registration & Licences, Education, Awards.
- Store under `backend/api/tests/golden/jd_analysis/<pair-id>/baseline.json`.

### A2. A diff runner
- A script/test that re-runs the pipeline and **diffs each section against the baseline**, reporting per-section: unchanged / changed (with the diff).
- This is the gate for every later phase. "Summary section: unchanged" is the assertion you care about most.

### A3. Decide the diff policy
- For each phase we declare **expected** changes (e.g. "Skills section: 'aged care' now appears" ) and **forbidden** changes (e.g. "Professional Summary: any change").
- A phase passes only if forbidden sections are byte-identical (modulo whitespace) and changed sections match the declared intent.

**Phase A gate:** baseline captured for all pairs; diff runner green against itself (re-running with no code change shows zero diffs). *This proves the harness is deterministic before we trust it.*

> If the pipeline is **not** deterministic (LLM temperature > 0), A2 must pin the LLM responses — record the raw LLM outputs in the baseline and replay them, so we test *our deterministic code* (normaliser, gate, caps, filters) not the model's randomness. This is essential; otherwise every diff is noise.

---

## Phase B — Single source of truth, behaviour-PRESERVING (root cause 1)

Goal: collapse the 6 duplicate "is-this-a-skill" deciders into one module **without changing any verdict yet.** Pure consolidation.

### B1. Create `app/services/skills/registry.py` (new, additive)
A single module exporting:
- `NON_SKILL_EXACT` / `NON_SKILL_PREFIXES` / `NON_SKILL_PATTERN` — the **union** of today's lists, but initially **structured so each call site can still ask for its current subset** (see B3).
- `SECTOR_SETTING_LABELS`, `ROLE_CATEGORY_LABELS`, `CREDENTIAL_PATTERNS`, `AU_UNIT_PREFIXES`, `CATEGORIES`.
- `is_non_skill(phrase, *, stage)` — one predicate, `stage` selects which historical behaviour applies (so we can keep divergence explicit until B-final).

### B2. Module-level the closure (Finding M9)
- Move `tailored_rescoring._is_sector_only_phrase` out of `run_tailored_rescoring` into `registry.is_sector_only_phrase`, importable + unit-testable. Behaviour identical.

### B3. Re-point every call site at the registry, one at a time
Order (each its own commit, each gated by Phase A diff = **zero change everywhere**):
1. `tailored_rescoring.py` (already imports the private symbols — lowest risk)
2. `skills_section.py`
3. `enforce.py`
4. `keyword_feasibility.py` filler
5. `cv_jd_matching.py` credential regex
6. `post_process.py` sector/credential sets

**Phase B gate:** all golden sections **byte-identical** to baseline. We have changed structure, not behaviour. The divergences from Findings H5/M1/M2/M3 are now **visible in one file** but not yet reconciled.

---

## Phase C — Reconcile the divergences (root cause 1, behavioural — HIGH)

Now that the lists are in one place, fix the disagreements. **Each sub-step declares its expected section diffs.** Each is independently testable and revertible.

### C1. Decide the "aged care" / sector-phrase policy (Findings H3, M1, H5)
This is a **product decision**, not a mechanical fix — surface it before coding:
- **Option 1:** Sector phrases are *never* skills → strip them consistently at extraction (remove from JD denominator too). Score goes up for affected JDs; "aged care" never counted or shown. **Summary impact:** likely none (summary rarely lists the bare sector).
- **Option 2:** Sector phrases *are* domain_knowledge skills → keep them everywhere including render (remove from `_ROLE_CATEGORY_LABELS` + `_NON_SKILL_EXACT`). "aged care" becomes showable. **Summary impact:** minimal but the skills block changes, which can nudge the summary via shared context.
- **Recommendation to confirm with user:** Option 1 (strip consistently) — it removes the scored-but-unshowable trap with the least surface area, and sector phrases are weak ATS signal anyway.
- **Gate:** Skills section changes as declared; **Professional Summary unchanged**; score delta explained.

### C2. Unify credential recognition (Findings M2, M10)
- One credential matcher + one AU-unit-prefix list in the registry; `_KW_SYNONYM_MAP` and `user_has_credential` read the **same** equivalence table.
- **Gate:** Registration & Licences section + matched/missed credential sets stable or improved; Summary unchanged.

### C3. Unify the "experience in/of/with X" filler (Finding M3)
- Single token set. **Gate:** Skills section only; Summary unchanged.

**Phase C gate:** every declared diff matches intent; Professional Summary unchanged across all pairs.

---

## Phase D — Single source of truth for caps & weights (root cause 2 — HIGH)

### D1. One caps constant (Finding H4)
- Decide the real caps (extraction vs render must agree). Today: extract 15/10/10, render 14/6/6 → 4 soft skills silently dropped.
- Put `SKILL_CAPS` (required + preferred) in the registry; prompt schema comment, `_BUCKET_CAPS`, and `DEFAULT_SKILL_CAPS` all reference it (or are asserted equal in a test).
- **Product decision to confirm:** raise render to match extraction, or lower extraction to match render? Lowering extraction is **safer for the summary** (fewer skills in `jd_analysis_json` = closer to today's summary input). Raising render shows more skills and *will* shift the summary via shared context.
- **Gate:** declared cap behaviour; Summary diff **expected to be the riskiest here** — flag explicitly and review.

### D2. Share ATS weights (Finding M12)
- `keyword_feasibility._KEYWORD_WEIGHTS` imports from `ats_scoring` (or a test asserts equality). No behavioural change.
- **Gate:** zero diff.

---

## Phase E — Make the grounding gate fail closed (root cause 3 — HIGH)

Most delicate phase for the summary, because it changes *which skills exist*. Do it last, one valve at a time.

### E1. Close the bare-string bypass (Finding H1)
- `verify_skill_evidence` must not no-op when `evidence_map` is empty: if the normaliser produced bare strings, treat as "no evidence" per the prompt's HARD rule (drop or quarantine, per decision).
- **Risk:** removes hallucinated skills → fewer skills in `jd_analysis_json` → **summary will likely shift**. Declare expected; review per pair.

### E2. Gate the recall-floor injections (Finding H2)
- Recall floor must write a `skill_evidence` entry (the JD substring it matched) so injected canonicals are subject to the same gate; remove the soft-skills-only carve-out asymmetry.
- **Gate:** required-skill set changes as declared; Summary reviewed.

### E3. Tighten over-broad groundedness (Finding M8)
- Single-shared-token match ("care planning" grounded by "care") → require stronger overlap. Conservative threshold, measured against goldens.

**Phase E gate:** hallucination cases from the baseline are gone; legitimate skills retained; Summary changes reviewed and accepted pair-by-pair.

---

## Phase F — Cleanups (MED/LOW, low risk, optional)
- M4 inject_directly downgrade, M5/M6 soft-skill inference vs compassion/empathy contradiction, M7 bucket-boundary docs, M11 `_NON_SKILL_PATTERN` regex→data, L1–L7.
- Each behind the same Phase A gate. These are quality-of-life; schedule after the HIGH set is proven.

---

## Ordering rationale
1. **A before everything** — you cannot safely change a coupled system without a regression net. This directly answers "another feature breaks."
2. **B (pure refactor) before C/D/E (behaviour)** — proves the consolidation is safe in isolation, so later behavioural diffs are unambiguous.
3. **C/D before E** — list/cap reconciliation is more contained than changing which skills exist; E (the gate) has the largest summary blast radius, so it goes last when the harness and the SoT are both trusted.

## What I need from you before coding
1. **Confirm the 5–8 golden JD+CV pairs** (or let me pick from existing fixtures).
2. **Sector-phrase policy** (C1): strip consistently (rec.) vs keep-and-show.
3. **Caps policy** (D1): lower extraction to render (safer for summary) vs raise render to extraction.
4. **Grounding policy** (E1): drop ungrounded skills vs quarantine for review.

Items 2–4 are the only product decisions; everything else is mechanical and gated.

## Verification contract (every phase)
- ✅ Professional Summary: **unchanged** unless the phase explicitly declares otherwise (only D1/E1/E2 may).
- ✅ Other sections: changed only as declared.
- ✅ Scores: every delta explained by a declared change.
- ❌ Any unexplained diff in any section = phase fails, revert, re-diagnose.
