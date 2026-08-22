"""The invariant set must be applied on BOTH sides of every AI step.

Background — docs/POST_VERIFY_INVARIANTS.md. ``verify_claims`` and the
summary-floor retry rewrite the tailored CV, so any deterministic pass that
ran before them can be undone. The remedy used to be a hand-written "re-run"
sequence inside ``_writer_w8_verified``, which was a strict SUBSET of the
pre-verify passes. Every gap in that subset shipped as a user-visible bug
(PRs #249-#257) and 17 more were still open when this suite was written.

These tests pin the property that made those bugs possible, rather than any
one of their symptoms:

  1. every pass in the declared set actually runs on both sides at RUNTIME;
  2. the set is a fixpoint (safe to apply repeatedly, which is what "apply it
     after every AI step" requires);
  3. the AI escalation inside ``_writer_w8_verified`` is itself followed by a
     sweep — an AI call with no sweep after it is the same bug, one call later.

``assert_invariant_runs_after_verify`` is the shared helper the older
single-symptom regressions (C22p, C82, C83, C67) now assert through.
"""
from __future__ import annotations

import asyncio
import inspect
import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.eval.writers import _impl
from app.services.eval.writers import invariants as inv_mod
from app.services.eval.writers.invariants import (
    INVARIANT_NAMES,
    INVARIANTS,
    Invariant,
    apply_invariants,
    build_context,
)
from app.services.eval.role_families import resolve_role_family


# ---------------------------------------------------------------------------
# Shared helper for the per-pass regression tests
# ---------------------------------------------------------------------------


def assert_invariant_runs_after_verify(name: str) -> None:
    """Assert `name` is a declared invariant, and that the declared set is
    swept over the VERIFIED markdown after verify_claims.

    Replaces the older per-pass source-greps (``assert "_apply_setting_bridge("
    in src``). Those greps could only ever be written once someone had already
    reported the bug for that specific pass; membership of the invariant set
    is the property that generalises.
    """
    assert name in INVARIANT_NAMES, (
        f"{name!r} is not in the declared invariant set — a deterministic "
        "pass that is not in INVARIANTS has no post-verify life, so an AI "
        "rewrite can undo it silently. Add it to writers/invariants.py."
    )
    src = inspect.getsource(_impl._writer_w8_verified)
    verify_idx = src.index("verify_claims(client")
    sweep_idx = src.index("apply_invariants(verified_md, inv_ctx)")
    assert verify_idx < sweep_idx, (
        "the invariant sweep must run AFTER verify_claims — verify_claims is "
        "an AI step that rewrites the document."
    )
    assert re.search(
        r"^\s*verified_md = apply_invariants\(verified_md, inv_ctx\)",
        src,
        re.MULTILINE,
    ), (
        "the sweep must be assigned back to verified_md — a copy-paste onto "
        "the wrong variable would defeat the whole point."
    )


# ---------------------------------------------------------------------------
# 1. Both sides, at runtime
# ---------------------------------------------------------------------------


_CV_TEXT = """\
Jane Smith — Sydney NSW

EXPERIENCE
Personal Care Worker, Sunnybrook Home, Jan 2020 - Present
- Delivered personal care including showering, dressing and grooming to residents.
- Provided medication assistance under RN supervision and clinical documentation.

Support Worker, Homefront Community Care, Jan 2018 - Dec 2019
- Supported elderly clients with personal care, meal preparation and transport.

EDUCATION
Certificate III in Individual Support (Ageing), TAFE NSW, 2018

CERTIFICATIONS
First Aid and CPR (HLTAID011), St John Ambulance, 2024
"""

_RAW_MD = """\
# Jane Smith
jane.smith@email.com | 0421 000 001 | Sydney NSW

## Career Highlights
Assistant in Nursing with 5 years delivering hands-on personal care in residential
aged care. Provided medication assistance under RN supervision at Sunnybrook Home
and personal care at Homefront Community Care, documenting observations daily.

## Skills
**Care Skills:** Personal Care, Medication Assistance, Clinical Documentation
**Soft Skills:** Empathy, Teamwork, Verbal Communication

## Professional Experience
### Sunnybrook Home
*Personal Care Worker | Jan 2020 – Present*
- Delivered personal care including showering, dressing and grooming to residents daily.
- Provided medication assistance under RN supervision and contributed to clinical documentation.

### Homefront Community Care
*Support Worker | Jan 2018 – Dec 2019*
- Supported elderly clients with personal care, meal preparation and community transport.

## Education
### TAFE NSW
*Certificate III in Individual Support (Ageing) | 2018*

## Certifications
- First Aid and CPR (HLTAID011) – St John Ambulance (2024)
"""

_UPSTREAM = {
    "jd_analysis": {"job_title": "Assistant in Nursing", "role_family": "nursing"},
    "matching": {},
    "ats": {"overall_score": 60},
    "input_recs": {},
    "feasibility": {},
}


def _recording_registry(log: list[tuple[str, str]], phase: dict) -> tuple[Invariant, ...]:
    """Wrap every invariant so applying it records (phase, name)."""

    def _wrap(inv: Invariant) -> Invariant:
        def _fn(md: str, ctx):  # noqa: ANN001 — mirrors InvariantFn
            log.append((phase["name"], inv.name))
            return inv.fn(md, ctx)

        return Invariant(inv.name, _fn)

    return tuple(_wrap(i) for i in INVARIANTS)


def test_every_invariant_runs_on_both_sides_of_verify_claims(monkeypatch) -> None:
    """The whole point. Not "these N passes re-run" — ALL of them, both sides.

    Runs the real ``_writer_w8_verified`` (composition + verify mocked) with
    an instrumented registry and compares the two sides as SETS. A pass that
    is applied pre-verify but not post-verify — the exact shape of every bug
    in PRs #249-#257 — fails here.
    """
    log: list[tuple[str, str]] = []
    phase = {"name": "pre"}
    monkeypatch.setattr(inv_mod, "INVARIANTS", _recording_registry(log, phase))

    async def _fake_verify(_client, markdown: str, _source_cv: str):
        phase["name"] = "post"
        return markdown, {}

    monkeypatch.setattr(_impl, "verify_claims", _fake_verify)

    client = MagicMock()
    client.complete = AsyncMock(return_value=_RAW_MD)

    asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client, _CV_TEXT, "Assistant in Nursing, residential aged care.",
            None, vertical="nursing", upstream=dict(_UPSTREAM),
        )
    )

    pre = [name for side, name in log if side == "pre"]
    post = [name for side, name in log if side == "post"]

    assert pre, "the pre-verify sweep never ran"
    assert post, "the post-verify sweep never ran"
    # Ordered equality, not just set equality: order is load-bearing (see the
    # constraints listed in the invariants module docstring), and an ordering
    # difference between the two sides is its own divergence.
    assert pre[: len(INVARIANT_NAMES)] == list(INVARIANT_NAMES)
    assert post[: len(INVARIANT_NAMES)] == list(INVARIANT_NAMES)
    assert set(pre) == set(post) == set(INVARIANT_NAMES)


def test_registry_names_are_unique() -> None:
    """Duplicate names would make the both-sides comparison lie."""
    assert len(set(INVARIANT_NAMES)) == len(INVARIANT_NAMES)


# ---------------------------------------------------------------------------
# 2. The set is a fixpoint
# ---------------------------------------------------------------------------


def _nursing_context():
    role_family = resolve_role_family("nursing", _UPSTREAM["jd_analysis"])
    return build_context(
        cv_text=_CV_TEXT,
        jd_text="Assistant in Nursing, residential aged care.",
        jd_analysis=_UPSTREAM["jd_analysis"],
        role_family=role_family,
        vertical="nursing",
        contact_details=None,
        feasibility={},
        matching={},
        jd_setting="residential",
    )


def test_invariants_are_a_fixpoint() -> None:
    """Applying the set twice must equal applying it once.

    "Apply it after every AI step" is only safe if the set is idempotent —
    otherwise the second sweep would compound (a cap trimming a line the
    injector just filled, an anchor appended twice). Any new pass that is
    not idempotent fails here rather than in a user's CV.
    """
    once = apply_invariants(_RAW_MD, _nursing_context())
    twice = apply_invariants(once, _nursing_context())
    assert twice == once


def test_each_invariant_is_individually_idempotent() -> None:
    """Localise the failure: report WHICH pass is not a fixpoint."""
    ctx = _nursing_context()
    md = _RAW_MD
    for inv in INVARIANTS:
        first = inv.fn(md, ctx)
        second = inv.fn(first, ctx)
        assert second == first, f"invariant {inv.name!r} is not idempotent"
        md = first


def test_a_failing_invariant_does_not_lose_the_cv(monkeypatch, caplog) -> None:
    """A repair pass that raises must not cost the user their whole CV."""
    def _boom(md, ctx):  # noqa: ANN001
        raise RuntimeError("pass exploded")

    monkeypatch.setattr(
        inv_mod, "INVARIANTS", (Invariant("boom", _boom),) + INVARIANTS,
    )
    out = apply_invariants(_RAW_MD, _nursing_context())
    assert "Sunnybrook Home" in out


# ---------------------------------------------------------------------------
# 3. The AI escalation is swept too
# ---------------------------------------------------------------------------


def test_summary_floor_rewrite_is_followed_by_a_sweep() -> None:
    """The floor retry is an AI call like any other.

    Before this refactor, only two passes (the availability stamp and the
    display heading) were re-applied after it — the same subset bug, one AI
    call later.
    """
    src = inspect.getsource(_impl._writer_w8_verified)
    floor_idx = src.index("_ensure_career_highlights_floor(")
    tail = src[floor_idx:]
    assert "apply_invariants(verified_md, inv_ctx)" in tail, (
        "no invariant sweep after the summary-floor AI rewrite"
    )


@pytest.mark.parametrize(
    "name",
    [
        # One per HIGH-severity gap listed in docs/POST_VERIFY_INVARIANTS.md.
        "strip_certs_when_projects_exist",
        "stamp_credentials",
        "stamp_references",
        "ensure_bachelor",
        "ensure_awards",
        # MEDIUM.
        "surface_matched_skills",
        "surface_cv_named_tools",
        "inject_missing_skills",
        "move_misplaced_technical_skills",
        "lowercase_generic_care_phrases",
        "promote_qualification_cert_to_education",
        "strip_education_bullets",
        # LOW.
        "dedup_career_highlights",
        "dedup_project_bullets",
        "enforce_education_count",
        "enforce_other_skills_chars",
        "flag_vague_anchor",
    ],
)
def test_documented_gap_is_closed(name: str) -> None:
    """Each of the 17 passes that had no post-verify counterpart."""
    assert_invariant_runs_after_verify(name)


# ---------------------------------------------------------------------------
# 4. Order is load-bearing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "earlier,later,why",
    [
        ("promote_qualification_cert_to_education", "strip_certs_when_excluded",
         "an AQF qualification must be promoted into Education BEFORE the "
         "Certifications section is wiped, or the qualification is lost"),
        ("strip_certs_when_excluded", "strip_certs_when_projects_exist",
         "the unconditional health-sector strip runs first; the "
         "projects-vs-certs rule is the narrower follow-up"),
        ("split_awards_and_certifications", "strip_certs_when_excluded",
         "the split can itself materialise a fresh ## Certifications heading "
         "out of mixed Awards content, which the strip must then see"),
        ("stamp_credentials", "split_awards_and_certifications",
         "the stamp must run first so the split can dedupe cert entries "
         "already listed under Registration & Licences"),
        ("recap_summary_preserving_anchors", "enforce_company_anchor",
         "the anchor pass appends and is budget-aware — capping after it "
         "would trim the employer anchor straight back off"),
        ("enforce_summary_s1_title_case", "enforce_summary_opener",
         "so an inserted JD title keeps the JD's own casing"),
        ("enforce_skills_section_before_inject", "inject_approved_skills",
         "the hard cap runs first so injection is cap-aware"),
        ("inject_approved_skills", "force_inject_missed_approved",
         "the regular injector runs first; force-inject is the safety net "
         "for what it dropped via a label mismatch"),
        ("enforce_other_skills_chars", "inject_missing_skills",
         "the 80-char cap runs BEFORE the injectors — capping after them "
         "truncates the keywords they just placed"),
    ],
)
def test_declared_ordering_constraint(earlier: str, later: str, why: str) -> None:
    """Each pair below cost a real incident. Reordering them silently is
    exactly the kind of change this list exists to make visible."""
    order = list(INVARIANT_NAMES)
    assert order.index(earlier) < order.index(later), why


def test_no_recap_after_the_injection_tail() -> None:
    """Nothing may re-cap the Skills section after the injectors run — that
    truncates the just-placed approved keywords off the tail (the pre-Fix-C
    regression)."""
    order = list(INVARIANT_NAMES)
    last_inject = order.index("force_inject_missed_approved")
    caps = [i for i, n in enumerate(order) if n.startswith("enforce_skills_section")]
    assert all(i < last_inject for i in caps), (
        "an enforce_skills_section cap runs after the injection tail"
    )


# ---------------------------------------------------------------------------
# 5. The two HIGH-severity gaps, demonstrated end-to-end
#
# Membership tests prove the wiring; these prove the user-visible behaviour.
# Both reproduce what verify_claims actually did in production: it rewrote a
# section that a deterministic pass had already fixed, and nothing fixed it
# again.
# ---------------------------------------------------------------------------


_TECH_MD = """\
# Alex Chen
alex.chen@email.com | 0421 000 002 | Sydney NSW

## Career Highlights
Backend engineer with 6 years building Python services. Delivered payment APIs at
Northwind Systems and event pipelines at Bluegum Labs, cutting p99 latency by half.

## Skills
**Technical Skills:** Python, PostgreSQL, Docker

## Professional Experience
### Northwind Systems
*Backend Engineer | Jan 2020 – Present*
- Built and shipped Python payment APIs handling high transaction volume daily.

## Projects
### Ledger Service
- Designed an event-sourced ledger service in Python with PostgreSQL storage.
"""

_TECH_CV = """\
Alex Chen — Sydney NSW

EXPERIENCE
Backend Engineer, Northwind Systems, Jan 2020 - Present
- Built and shipped Python payment APIs handling high transaction volume.

PROJECTS
Ledger Service — event-sourced ledger in Python with PostgreSQL.

CERTIFICATIONS
AWS Certified Solutions Architect, Amazon Web Services, 2023
"""


def _run_verified(monkeypatch, *, raw_md, cv_text, jd_analysis, vertical,
                  verify_returns, contact_details=None):
    """Run the real _writer_w8_verified with composition + verify mocked."""
    async def _fake_verify(_client, markdown: str, _source_cv: str):
        return verify_returns(markdown), {}

    monkeypatch.setattr(_impl, "verify_claims", _fake_verify)
    client = MagicMock()
    client.complete = AsyncMock(return_value=raw_md)
    upstream = {
        "jd_analysis": jd_analysis, "matching": {}, "ats": {"overall_score": 60},
        "input_recs": {}, "feasibility": {},
    }
    return asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client, cv_text, "Job description text.", contact_details,
            vertical=vertical, upstream=upstream,
        )
    )


def test_certifications_reintroduced_by_verify_claims_are_stripped_again(monkeypatch) -> None:
    """THE originally-reported bug (docs/POST_VERIFY_INVARIANTS.md, HIGH #1).

    ``_strip_certs_when_projects_exist`` ran pre-verify only. verify_claims
    can write a ``## Certifications`` section back into a CV that has a
    Projects section, and for every family except nursing nothing stripped it
    again.

    The reintroduced certificate is deliberately GROUNDED in the source CV,
    so the grounding gate cannot remove it: only the certs-vs-projects rule
    can, which is the pass under test. (An earlier draft of this test used a
    fabricated cert and passed even with the rule deleted.)
    """
    def _reintroduce(md: str) -> str:
        return md + "\n## Certifications\n- AWS Certified Solutions Architect (2023)\n"

    result = _run_verified(
        monkeypatch,
        raw_md=_TECH_MD,
        cv_text=_TECH_CV,
        jd_analysis={"job_title": "Backend Engineer", "role_family": "tech"},
        vertical="tech",
        verify_returns=_reintroduce,
    )
    assert "## Projects" in result.tailored_md
    assert "## Certifications" not in result.tailored_md
    assert "AWS Certified Solutions Architect" not in result.tailored_md


def test_credentials_rewritten_by_verify_claims_are_restamped(monkeypatch) -> None:
    """HIGH #2 — the user's own saved credentials are authoritative.

    ``stamp_credentials`` ran pre-verify only, so an AI rewrite of the
    Registration & Licences section could alter or drop the user's real
    credential data with nothing to restore it.

    The AI's replacement text is GROUNDED in the source CV (it is the
    candidate's real Certificate III), so no grounding/honesty pass can
    remove it — only re-stamping the user's saved profile can, which is the
    pass under test.
    """
    contact_details = {"credentials": {"police_check": True, "first_aid": True}}
    saved_line = "National Police Check · First Aid (HLTAID011)"
    ai_line = "Certificate III in Individual Support (Ageing)"

    def _rewrite_registration(md: str) -> str:
        out, skipping = [], False
        for line in md.split("\n"):
            if line.startswith("## Registration"):
                out.append(line)
                out.append("")
                out.append(ai_line)
                skipping = True
                continue
            if skipping:
                if line.startswith("## "):
                    skipping = False
                else:
                    continue
            out.append(line)
        return "\n".join(out)

    result = _run_verified(
        monkeypatch,
        raw_md=_RAW_MD + "\n## Registration & Licences\n\nPlaceholder\n",
        cv_text=_CV_TEXT,
        jd_analysis={"job_title": "Assistant in Nursing", "role_family": "nursing"},
        vertical="nursing",
        verify_returns=_rewrite_registration,
        contact_details=contact_details,
    )
    registration = result.tailored_md.split("## Registration & Licences", 1)[1]
    registration = registration.split("\n## ", 1)[0]
    assert saved_line in registration, result.tailored_md
    assert ai_line not in registration, result.tailored_md
