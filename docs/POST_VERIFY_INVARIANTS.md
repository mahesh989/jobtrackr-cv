# Post-verify invariant divergence — diagnosis and plan

**Status:** DONE — implemented 2026-08-22 on branch `dev-5`. The document is kept
as the rationale for `app/services/eval/writers/invariants.py`; read it before
adding or reordering a pass there.
**Written:** 2026-08-22, after PRs #249–#257.

## What shipped

`app/services/eval/writers/invariants.py` declares ONE ordered list
(`INVARIANTS`) plus the context every pass grounds against.
`_writer_w8_integrated` applies it after composition; `_writer_w8_verified`
applies the SAME list after `verify_claims` **and again after the
summary-floor rewrite** — an AI call with no sweep after it was the same bug,
one call later. Both hand-written sequences are gone, so they can no longer
disagree.

All 17 gaps below are closed. `tests/test_post_verify_invariants.py` pins the
property rather than the symptoms: both sides are compared at runtime with an
instrumented registry, the set is proven a fixpoint (individually and as a
whole), the ordering constraints are asserted, and the two HIGH gaps are
demonstrated end-to-end. The four older single-symptom source-greps
(C22p, C82, C83, C67) now assert through its shared helper.

**Adding a pass:** put it in `INVARIANTS`. It must be deterministic,
synchronous and idempotent — the fixpoint test enforces the last one. Nothing
else is needed; it gets a pre- and post-verify life automatically.

**What the live verification found** (both fixed, `9592d9ed` + `062002cb`):
the award-description dedupe was spelling-blind at two sites. `ensure_awards`
re-adds from the source CV ("Recognized…") while the document is already
British ("Recognised…"), so the duplicate check missed and
`canonicalise_body_spelling` made the two identical *later*, with no dedupe
left to run. Latent before (the awards passes ran once, BEFORE the spelling
pass), live once they run on both sides. The single-JD run caught only the
first site; the bulk run of 9 caught the second in 3 of 9 CVs — see the
verification bar below, which earned its place again.

---

## The one-line problem

`_writer_w8_verified` runs `verify_claims` — an AI step that **rewrites** the
tailored CV — and the set of deterministic enforcers applied *after* it is a
different, smaller, hand-maintained set than the one applied *before* it.

Every tailored-CV bug fixed in #249–#257 was one instance of that divergence.
They were fixed one at a time, reactively, each after a user report. **17 more
pre-verify passes still have no post-verify counterpart.** This document lists
them so the next session can close the class rather than the next symptom.

## Why patching further is the wrong move

`_impl.py` already carries a comment convention acknowledging the hazard —
"RE-RUN … verify_claims is an AI step that can …" — attached to guards for
dates, settings, skills labels, credential claims, the summary opener, the
availability line, the display heading, and (as of #253/#256) the summary
floor, employer anchor, word caps and cert exclusion.

Each was added after an incident. Nothing declares the invariant set, so:

- adding a guard requires knowing the whole history;
- a pre-verify pass added tomorrow silently has no post-verify twin;
- there is no test that the two sets agree.

The divergence *is* the bug. Closing it is a refactor, not another guard.

---

## The gap: pre-verify passes with no post-verify counterpart

*(All closed — each row is now a member of `INVARIANTS` and a case in
`test_documented_gap_is_closed`. Kept for the reasoning behind each.)*

Derived by diffing the passes in `_enforce_structure` +
`_writer_w8_integrated` against those in `_writer_w8_verified`
(`recap_summary_preserving_anchors` counts as covering the two word caps).

Triage is by *"can `verify_claims` plausibly undo this?"* — it strips and
rewrites unentailed claims anywhere in the document.

### HIGH — verify a repro first, these look live

| Pass | Why it matters |
|---|---|
| `_strip_certs_when_projects_exist` | **This is the original reported bug, still live for every family except nursing.** #249 added `_strip_certs_when_excluded` and #253 re-ran it post-verify — but only the *excluded* (nursing) variant. For tech/manual/general, `verify_claims` can reintroduce `## Certifications` and nothing strips it. |
| `stamp_credentials` | Writes the user's **own saved credentials** into `## Registration & Licences` — the profile is authoritative. Stamped pre-verify only, so an AI rewrite can alter or drop the user's real credential data. Honesty-critical. |
| `stamp_references` | Same shape: the user's saved referees. Stamped pre-verify only. |
| `ensure_bachelor` | Deterministic recovery of a dropped baseline degree. If `verify_claims` drops it again, nothing re-adds it. |
| `ensure_awards` | Deterministic recovery of a dropped award. Same exposure. |

### MEDIUM — plausible, lower blast radius

| Pass | Note |
|---|---|
| `_surface_matched_skills` | Partly covered by `_inject_approved_skills` + `force_inject_missed_approved` post-verify, but not equivalent. Now carries the #253 grounding gate — re-running must keep `original_cv_text` wired. |
| `_surface_cv_named_tools` | CV-named brand tools (BESTMed, Leecare) dropped by a rewrite are not re-surfaced. |
| `_inject_missing_skills` | Approved-keyword safety net; only the `_inject_approved_skills` variant re-runs. |
| `_move_misplaced_technical_skills` | Skills hygiene partially re-runs; this specific relocation does not. |
| `_lowercase_generic_care_phrases` | Cosmetic but visible — a rewrite can restore "Dementia Care" Title Case mid-sentence. |
| `_promote_qualification_cert_to_education` | An AQF qual moved into Education pre-verify could be moved back or dropped. |
| `_strip_education_bullets` | Education entries must carry no bullets; a rewrite can re-add them. |

### LOW — re-run for symmetry, not urgency

`_dedup_career_highlights`, `_dedup_project_bullets`, `_enforce_education_count`,
`_enforce_other_skills_chars`, `_flag_vague_anchor`.

---

## Proposed whole fix

**Goal:** one declared invariant set, applied on both sides of `verify_claims`,
with divergence made impossible to introduce silently.

1. **Extract the invariant set as data.** A single ordered list of
   `(name, callable, needs)` — the deterministic, idempotent passes that define
   "a structurally valid tailored CV". Most passes already take
   `(markdown, …context)` and return markdown, so this is mostly mechanical.

2. **Split genuinely-once operations out.** Not everything may re-run. Audit
   each for idempotency first — `to_canonical` / `restore_and_order` (heading
   renames) and the AI retries are ordering-sensitive and must stay outside the
   re-runnable set. The `recap_summary_preserving_anchors` /
   `_enforce_company_anchor` ordering constraint documented in `employers.py`
   is a worked example of why order is load-bearing.

3. **Apply it twice** — once pre-verify, once post-verify — instead of
   maintaining two hand-written sequences.

4. **Add a test that the sets agree.** Something as blunt as "every pass in the
   invariant list is called on both sides" would have caught all 17 of these,
   and would catch #18.

5. **Keep the escalation path from #256.** Defects a deterministic pass cannot
   repair (garbled prose, tool names, too many specialisations) route to the
   single AI rewrite in `_ensure_career_highlights_floor`. Deterministic repair
   first, one rewrite as fallback, never in-place prose surgery — mutating
   prose is what produced the mid-phrase garbling in the first place.

### Verification bar for this work

Single-JD testing is not sufficient and demonstrably missed three defects.
Use the board's **bulk analyse over ≥9 full-JD roles** with one CV — one click,
a few minutes, and it is what surfaced everything in #256. Plus:

- `pytest` (1874 currently pass)
- `tests/golden/rendered_harness.py` — deterministic chain across all four
  verticals (run with `PYTHONPATH=.`)
- Note the harness **freezes LLM output**, so it cannot catch prompt
  regressions. Prompt changes need live bulk runs.

---

## Known open items (not part of this refactor)

- **Issue #255** — two structural-validation gates report false FAILs on valid
  nursing CVs (`skills_min_per_category` sub-type label drift;
  `highlights_reference_check` reading the stamped `*Available:*` line).
- **Bullet count/length** — occasional 1-bullet roles and sub-18-word bullets.
  Model compliance; cannot be forced without inventing content. Now surfaced by
  the gates rather than hidden.
- **Word caps decline to trim** when trimming would drop an employer anchor.
  Deliberate and logged — the anchor is a hard prompt rule, the count is a
  preference. Expect S2 at 23-25 words on two-employer summaries.
- **Nursing-only validation.** No tech CV exists in the account, so prompt
  changes remain unexercised on tech/manual/cleaning. The global OUTPUT SHAPE
  and specialisation rules edited in #253/#256 apply to every family.
- **`_is_term_grounded`'s 6-character prefix** (`injection.py`) was fitted to a
  single collision (`housekeeping`/`house`). Revisit against a second real CV.

## Useful context

- Root-cause write-ups live in the PR bodies: #253 (floor, anchor, gates),
  #256 (bulk findings). Both list what was tried and rejected, and why.
- `docs/REFACTORING.md` — house rules; the characterization-test-then-mutate
  discipline applies directly to step 1 above.
