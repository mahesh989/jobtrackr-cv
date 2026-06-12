# JD-extraction quality programme — status & next-session handoff

> **Last updated:** 2026-06-12 (end of session — context running low).
> **Branch:** `refactor/architecture-review`. NOT merged to `main`.

## Branch state

```
main ──── (production)
  │
  └── refactor/architecture-review  ←── you are here (Vercel preview)
        │
        ├── 599de98 Phase 1 — evidence-grounded extraction
        └── 2e39806 Phase 2 partial — multi-bucket recall floor + nursing variants
```

- Tests: **864 passed** at HEAD (`2e39806`).
- The refactor branch is what's deployed to the Vercel **preview URL**.
- Production prod URL still runs `main` — these quality fixes are NOT live yet.
- Other simultaneous session: was experimenting with `ats_scoring.py` weights
  on `main`. That work is independent of this programme; no merge needed
  before you continue Phase 2/3/4.

## The four-phase plan

Goal: kill four failure classes that explain why two runs of the same JD
produce different ATS scores and why hallucinated skills sneak through.

| Class | Example | Phase |
|---|---|---|
| Hallucination | "person-centred care" with evidence "AIN" | 1 ✅ |
| Under-extraction / variance | 2 vs 7 care skills on same JD across runs | 2 (partial) |
| Redundancy | "communication" + "verbal" + "written" all kept | 3 |
| Paraphrase miss | "Commitment to allocated Shifts" → reliability lost | 2 (partial) |
| Regression-safety | Future prompt change silently breaks other JDs | 4 |

---

## ✅ Phase 1 — Evidence-grounded extraction (DONE, committed `599de98`)

### What it does
The JD-analysis prompt now requires each skill be returned with a verbatim
JD quote:
```json
{"skill": "verbal communication",
 "evidence": "communication skills, both verbal and written"}
```

A new deterministic gate, **`verify_skill_evidence`**, runs immediately
after JD analysis and BEFORE the recall floor. For every LLM-extracted skill:
1. **Evidence-in-JD check** — evidence text must literally appear in the JD
   body (after unicode/casing normalisation). If not, drop the skill.
2. **Skill-derivable-from-evidence check** — direct token overlap, OR a
   4-char compound prefix (`teamwork` ← `team`), OR a per-vertical lexicon
   synonym mapping. If none of these, drop.
3. Drops are recorded under `lexicon_meta.ungrounded` for audit.

### Files changed
- `app/services/ai/prompts/jd_analysis.py` — prompt asks for evidence
- `app/services/pipeline/steps/jd_analysis.py` — parser accepts both
  `[str]` (back-compat) and `[{"skill","evidence"}]` (current); emits a
  parallel `skill_evidence: Dict[str,str]` on the analysis result
- `app/services/skills/post_process.py` — `verify_skill_evidence()`
- `app/services/skills/__init__.py` — public export
- `app/services/pipeline/orchestrator.py` — wired in before
  `enrich_required_skills_from_jd_body`
- `tests/test_skills_evidence_gate.py` — 10 new tests

### Back-compat
- Older AI runs that don't emit evidence → gate is a no-op (nothing breaks
  during prompt rollout)
- The 4-char prefix path is the "lenient" knob — keep an eye on whether it
  ever accepts a hallucination. If so, tighten to 5 chars.

---

## ⏳ Phase 2 — Deterministic recall floor (PARTIAL, committed `2e39806`)

### What's DONE
`enrich_required_skills_from_jd_body` now scans the JD body against the
per-vertical lexicon for **all three buckets**, not just `domain_knowledge`.
Per-bucket caps mirror the prompt schema (`_BUCKET_CAPS` in
`post_process.py`).

Nursing lexicon expanded with high-leverage paraphrase variants:
- **reliability**: `commitment to allocated shifts`, `commitment to
  scheduled shifts`, `shift commitment`, `committed to shifts`, etc.
- **teamwork**: `works well as part of a team`, `as part of a team`, etc.
- **relationship building**: `partnership with residents and family`,
  `working in partnership with residents`, etc.

### What's NOT DONE — pick this up next session

1. **Unit tests for the multi-bucket recall floor.** Add a test class
   `TestRecallFloorAllBuckets` to `tests/test_skills_post_process.py`:
   - Given a JD body containing "commitment to allocated shifts" and an
     LLM result with empty `soft_skills`, the floor injects `reliability`.
   - Given a JD body containing "works well as part of a team" and LLM
     missed `teamwork`, the floor injects `teamwork`.
   - Per-bucket cap respected: if `soft_skills` already has 10 items,
     no more are injected.

2. **Paraphrase audit for `tech.json`.** Common JD phrasings the
   tech lexicon doesn't currently cover:
   - "must have strong [X] skills" patterns
   - "experience with [X] platforms" idioms
   - Run a few real tech JDs through the pipeline, look at the
     `lexicon_meta.ungrounded` log line + the unknown_tracker JSONL
     (`unknown_phrases.jsonl`), promote the high-frequency phrases.

3. **Paraphrase audit for `cleaning.json`.** Same approach. The Phase 3B
   lexicon foundation work earlier this month built the base; this is
   pure variant-expansion.

4. **Lexicon scaffolding.** Consider adding a small Python script
   `scripts/audit_lexicon_gaps.py` that:
   - Reads the last N analysis runs from `lexicon_meta.ungrounded` logs
   - Groups dropped skills by `reason` and `evidence` text
   - Emits a CSV/JSON for human triage → lexicon promotion
   - This is the on-going feed that keeps recall improving.

---

## 🟦 Phase 3 — Subsumption dedup (NOT STARTED)

### What it does
Kills the redundancy class: when the LLM extracts both a generic parent
(`communication`) AND ≥1 specific child (`verbal communication`,
`written communication`), drop the parent. The parent survives only when
no children are present.

### Design
1. **Add parent→child relations to lexicon schema.** Each canonical entry
   gets an optional `subsumes: [child_canonical, ...]` field. Example
   in `nursing.json`:
   ```json
   { "canonical": "communication",
     "subsumes": ["verbal communication", "written communication"],
     "variants": [...] }
   { "canonical": "aged care",
     "subsumes": ["residential aged care", "home care", "community care"],
     "variants": [...] }
   ```
2. **Build a subsumption map at load time** in `classifier.py`:
   `_SUBSUMES: Dict[vertical, Dict[parent_canonical, Set[child_canonical]]]`.
3. **Add a deterministic pass** in `post_process_jd_analysis`:
   ```python
   def _dedupe_by_subsumption(skills_by_cat, vertical):
       """If both parent and ≥1 child are present in the same bucket,
       drop the parent. Mutate skills_by_cat in place."""
   ```
   Runs AFTER `verify_skill_evidence` and AFTER
   `enrich_required_skills_from_jd_body` so it sees the final set.

### Tests to add
- `test_skills_subsumption.py`:
  - parent + child both present → parent dropped
  - parent alone → kept (generic survives when no specific is there)
  - parent in `required`, child in `preferred` → cross-bucket, no drop
    (this is a deliberate non-action — different urgencies)
  - multiple children, parent → parent dropped
  - unknown parent (not in lexicon) → no-op

### Files
- `app/services/skills/lexicons/nursing.json` (add `subsumes` fields)
- `app/services/skills/lexicons/tech.json` (add `subsumes` fields)
- `app/services/skills/lexicons/cleaning.json` (add `subsumes` fields)
- `app/services/skills/classifier.py` (build `_SUBSUMES` lookup)
- `app/services/skills/post_process.py` (`_dedupe_by_subsumption`)
- `tests/test_skills_subsumption.py` (new)

### Starting subsumption families for nursing
- `communication` ⊃ {verbal communication, written communication}
- `aged care` ⊃ {residential aged care, home care, community care, in-home care}
- `personal care` ⊃ {showering and bathing, dressing and grooming,
  toileting assistance, feeding assistance, continence care}
- `care planning` ⊃ {care plan implementation, care plan reviews,
  care plan development}

### Starting subsumption families for tech
- `cloud` ⊃ {aws, gcp, azure}
- `databases` ⊃ {sql, postgres, mysql, mongodb}

---

## 🟦 Phase 4 — Golden-JD regression harness (NOT STARTED)

### What it does
The thing that makes "works on any JD, forever" real. A corpus of 15–20
real JDs across verticals (nursing × 6, tech × 5, cleaning × 3,
manual × 2). Each has a hand-labelled expected keyword set. The harness
runs the JD-analysis pipeline (LLM + groundedness gate + recall floor +
subsumption) and reports per-JD **precision** (must be 100% — anything
extracted that isn't in the gold set is a hallucination) and **recall**
(% of gold-set keywords extracted).

### Design
1. **Corpus.** `cv-backend/tests/golden/jds/` — one Markdown file per
   JD with a YAML frontmatter:
   ```yaml
   ---
   id: nursing-jesmond-ain-night
   vertical: nursing
   role_family: nursing
   subtype: care
   expected:
     required:
       domain_knowledge: [aged care, food handling, feeding assistance,
                          mobility support, care planning,
                          recreational activities support]
       soft_skills: [empathy, reliability, verbal communication,
                     written communication, teamwork, positive attitude,
                     relationship building, cultural sensitivity]
   ---
   <JD body text>
   ```
   `expected.required.{cat}` is the **ground truth** for that JD —
   what an honest, complete, non-hallucinating analysis should produce.

2. **Harness** (`cv-backend/scripts/golden_jd_eval.py`):
   - Loads each JD + its expected set.
   - Calls `run_jd_analysis(ai_client, jd_text)` — real AI call, BYOK key
     read from env (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`).
   - Runs the full deterministic post-process chain
     (`verify_skill_evidence` → `enrich_required_skills_from_jd_body` →
     `post_process_jd_analysis` → subsumption dedup once Phase 3 lands).
   - Computes per-JD precision/recall vs `expected`, plus aggregate
     pre-vertical scores. Hallucinations are listed individually.
   - Writes a JSON report under `tests/golden/reports/<timestamp>.json`
     and a Markdown summary to stdout.

3. **Unit-test wrapper.** A pytest test that calls the harness in
   **mock mode** — uses a recorded JD-analysis output (saved as
   fixture) instead of a live AI call. This catches deterministic-stage
   regressions (gate, floor, subsumption) in the main 864 suite without
   needing live API keys. The full live-AI harness runs on demand.

### Acceptance criteria
- Precision ≥ 95% on every JD (max 1 hallucination per JD; flag <100%
  cases for lexicon growth)
- Recall ≥ 80% on every JD (gold-set might be aspirational; track but
  don't gate yet)
- Aggregate: 0 hallucinations across the corpus on a re-run

### Files
- `tests/golden/jds/*.md` (corpus)
- `tests/golden/fixtures/*.json` (recorded LLM outputs for mock mode)
- `tests/golden/reports/` (output dir, gitignored)
- `scripts/golden_jd_eval.py` (harness)
- `tests/test_golden_jd_mock.py` (mock-mode pytest wrapper)

---

## Verification check before resuming next session

```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv
git branch --show-current     # should be: refactor/architecture-review
git log --oneline -3          # should show 2e39806, 599de98, 47ee039
cd cv-backend
./.venv/bin/pytest -q         # should report: 864 passed
```

If the branch is `main` again (other session may have switched), run
`git checkout refactor/architecture-review` first.

## When to merge refactor → main

NOT yet. Merge candidates (in order):
1. After Phase 3 — once subsumption dedup is in and tests are green
2. After Phase 4 — once the golden harness shows precision ≥95% across
   the corpus
3. Final merge: with the user re-running the Jesmond Group AIN JD on
   preview and confirming ATS lands ≥ 85 with no hallucinations and
   "reliability" present in the soft skills

Until then, the refactor branch stays the preview environment.
