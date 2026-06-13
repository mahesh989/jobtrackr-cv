# ATS scoring — v2 design (2026-06-12)

> **Branch:** `refactor/architecture-review` · **Tests:** 915 passed
> **Files:** `app/services/pipeline/steps/ats_scoring.py`,
> `app/services/cv/experience_parser.py`,
> `tests/test_ats_scoring_v2.py`.

## Why v2

v1 had three structural defects that produced the distribution pathology
the user flagged (irrelevant CVs ~26, moderate-tailored CVs inflating into
the 85-95 band):

1. **Double-count.** Cat 2's first sub-signal was
   `(required_matched / required_total) × 15` — reading the same counts Cat 1
   already scored. Up to 15 points credited twice when a CV matched keywords.
2. **Role-family freebie.** 8 pts awarded for the JD's `role_family` being
   recognised. The CV was never consulted. An irrelevant CV collected the
   same 8 pts as a perfect-fit one.
3. **"Deterministic" half-truth.** Sub-signal #2 divided by
   `matched_responsibilities`, which is an AI-emitted list. 12 of the 35
   experience points still rode AI variance.

v2 fixes all three by giving each category a different part of the document
to read, so they cannot double-count by construction.

## The 100-point envelope

| Cat | Pts | Reads | Question |
|---|---:|---|---|
| 1 — Keyword | **50** | matching `counts` | Do you *have* the skills? |
| 2 — Experience | **40** | CV experience narrative + JD's `experience_years_required` + `responsibilities` | Does your *work history back it up*? |
| 3 — Formatting | **10** | CV text structure | Is it clean? |

Category 1 is unchanged. The presence-aware redistribution + per-family
keyword weights (nursing/manual flip technical↔domain via
`role_families.py`) all carry forward verbatim.

## Category 2 — Experience (40 pts)

Three sub-signals, all consuming the structured CV experience produced by
`app/services/cv/experience_parser.py`:

```python
@dataclass(frozen=True)
class ExperienceEntry:
    employer: str
    role: str
    start: Optional[(year, month)]
    end: (year, month) | "present" | None
    bullets: List[str]
    vertical_hits: {"nursing": int, "tech": int, "cleaning": int}
```

The parser reuses the existing `_find_experience_section` /
`_parse_role_date_range` / `_split_into_entries` helpers (originally in
`eval/writers/experience.py` — inlined here to avoid the writers'
DB-config import chain). Vertical tagging uses the same skills lexicon
that JD analysis + skill categorisation use — one source of truth.

### Sub-signal 1 — Responsibility coverage (20 pts)

For each JD responsibility, count its content tokens (length ≥ 4, not a
stopword like "and" / "the" / "support" / "provide"). The responsibility
is *covered* when ≥ 2 of those tokens appear (word-boundary, case-insensitive)
anywhere in `cv_text`. Score = `(covered / total) × 20`. Neutral half
(10 pts) when the JD lists no responsibilities.

This reads the CV's narrative, not its skill list — so Cat 1 keyword
matches don't move it.

### Sub-signal 2 — Relevant tenure (12 pts)

Sum months across CV experience entries whose **primary vertical** equals
the JD's role family (nursing / tech / cleaning). Compared against
`jd_analysis.experience_years_required`:

- **JD requirement stated:** linear up to the requirement, capped at full
  credit. `min(1, relevant_months / required_months) × 12`.
- **No requirement stated:** presence-only — 12 pts if any relevant
  tenure, 0 otherwise.
- **Master family (unknown JD vertical):** neutral half (6 pts) — can't
  evaluate vertical-relative tenure when the vertical is unknown.

### Sub-signal 3 — Vertical alignment (8 pts)

Replaces the v1 role-family freebie. Fraction of CV experience entries
whose primary vertical equals the JD's role family.
`(aligned_entries / total_entries) × 8`. The CV must *earn* this; an SWE
CV applied to a nursing JD scores 0/8 instead of v1's flat 8/8.

Master family → neutral half (4 pts), same logic as tenure.

## Category 3 — Formatting (10 pts)

| Check | Pts |
|---|---:|
| Email present | 1.5 |
| Phone (≥10 digits) or URL | 1.5 |
| `## Experience` heading | 2.0 |
| `## Education` heading | 2.0 |
| `## Skills` heading | 2.0 |
| Word count in 150–2500 (half-credit 100–150 / 2500–3000) | 1.0 |

A hygiene check, not a discriminator — most real CVs land at 9–10. The
section-heading regex variants (`Career Summary`, `Key Skills`, etc.) and
the broadened length window from earlier loophole fixes are preserved
verbatim — the only change is the per-check budget.

## Tailoring invariant

**Keyword injection moves Category 1 only.** Cat 2 reads the experience
narrative (the writer can't legitimately fabricate new employers, dates,
or vertical tags from the feasibility plan) and Cat 3 reads document
structure. Both are stable under `_promote_injections`.

Asserted by `tests/test_ats_scoring_v2.py::TestTailoringInvariant`:

```python
def test_experience_score_is_independent_of_keyword_counts(self):
    m_low  = _matching(soft_matched=1, soft_total=7, dom_matched=1, dom_total=6)
    m_high = _matching(soft_matched=7, soft_total=7, dom_matched=6, dom_total=6)
    exp_low, _  = _experience_score(NURSING_CV, m_low,  NURSING_JD)
    exp_high, _ = _experience_score(NURSING_CV, m_high, NURSING_JD)
    assert exp_low == exp_high
```

This is the "predicted lift = actual lift" property made structural,
not a rule to remember.

## Distribution

Verified on three fixtures (`tests/test_ats_scoring_v2.py`):

| Scenario | Cat 1 | Cat 2 | Cat 3 | Total | v1 |
|---|---:|---:|---:|---:|---:|
| Irrelevant (SWE vs nursing) | 0 | ~13 (resp coincidence + neutral tenure) | 10 | ~23 ⇒ ≤ 25 | ~26 |
| True moderate (mixed CV, half keywords) | ~12 | ~28 (alignment 0.5, short tenure) | 10 | ~50 | 60-70 |
| Keyword-moderate + experience-strong, untailored | ~32 | ~34 | 10 | **76** | 60 |
| Same CV, tailored | 50 | **34** (unchanged) | 10 | **94** | 95 |

The keyword-moderate / experience-strong row is the most important: v1
collapsed those two axes into one number. v2 lets the experience-strong
CV stand on its own merit even when keywords aren't fully matched yet,
and tailoring lifts only the keyword axis.

## Files & wiring

- `app/services/cv/experience_parser.py` — new leaf module. No external
  pipeline deps.
- `app/services/pipeline/steps/ats_scoring.py` — `_experience_score`
  rewritten; `_formatting_score` simplified; constants updated; doc
  rewritten.
- `app/services/pipeline/steps/tailored_rescoring.py` — unchanged. It
  delegates to `run_ats_scoring`, which now does the right thing
  automatically. The `_floor_formatting` rule still applies.
- `tests/test_ats_scoring_v2.py` — 20 tests pinning the envelope, the
  distribution, the tailoring invariant, and each sub-signal in
  isolation.
- `tests/test_loophole_fixes.py` — obsolete v1 `TestExperienceScore`
  class removed; formatting tests rescaled to use `_FORMATTING_MAX`.

## Initial-ATS gate retuned (60 → 50)

The pipeline has an early-stop gate at `orchestrator.py:283`: if
`overall_score < min_initial_ats`, the tailored CV step is skipped (saves
~3 AI calls per low-match job). The default lived in
`schemas/internal.py:52` at **60**, tuned to v1's freebie-inflated
distribution.

v2's honest scoring lands moderate-fit CVs in the high 40s / low 50s
where v1 put them in the low 60s. Leaving the gate at 60 would silently
lock those users out — exactly the opposite of "fix the score, don't
change CV quality."

The default was lowered to **50**. Irrelevant CVs (the SWE-vs-nursing
case scores ≤25 in v2) are still gated out cheaply. Honest moderate-fit
CVs pass through and get tailored.

The **final-ATS gate** (`min_final_ats: 70`) triggers auto cover-letter
generation. Same v2 inflation logic applies, but the gate was left at
70 — auto cover-letter firing on FEWER, more-honest tailored CVs is
arguably correct. If real users start losing auto cover-letters that
v1 would have generated, drop it to 60 to match the initial-gate shift.

## When the design should be revisited

- **CV vertical ambiguity.** If real-world tech CVs containing nursing
  bullets (or vice versa) misclassify, raise the per-entry hit floor or
  introduce a winner-margin rule. Currently any non-zero hits put the
  entry in its highest-hit vertical.
- **Tenure outside the JD's vertical.** A 10-year SWE applying to a
  nursing JD scores 0 on tenure. If we want partial credit for
  *transferable* experience (adjacent verticals), that's a multiplier on
  vertical alignment — not a fix here.
- **Master-family rescue.** Generic JDs (no recognisable role family)
  get neutral-half on both tenure and alignment. If `master` ends up
  hitting a lot of legitimate roles, classify those into a proper
  family rather than tuning the neutral-half.
