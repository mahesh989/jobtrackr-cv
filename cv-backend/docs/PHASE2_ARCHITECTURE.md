# Phase 2: Deterministic CV-Assembly Pipeline

Reference for the deterministic post-passes that shape every tailored CV. Built across 9 sprints (A–I+) and 5 hotfixes (commits `8c87f56` → `82080e9`). All passes are idempotent. 304 tests cover this surface.

## High-level pipeline (orchestrator.py)

```
1. JD analysis             (LLM)         → required/preferred skills
1.5. resolve_role_family   (det.)        → vertical (tech/nursing/manual/master)
2. CV ↔ JD matching        (LLM)         → matched / missed per category
3. ATS scoring             (det.)        → initial_ats; per-family weights
   GATE: initial_ats < threshold → stop unless override
4. input_recommendations   (det.)        → ranked missing keywords
4.5. keyword_feasibility   (LLM)         → inject_directly | extension | inference | cannot_inject
5. ai_recommendations      SKIPPED for w8_verified
6. tailored CV             (LLM + det.)  → see writer pipeline below
6.5. tailored_rescoring    (det.)        → tailored_ats; injected_keywords; honest_gaps
   GATE: tailored_ats < threshold → cover letter skipped
7. PDF render + upload
```

## Writer pipeline (writers.py: `_writer_w8_verified`)

The production writer wraps `_writer_w8_integrated` and re-runs ALL Phase 2 sprints after `verify_claims` because that LLM step otherwise undoes Phase 2's deterministic shape.

### Inside `_writer_w8_integrated`

```
A. PROMPT CONSTRUCTION
   1. apply_equivalences (role-family synonym promotion)
   2. build composition system prompt (role-family + seniority)
   3. user prompt = cv_text + jd_text + feasibility_plan_json

B. LLM GENERATION
   client.complete(... max_tokens=6144, temperature=0.35)

C. CANONICAL SANDWICH (det. post-passes, in order)

   to_canonical                            ← rename family headings to canonical
   _enforce_structure                      ← bullet counts, summary word clamp
   _inject_missing_skills                  ← (Sprint 1.8 guard: skip non-skill phrases)
   stamp_contact_line
   apply_w3_gates                          ← suppression / degree / ungrounded-strip
   enforce_skills_section                  ← DEFAULT_SKILL_CAPS = (14, 6, 6) → Sprint F
   _surface_matched_skills                 ← re-add JD terms matcher confirmed
   _surface_cv_named_tools                 ← Sprint 1.8 + Sprint H scope fix
   _move_misplaced_technical_skills        ← Sprint H: smartphone/computer → tools line
   _strip_non_skill_phrases                ← THE BLOCKLIST (sector / filler / cred patterns)
   _normalise_skills_case                  ← Title Case + acronym preservation
   _dedupe_skills_across_lines             ← exact-match cross-line dedupe
   _inject_approved_skills                 ← post-cap safety net for approved missed
   _drop_subsumed_generic_skills           ← generic vs specific
   ensure_bachelor                         ← recover dropped degree
   ensure_awards                           ← recover dropped award
   restore_and_order                       ← rename canonical → family + section order
   _strip_ungrounded_credentials           ← drop fabricated credentials
   _relabel_awards_only_certifications     ← Cert section all-awards → relabel
   stamp_credentials                       ← overwrite Registration from profile

   # ── PHASE 2 SPRINTS ──
   [4c-bis] split_awards_and_certifications  ← SPRINT A: mixed section splitter
   [4d]     _normalise_awards_entries        ← canonical award bullet format
   [4e]     sort_experience_chronologically  ← SPRINT B: ongoing first, end_date desc
   [4f]     normalise_experience_tense       ← SPRINT B: Present roles → present-tense verbs
   [4g]     canonicalise_body_spelling       ← SPRINT C: British/Australian spelling, case-preserving
   [4h]     normalise_heading_title_case     ← SPRINT C: italic role lines only (Sprint C hotfix: skip H3)
   [4i]     normalise_date_formats           ← SPRINT C: strip day-of-month
   [4j]     enforce_summary_concreteness     ← SPRINT E: ensure S2 names employer + tool

D. detect_knockouts (det.) → hard-requirement report
E. _log_tailoring_report (single log line per run)
```

### Inside `_writer_w8_verified` (the production wrapper)

```
1. result = await _writer_w8_integrated(...)
2. verified_md, vreport = await verify_claims(client, result.tailored_md, cv_text)   ← AI rewrite
3. Pre-Phase-2 enforces:
     enforce_summary_identity / title_dedup / breadth_consistency / dedup / skills_dedup
     _relabel_awards_only_certifications
     _normalise_awards_entries
     enforce_skills_section
     _strip_non_skill_phrases
     _normalise_skills_case
     _dedupe_skills_across_lines
     _inject_approved_skills
     _drop_subsumed_generic_skills
     _normalise_skills_case
     _dedupe_skills_across_lines
4. PHASE 2 RE-RUN (critical — verify_claims can undo Phase 2):
     split_awards_and_certifications
     _normalise_awards_entries
     sort_experience_chronologically
     normalise_experience_tense
     canonicalise_body_spelling
     normalise_heading_title_case
     normalise_date_formats
     enforce_summary_concreteness
5. Final hard-cap pass:
     enforce_skills_section          ← Sprint F: (14, 6, 6); drops empty Other line
```

## Sprint inventory

| Sprint | Module(s) | Purpose | Key tests |
|--------|-----------|---------|-----------|
| **A** | `split_awards_and_certifications` | Splits mixed Certifications sections; drops Registration duplicates | `test_sprint_a_awards_split.py` (11) |
| **B** | `sort_experience_chronologically` + `normalise_experience_tense` | Reverse-chrono order; bullet tense matches role status | `test_sprint_b_experience.py` (26) |
| **C** | `canonicalise_body_spelling` + `normalise_heading_title_case` + `normalise_date_formats` | British spelling everywhere; "in"/"of" lowercase; strip day-of-month | `test_sprint_c_polish.py` (31 incl. hotfix) |
| **D** | `_strip_au_location` extensions + `_strip_duplicate_trailing_word` | Strip "Jesmond Miranda Nursing Home Miranda" suburb tail; bare-year tail | `test_phase15_regressions.py::TestSprintDLocationStripping` |
| **E** | `enforce_summary_concreteness` | Replace generic S2 with employer+tool template (deterministic) | `test_sprint_e_summary.py` (24 incl. hotfix) |
| **F** | `DEFAULT_SKILL_CAPS` → (14, 6, 6); nursing JD-title in `stopcaps` | Skills capped at 6; structural fail gone for nursing | (config change; existing tests) |
| **G** | Fabrication check uses `_literal_match`; apostrophe driver-licence variants | CPR no longer flagged as both gap and fabricated | `test_phase2b_synonyms.py::TestFabricationCheckLiteralOnly` (+ apostrophe tests) |
| **H** | `_surface_cv_named_tools` scoped to Skills section; `_move_misplaced_technical_skills` | BESTMed/MedMobile always in Other Skills; smartphone moves from Soft to Other | `test_sprint_h_tool_placement.py` (10) |
| **I** | `_strip_credential_qualifiers` + retry pass in `_kw_present` | "current accredited first aid certificate" → strips → matches HLTAID011 | `test_phase2b_synonyms.py::TestQualifierStripping` (8) |
| **I+** | Synonym override on honest gaps in `tailored_rescoring` | CPR with HLTAID011 in CV → credited, not gap | `test_phase2b_synonyms.py::TestSynonymOverridesHonestGap` (2) |
| **2B** | `_KW_SYNONYM_MAP` (curated AU credential synonyms) | "nsw c class motor vehicle licence" ≡ Driver Licence; HLTAID011 ≡ First Aid + CPR | `test_phase2b_synonyms.py` (26) |
| **Phase 2 re-run** | `_writer_w8_verified` re-fires all sprints after `verify_claims` | Phase 2 invariants always hold regardless of LLM output | (integration via 4j wiring) |

## Per-family config (`role_families.py`)

| Family | headline_bucket | category_labels | injection_policy | cert_policy | keyword_weights |
|--------|----------------|-----------------|------------------|-------------|-----------------|
| **tech** | technical | Technical / Soft / Other Skills | aggressive | plus | tech 25 / soft 10 / dom 5 / pref 10 |
| **nursing** | domain_knowledge | Care Skills (or Clinical/Core) / Soft / Other Skills | direct_only | first_class | **dom 25** / soft 10 / **tech 5** / pref 10 |
| **manual** | domain_knowledge | Core / Soft / Other Skills | none | first_class | same as nursing |
| **master** | technical | Technical / Soft / Other Skills | direct_only | plus | tech defaults |

All weights sum to 50. Nursing/manual flip the technical↔domain emphasis so clinical/care competencies (worth 25) dominate over tech tools (5).

## Key invariants

1. **Idempotency** — every Phase 2 pass produces identical output on re-run. Guaranteed by sort-order checks and equality early-exits.
2. **Honesty** — no Phase 2 pass invents content. Synonym overrides require both: a curated synonym AND that synonym literally present in CV.
3. **Order matters** — within the writer pipeline, the order in the canonical sandwich and the Phase 2 re-run section is load-bearing. Re-ordering will introduce subtle bugs.
4. **CAPS are final** — `enforce_skills_section` runs LAST in `_writer_w8_verified` to enforce `(14, 6, 6)` after all the post-cap injection paths.

## Synonym map (`tailored_rescoring._KW_SYNONYM_MAP`)

Curated AU-aged-care credential equivalences. Every entry is researched against AU national standards (NSW road authority for licences, AU VET unit codes for First Aid/CPR, AU clinical convention for vaccines). Conservative — only adds entries any AU recruiter would accept.

| JD wording | CV-side equivalents | Standard |
|------------|---------------------|----------|
| `nsw c class motor vehicle licence` | Driver Licence (Open) / Drivers Licence | NSW road authority — C class is the unrestricted car licence |
| `first aid certificate/ation` | First Aid (HLTAID011), HLTAID, hltaid011 | AU VET — HLTAID011 = current "Provide First Aid" qualification |
| `cpr certificate/ation` | First Aid (HLTAID011), HLTAID011, CPR | HLTAID011 explicitly includes CPR (supersedes HLTAID009 standalone) |
| `flu vaccination` ↔ `influenza vaccination` | each other | AU clinical convention |
| `australian working rights` | work rights / right to work / pr / citizen | self-evident |
| `police check` ↔ `national police check` | police clearance | self-evident |

**Qualifier-strip prefix list** (Sprint I): `current`, `valid`, `accredited`, `latest`, `up-to-date`, `active`, `recent`, `renewed`, `in-date`. Stripped before synonym lookup.

## Known LLM-quality issues

**Phase 3A (DONE — composition-prompt rework, prompt-rule-only)** added field-agnostic
rules to `_UNIVERSAL_ENGINE` (+ matching pre-emit self-audit items) for the issues
below. These are upstream fixes that make the deterministic gates fire LESS — the
gates all remain as backstops:

1. **Education months dropped** ("2025" not "May 2025") — **Phase 3A:** EDUCATION
   "KEEP THE CV'S GRANULARITY" rule + audit item (10). (No deterministic backstop —
   `normalise_date_formats` strips only day-of-month, can't recover a dropped month.)
2. **JD verbose phrases / sectors / eligibility in Skills** ("Aged Care", "Experience
   In Aged Care", "Work Rights") — **Phase 3A:** "SKILLS — CONTENT DISCIPLINE" rule +
   audit item (11). Backstop: `_strip_non_skill_phrases`.
3. **Awkward S2 grammar** — dangling em-dash "...dementia – The Marion and during
   placement" — **Phase 3A:** "EMPLOYER-NAME INTEGRITY" rule in COMPANY ANCHOR + audit
   item (4). (No deterministic backstop.)
4. **Placeholder / ungrounded credentials** ("[Provider not specified]", a licence not
   in the CV) — **Phase 3A:** TRUTH CONTRACT bullet + audit item (11). Backstop:
   `_strip_ungrounded_credentials`.
5. **Lower cert shown when higher present** (Cert III alongside Cert IV) — **Phase 3A:**
   "CREDENTIAL HIERARCHY" rule + audit item (10), scoped to exclude degrees. No
   deterministic gate yet (prompt-only by decision — add a dedup gate only if a beta
   run shows the LLM still surfaces the lower cert).

**Still open (NOT yet prompt-addressed):**
- **LLM extension misses** — feasibility approves an extension; LLM fails to apply it.
  Already pushed hard by the APPROVED KEYWORD MANDATE; no clean additional prompt lever.
- **Extraction-layer redesign (Phase 3B)** — per-vertical lexicons + explicit routing.

## Adding a new sprint — checklist

1. Write the function in `writers.py` (or appropriate file) with idempotency guarantees
2. Wire into `_writer_w8_integrated` at the right pipeline position
3. Wire into `_writer_w8_verified`'s Phase-2 re-run block (CRITICAL — verify_claims will undo it otherwise)
4. Add tests covering: positive case, no-op case, idempotence, edge cases for the bug it fixes
5. Update this doc's Sprint Inventory table

## File map

| File | What lives there |
|------|-------------------|
| `app/services/eval/writers.py` | Sprints A/B/C/D/E/F/H/I; all post-passes; `_writer_w8_verified` orchestration |
| `app/services/eval/enforce.py` | `enforce_skills_section`, `DEFAULT_SKILL_CAPS` |
| `app/services/eval/enforce_w8.py` | `to_canonical` / `restore_and_order` / section ordering |
| `app/services/eval/enforce_w3.py` | Summary identity / breadth / dedup / employer extraction |
| `app/services/eval/role_families.py` | Per-family config (caps, weights, labels, policies) |
| `app/services/pipeline/steps/tailored_rescoring.py` | Sprints G/I/I+/2B; verifier + synonym map |
| `app/services/pipeline/steps/tailored_structural_validation.py` | Structure gates (Sprint F nursing JD-title fix) |
| `app/services/pipeline/orchestrator.py` | Top-level pipeline + W8 dispatcher |

## Commit timeline

```
8c87f56  Phase 1: stop the bleed — guard injector, family-aware ATS weights, report log
35c712b  Phase 1.5: credential-aware verifier, blocklist entries, award dedupe
c479a99  Phase 1.6: split filtered-as-non-skill from missed; nursing structural gates
298b21e  Phase 1.7: tighten filtered-non-skill, fix category_labels dict reader
d582596  Phase 1.8: experience-as, basic computer, BESTMed/MedMobile surfacer, driving variants

ab18727  Phase 2 Sprint A: awards/certifications disambiguator
c2107e2  Phase 2 Sprint B: chronology + tense normaliser
bec31e5  Phase 2 Sprint C: body spelling + heading title-case + date format
7719a82  Sprint C hotfix: skip H3 lines in title-case pass
6f25631  Phase 2 Sprint D: extended award location stripping
49792f6  Phase 2 Sprint E: Summary S2 concreteness enforcer
0f075b4  Sprint E hotfix: partial-token employer match + tailored-md extraction
7f5e967  fix(phase2): re-run all Phase 2 sprints after verify_claims rewrite
751685b  Sprint F: hard cap Soft+Other Skills at 6; nursing JD-title not a ghost ref
ffc835a  Phase 2B: conservative AU credential synonym table for the verifier
96b8e54  Sprint G: fabrication literal-only; apostrophe driver-licence variants
b55e524  Sprint H: scope tool surfacer to Skills section; move misplaced tech entries
4076517  Sprint I: pre-strip JD qualifier words from credential keywords
82080e9  Sprint I+: synonym map overrides feasibility honest-gap classification
```
