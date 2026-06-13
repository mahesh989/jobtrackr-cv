# Tailoring Engine — Test Inputs & Validation Guide

How to validate the CV-tailoring engine — the **Phase 3A prompt rules** (A/B/C/E/F)
and the **Phase 2 deterministic gates** they back up — with real runs. For each rule
it lists the input fixture that actually *exercises* it, the pass/fail signal, and
what to capture. Companion to `PHASE2_ARCHITECTURE.md`.

> **Why this exists:** the two 2026-06-04 validation runs (Anglicare home-care +
> Nepean AIN) used the same candidate, who holds **only a Cert IV** and **one
> dash-containing employer**. So rule **C was never truly exercised** and a few rules
> were only lightly tested. The fixtures below close those gaps.

---

## How to hand Claude a run for verification

Paste, per run:

1. **Source CV text** (the master CV) — *required* for **B** (fabrication check) and
   **E** (month-drop check). Without it those two are inference-only.
2. **The JD** — paste it, or give the job-table id/link (Claude can read the JD from
   the analysis screen; the DB is only needed if the JD isn't shown).
3. **The analysis output** — at minimum the **Tailored CV markdown** + the side
   panels: *Injected into tailored CV*, *Approved but missed*, *Filtered as
   non-skill*, and *Structure check (pass/warn/fail)*.
4. **Detected role family + model** (shown in JD analysis / run details).
5. *(Optional, for hard A/B attribution)* the gate strip-count log, if added.

**The attribution rule of thumb:**
- **C, E, F have no deterministic gate** → the final CV is a *definitive* test.
- **A, B have gates** → a clean CV is *ambiguous* (prompt vs. gate). Use the
  *Filtered as non-skill* count (A) and the absence of placeholders (B) as proxies;
  a strip-count of **0** is the real "prompt owns it" signal.

---

## Per-rule fixture requirements

### A — Skills content discipline ("Aged Care" is not a skill)
**Need:** a JD heavy on sector names, eligibility lines, and verbose fragments, where
feasibility *approves* some of them — so the composer is tempted to dump them in Skills.
- JD should contain: a bare **sector** ("Aged Care", "Hospitality", "Fintech"); an
  **eligibility** line ("must have work rights", "police check required"); **fragments**
  ("experience in aged care", "knowledge of infection control", "ability to work in a team").
- **Pass:** none appear as Skills entries; ideally *Filtered as non-skill = 0*
  (prompt handled it upstream). A low non-zero count = gate caught it (still a pass on
  output, weaker on attribution).
- **Status:** well covered by aged-care JDs; both 2026-06-04 runs clean (run 2 = 0 filtered).

### B — No placeholder / ungrounded credentials
**Need two fixtures:**
- **B1 (fabrication temptation):** JD *requires* a named credential the candidate
  does **not** hold (e.g. "AHPRA registration", "White Card", "forklift licence") and
  the CV/profile lacks it. **Pass:** no fabricated entry, **no `[Provider not
  specified]` placeholder**.
- **B2 (missing details):** a CV credential with **no issuer/number/date** stated.
  **Pass:** written plainly (e.g. "First Aid"), never "First Aid – [Issuer]".
- **Status:** no-placeholder behaviour confirmed on both runs; the *fabrication-
  temptation* case (B1) not yet run.

### C — Credential hierarchy: Cert IV ⊇ Cert III  ⚠️ **HIGHEST-PRIORITY GAP**
**Need:** a CV that **literally lists BOTH** a Cert III and a Cert IV **in the same
pathway** — e.g. `Certificate III in Individual Support` *and* `Certificate IV in
Ageing Support` — with a JD in that field.
- **Pass:** output lists **only the Cert IV**; the Cert III is dropped; any Bachelor
  is still kept (rule is scoped to exclude degrees).
- **Licence variant:** CV lists both a learner/provisional **and** a full licence →
  only the full licence shown.
- **Status:** **NOT exercised** — the test candidate holds only Cert IV, so we've
  confirmed it doesn't *fabricate* a lower cert, but not that it *drops a present* one.

### E — Education month preservation
**Need:** a CV whose education dates carry **months** ("May 2025", "September 2019").
- **Pass:** months preserved in output, never collapsed to a bare year ("2025").
- **Bonus (tests a separate Sprint C gap):** include a date with a **day-of-month**
  ("Sept. 20, 2024") — the day *should* be stripped to "Sept. 2024". **Currently
  FAILS** (see Known defects).
- **Status:** month-preservation confirmed; day-strip gap reproduced on both runs.

### F — Employer-name integrity in the summary (S2)
**Need:** kept employers whose names contain **internal punctuation**:
- en/em-dash: "Uniting – The Marion" *(covered ✓)*
- ampersand: "Meals & Wheels", "Johnson & Johnson"
- slash: "RPA / Concord Hospital"
- **Pass:** the name appears **whole** in S2, no dangling fragment ("– The Marion"),
  no hanging connector; S2 reads as grammatical prose.
- **Status:** dash case confirmed twice; ampersand/slash cases not yet run.

---

## Cross-vertical regression (the rules are universal — they must not damage non-nursing output)

| Vertical | Fixture | What to check |
|----------|---------|---------------|
| **Tech** | a software/data CV + a data/eng JD | Skills-discipline doesn't strip real tech skills; cert-hierarchy never touches degrees; dates intact; off-axis suppression still works |
| **Manual** | cleaner/warehouse/driver CV + matching JD | No keyword-stuffing (injection_policy=none); certs/checks correct; Availability line present |
| **Nursing** | *(covered)* aged-care + hospital AIN | primary vehicle |

---

## Approve / reject rubric

- **APPROVE** if: C, E, F **PASS** (definitive) **AND** A, B output clean **AND** no
  Phase 2 invariant regressed.
- **STRONG-APPROVE** if additionally: A/B gate strip-count ≈ **0** (or a before/after
  vs. the old prompt shows the junk gone at the LLM layer), confirmed over **2–3 runs**
  (the composer is non-deterministic, temp ~0.35 / gpt-5.1).
- **REJECT a rule** if its FAIL signal appears → iterate the prompt, or for C decide
  whether to add the deferred deterministic dedup gate.

---

## Known defects to watch (from the 2026-06-04 validation runs — pre-existing, NOT Phase 3A regressions)

1. **Awards formatting malforms** — observed: `Staff Excellence Award, Org (description, August 2025)` + the description duplicated on the next line. Should be canonical `* Name - Org (Date)` + a single description line. `_normalise_awards_entries` isn't catching this composer output shape.
2. **`Sept. 20, 2024` day-of-month not stripped** — Sprint C `normalise_date_formats` misses the `Mon. DD, YYYY` form.
3. **Title chain in S1** ("Assistant in Nursing and care worker") — TITLE_SLOT rule (item 13) + `enforce_summary_identity` gap (the gate's `_ROLE_HEAD_NOUNS` set lacks "nursing"/"worker"). Intermittent (clean on run 2).
4. **Approved-but-missed keywords (doc issue 3)** — the composer ignores feasibility's *inject_as_extension* bullet rewrites; on the Nepean run this produced **+0 ATS lift** with 8 approved keywords missed. The dominant practical defect; not addressed by Phase 3A.
5. **Name mismatch** — the "Your CV — skills by category" card showed *Rashmi Poudel* while the tailored CV header is *Maheshwor Tiwari*. Likely profile-name vs CV-name source; verify it's not a stamping bug.
6. **Breadth-framed S1 + named employers mid-sentence in S2** — your open Priority-1 item; `enforce_summary_breadth_consistency` only strips a trailing `at <Org>.`, not mid-sentence.
