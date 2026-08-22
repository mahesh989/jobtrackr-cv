"""C67 regression guards for the final CV honesty path.

These findings share one boundary: deterministic/AI honesty work can be
undone by a later pass.  The tests intentionally pin that ordering and the
already-resolved nursing subtype rather than adding another abstraction.
"""
from __future__ import annotations

import asyncio
import inspect
import re
from unittest.mock import AsyncMock, MagicMock

from app.services.eval.writers import _impl
from app.services.eval.writers.invariants import INVARIANT_NAMES
from app.services.eval.writers.bullet_rewrites import _targeted_bullet_rewrites
from app.services.eval.writers.honesty_guard import (
    filter_irrelevant_roles_pre,
    pin_skills_section_labels,
)
from app.services.pipeline.steps.tailored_cv import _enforce_company_anchor


_THREE_ROLE_CV = """\
## Experience
### Alpha Aged Care
*Assistant in Nursing | Jan 2024 – Present*
- Provided personal care and medication assistance.

### Dimeo Cleaning
*Cleaner | Jan 2022 – Dec 2023*
- Delivered commercial cleaning and floor care.

### Beta Care Home
*Personal Care Worker | Jan 2020 – Dec 2021*
- Supported residents with personal care and daily living.
"""

_UNANCHORED_SUMMARY = """\
## Professional Summary
Care professional supporting residents. Delivers safe personal care and documentation.

## Experience
"""


def test_targeted_bullet_rewrites_are_verified_before_delivery() -> None:
    """The last AI rewrite must feed into verify_claims, never run after it."""
    src = inspect.getsource(_impl._writer_w8_verified)
    rewrite_idx = src.index("_targeted_bullet_rewrites(")
    verify_idx = src.index("verify_claims(client")
    assert rewrite_idx < verify_idx


def test_targeted_rewrite_never_selects_a_certifications_bullet() -> None:
    """Only sections collected by verify_claims may be AI-rewritten."""
    md = """\
## Certifications
- National Police Check completed for community support work.

## Skills
- **Care Skills:** Personal Care
"""
    client = MagicMock()
    client.complete = AsyncMock(
        return_value=(
            "National Police Check completed while leading 50 staff with a "
            "40% incident reduction."
        )
    )
    feasibility = {
        "feasibility_plan": {
            "inject_as_extension": [
                {
                    "keyword": "strategic leadership",
                    "evidence": "National Police Check completed community support work",
                }
            ]
        }
    }

    out = asyncio.get_event_loop().run_until_complete(
        _targeted_bullet_rewrites(client, md, feasibility)
    )
    assert out == md
    client.complete.assert_not_called()


def test_targeted_rewrite_never_selects_a_bullet_beyond_verifier_limit() -> None:
    """Bullet 41 cannot be rewritten when verify_claims checks only 1-40."""
    ordinary = "\n".join(
        f"- Routine support duty item {i}." for i in range(1, 41)
    )
    md = (
        "## Experience\n"
        f"{ordinary}\n"
        "- Coordinated zirconium orchard falcon documentation.\n"
    )
    client = MagicMock()
    client.complete = AsyncMock(
        return_value=(
            "Coordinated zirconium orchard falcon documentation while leading "
            "50 staff and reducing incidents by 40%."
        )
    )
    feasibility = {
        "feasibility_plan": {
            "inject_as_extension": [
                {
                    "keyword": "strategic leadership",
                    "evidence": "Coordinated zirconium orchard falcon documentation",
                }
            ]
        }
    }

    out = asyncio.get_event_loop().run_until_complete(
        _targeted_bullet_rewrites(client, md, feasibility)
    )
    assert out == md
    client.complete.assert_not_called()


def test_targeted_rewrite_rejects_multiline_responses() -> None:
    """One input bullet cannot expand into unchecked bullet/prose lines."""
    md = """\
## Experience
- Coordinated resident documentation and handovers.
"""
    feasibility = {
        "feasibility_plan": {
            "inject_as_extension": [
                {
                    "keyword": "strategic leadership",
                    "evidence": "Coordinated resident documentation and handovers",
                }
            ]
        }
    }

    for extra_line in (
        "- Led 50 staff and reduced incidents by 40%.",
        "Led 50 staff and reduced incidents by 40%.",
    ):
        client = MagicMock()
        client.complete = AsyncMock(
            return_value=(
                "Coordinated resident documentation with strategic leadership.\n"
                + extra_line
            )
        )
        out = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, md, feasibility)
        )
        assert out == md
        client.complete.assert_called_once()


def test_targeted_rewrite_output_is_the_markdown_received_by_verifier(monkeypatch) -> None:
    """Pin the runtime data flow, not only the source-order of the two calls."""
    md = """\
## Professional Summary
Care professional supporting residents. Delivers safe personal care and documentation.

## Experience
- Provided personal care to residents including bathing and dressing.
"""
    result = _impl.WriterResult(
        tailored_md=md,
        jd_analysis={"job_title": "Assistant in Nursing"},
        matching={},
        initial_ats_internal={},
        feasibility={
            "feasibility_plan": {
                "inject_as_extension": [
                    {
                        "keyword": "home care",
                        "evidence": "Provided personal care residents bathing dressing",
                    }
                ]
            }
        },
        extras={"role_family": "nursing"},
    )
    monkeypatch.setattr(_impl, "_writer_w8_integrated", AsyncMock(return_value=result))

    seen: dict[str, str] = {}

    async def _capture_verify(_client, markdown: str, source_cv: str):
        seen["markdown"] = markdown
        return markdown, {}

    monkeypatch.setattr(_impl, "verify_claims", _capture_verify)
    client = MagicMock()
    client.complete = AsyncMock(
        return_value="Provided home care to residents including bathing and dressing."
    )

    asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client=client,
            cv_text=_THREE_ROLE_CV,
            jd_text="Assistant in Nursing role",
            contact_details=None,
            vertical="nursing",
        )
    )

    assert "Provided home care" in seen["markdown"]


def test_final_company_anchor_uses_the_pre_filtered_cv() -> None:
    """A role deliberately dropped before composition cannot be re-anchored."""
    filtered_cv, dropped = filter_irrelevant_roles_pre(_THREE_ROLE_CV, "nursing")
    assert dropped == ["Dimeo Cleaning"]

    # Characterise the actual harm: the unfiltered source chooses the deleted
    # employer as a top-two summary anchor; the filtered source does not.
    unsafe = _enforce_company_anchor(_UNANCHORED_SUMMARY, _THREE_ROLE_CV)
    safe = _enforce_company_anchor(_UNANCHORED_SUMMARY, filtered_cv)
    assert "Dimeo Cleaning" in unsafe
    assert "Dimeo Cleaning" not in safe
    assert "Beta Care Home" in safe

    # Pin the production wiring, where the regression lived. The anchor pass
    # now runs from the declared invariant set, which grounds every pass on
    # the ROLE-FILTERED cv_text — so the assertion is that the post-verify
    # sweep is built on the filtered view, not on the raw cv_text argument.
    src = inspect.getsource(_impl._writer_w8_verified)
    assert "anchor_cv_text, _ = filter_irrelevant_roles_pre(cv_text, vertical)" in src
    assert "enforce_company_anchor" in INVARIANT_NAMES
    assert re.search(r"build_invariant_context\(\s*\n\s*cv_text=anchor_cv_text,", src), (
        "the post-verify invariant context must be built on the role-filtered "
        "CV view — building it on the raw cv_text lets the anchor pass name an "
        "employer that was deliberately dropped before composition"
    )


_FULL_SOURCE_CV = """\
## Professional Summary
Dedicated aged care professional with hands-on experience at Alpha Aged Care
and Beta Care Home. Delivers safe, person-centred personal care.

## Skills
Personal care, medication assistance, manual handling, documentation

## Experience
### Alpha Aged Care
*Assistant in Nursing | Jan 2024 – Present*
- Provided personal care and medication assistance to residents.
- Documented care delivery in line with facility policy.

### Beta Care Home
*Personal Care Worker | Jan 2020 – Dec 2021*
- Supported residents with personal care and daily living activities.

## Awards
- Employee of the Month, Alpha Aged Care, 2024
"""


def test_writer_w8_verified_runs_end_to_end_and_returns_verified_output(monkeypatch) -> None:
    """C67: every other test in this file exercises _writer_w8_verified for
    its intermediate data flow (what verify_claims receives, how the anchor
    is chosen) but none of them capture and assert on its actual RETURN
    VALUE — the default production writer's full deterministic
    post-processing chain (S1 bridge, honesty guards, skills hygiene,
    awards normalisation, display-heading pass, ...) has never been run
    end-to-end and checked against realistic output. This runs the whole
    function against a realistic multi-section CV and asserts the final
    result is well-formed and hasn't lost its honesty-critical content."""
    result = _impl.WriterResult(
        tailored_md=_FULL_SOURCE_CV,
        jd_analysis={"job_title": "Assistant in Nursing"},
        matching={},
        initial_ats_internal={},
        feasibility={},
        extras={"role_family": "nursing"},
    )
    monkeypatch.setattr(_impl, "_writer_w8_integrated", AsyncMock(return_value=result))

    async def _verify_noop(_client, markdown: str, _source_cv: str):
        # verify_claims is the one real AI entailment step in this chain —
        # stub it as a no-op repair (returns input unchanged) so this test
        # exercises _writer_w8_verified's own deterministic chain around
        # it, not verify.py's own logic (which has its own dedicated tests).
        return markdown, {"checked": 0, "repaired": 0, "dropped": 0}

    monkeypatch.setattr(_impl, "verify_claims", _verify_noop)

    client = MagicMock()
    client.complete = AsyncMock(return_value="")  # no bullets queued for targeted rewrite

    final = asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client=client,
            cv_text=_FULL_SOURCE_CV,
            jd_text="Assistant in Nursing — residential aged care role.",
            contact_details=None,
            vertical="nursing",
        )
    )

    assert isinstance(final, _impl.WriterResult)
    assert final.tailored_md, "the default writer must not return empty output"
    # Structural sanity — the chain must not have dropped whole sections.
    assert "## Experience" in final.tailored_md
    assert "Alpha Aged Care" in final.tailored_md
    assert "Beta Care Home" in final.tailored_md
    # Honesty-critical: real employer names must survive the full
    # honesty-guard + re-run gauntlet, not just the first pass.
    assert "verify" in final.extras
    assert final.extras["verify"] == {"checked": 0, "repaired": 0, "dropped": 0}


def test_verifier_receives_the_same_pre_filtered_cv_as_the_final_anchor(monkeypatch) -> None:
    """The verifier cannot repair a summary with an intentionally removed role."""
    result = _impl.WriterResult(
        tailored_md=_UNANCHORED_SUMMARY,
        jd_analysis={"job_title": "Assistant in Nursing"},
        matching={},
        initial_ats_internal={},
        feasibility={"feasibility_plan": {}},
        extras={"role_family": "nursing"},
    )
    monkeypatch.setattr(_impl, "_writer_w8_integrated", AsyncMock(return_value=result))

    seen: dict[str, str] = {}

    async def _capture_verify(_client, markdown: str, source_cv: str):
        seen["markdown"] = markdown
        seen["source_cv"] = source_cv
        return markdown, {}

    monkeypatch.setattr(_impl, "verify_claims", _capture_verify)

    asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client=MagicMock(),
            cv_text=_THREE_ROLE_CV,
            jd_text="Assistant in Nursing role",
            contact_details=None,
            vertical="nursing",
        )
    )

    assert "Dimeo Cleaning" not in seen["source_cv"]
    assert "Alpha Aged Care" in seen["source_cv"]
    assert "Beta Care Home" in seen["source_cv"]


def test_nursing_clinical_subtype_keeps_the_clinical_skills_label() -> None:
    """Resolved clinical nursing roles must not be flattened to Care Skills."""
    md = "## Skills\n- **Care Skills:** Wound Care, Medication Administration\n"
    out, notes = pin_skills_section_labels(
        md,
        "nursing",
        resolved_headline_label="Clinical Skills",
    )
    assert "**Clinical Skills:**" in out
    assert "**Care Skills:**" not in out
    assert notes == ["Skills label: 'Care Skills' → 'Clinical Skills'"]


def test_writer_passes_the_resolved_clinical_subtype_to_label_pinning(monkeypatch) -> None:
    """The production path, not just the helper, must preserve Clinical Skills."""
    result = _impl.WriterResult(
        tailored_md=(
            "## Professional Summary\n"
            "Registered nurse supporting safe care. Delivers medication and documentation.\n\n"
            "## Skills\n- **Care Skills:** Wound Care, Medication Administration\n"
        ),
        jd_analysis={"job_title": "Registered Nurse"},
        matching={},
        initial_ats_internal={},
        feasibility={"feasibility_plan": {}},
        extras={"role_family": "nursing"},
    )
    monkeypatch.setattr(_impl, "_writer_w8_integrated", AsyncMock(return_value=result))
    monkeypatch.setattr(
        _impl,
        "verify_claims",
        AsyncMock(side_effect=lambda _client, markdown, _cv: (markdown, {})),
    )

    out = asyncio.get_event_loop().run_until_complete(
        _impl._writer_w8_verified(
            client=MagicMock(),
            cv_text=_THREE_ROLE_CV,
            jd_text="Registered Nurse role",
            contact_details=None,
            vertical="nursing",
        )
    )

    assert "**Clinical Skills:**" in out.tailored_md
    assert "**Care Skills:**" not in out.tailored_md
