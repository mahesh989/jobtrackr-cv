"""Post-verify summary repairs.

verify_claims is an AI step that REWRITES the summary, not merely strips
from it. Three defects all trace to the same structural gap — the
deterministic summary enforcers run BEFORE it and nothing re-read the
result afterwards:

  * a phrase left cut off mid-way ("electronic medication <gone>"),
  * S2 coming back over its 22-word cap,
  * (see test_career_highlights_floor.py) the 35-word floor.
"""
from __future__ import annotations

import re

from app.services.eval.writers.career_highlights import summary_looks_garbled
from app.services.pipeline.steps.tailored_cv import recap_s2_preserving_anchors


def _md(prose: str, *, experience: str = "") -> str:
    return f"## Professional Summary\n\n{prose}\n\n## Experience\n{experience}"


_EXPERIENCE = (
    "### Jesmond Miranda Nursing Home | Miranda, NSW\n"
    "*Assistant in Nursing | May 2025 – Present*\n\n"
    "- Serve as primary Medication Assistant.\n"
    "### Anglicare Mildred Symons House | Jannali, NSW\n"
    "*Assistant in Nursing | Jan 2024 – Dec 2024*\n\n"
    "- Delivered dementia care.\n"
)


class TestSummaryLooksGarbled:
    def test_detects_both_real_production_garbles(self):
        # Verbatim from two live runs. Both are "electronic medication
        # administration" with the head noun deleted and the next clause
        # pulled forward.
        for prose in (
            "Assistant in Nursing with aged care experience. Experienced in "
            "accurate electronic medication emergency response while "
            "supporting hygiene at X.",
            "Assistant in Nursing with recent experience. Provides accurate "
            "electronic medication high-quality care while maintaining "
            "safety at X.",
        ):
            assert summary_looks_garbled(_md(prose)) == "electronic medication"

    def test_intact_phrase_is_not_flagged(self):
        prose = (
            "Assistant in Nursing with aged care experience. Maintains "
            "accurate electronic medication administration and follows "
            "safety protocols at X."
        )
        assert summary_looks_garbled(_md(prose)) is None

    def test_prose_without_any_care_phrase_is_not_flagged(self):
        prose = (
            "Data Analyst with six years in SaaS. Delivered dashboards and "
            "reporting at TechCorp."
        )
        assert summary_looks_garbled(_md(prose)) is None

    def test_detects_a_cut_activities_of_daily_living(self):
        prose = "AIN specialising in activities of daily support. Supports residents at X."
        assert summary_looks_garbled(_md(prose)) == "activities of daily"

    def test_intact_activities_of_daily_living_is_not_flagged(self):
        prose = "AIN specialising in activities of daily living. Supports residents at X."
        assert summary_looks_garbled(_md(prose)) is None


def _s2(md: str) -> str:
    body = md.split("## Professional Summary")[1].split("## Experience")[0]
    prose = " ".join(
        l.strip() for l in body.split("\n")
        if l.strip() and not l.strip().startswith(("-", "*"))
    )
    return re.split(r"(?<=[.!?])\s+", prose)[1]


class TestRecapS2PreservingAnchors:
    def test_over_cap_s2_is_trimmed_when_no_anchor_is_at_risk(self):
        prose = (
            "Assistant in Nursing with aged care experience across residential "
            "settings. Delivered personal care, hygiene support, mobility "
            "assistance, feeding support, accurate documentation, safety "
            "checks, and continence support for elderly residents on every "
            "rostered shift across the facility."
        )
        md = _md(prose)
        assert len(_s2(md).split()) > 22, f"fixture is only {len(_s2(md).split())}w"
        out = recap_s2_preserving_anchors(md)
        assert len(_s2(out).split()) <= 22

    def test_trim_is_skipped_when_it_would_drop_an_employer_anchor(self):
        # Real case: a 23-word S2 naming BOTH employers. The plain cap trims
        # from the end, which is exactly where the anchor sits — a one-word
        # overage must not cost an employer name.
        prose = (
            "Assistant in Nursing with aged care experience in residential "
            "settings. Demonstrated dedication by delivering safe, "
            "person-centred support, accurate documentation, and collaborative "
            "multidisciplinary care at Jesmond Miranda Nursing Home and "
            "Anglicare Mildred Symons House."
        )
        md = _md(prose, experience=_EXPERIENCE)
        out = recap_s2_preserving_anchors(md)
        assert out == md, "must no-op rather than trim off an anchor"
        assert "Anglicare Mildred Symons House" in _s2(out)
        assert "Jesmond Miranda Nursing Home" in _s2(out)

    def test_within_cap_is_untouched(self):
        prose = (
            "Assistant in Nursing with aged care experience. Delivered "
            "person-centred care at Jesmond Miranda Nursing Home."
        )
        md = _md(prose, experience=_EXPERIENCE)
        assert recap_s2_preserving_anchors(md) == md

    def test_no_summary_is_a_no_op(self):
        assert recap_s2_preserving_anchors("## Skills\n- x\n") == "## Skills\n- x\n"


# ---------------------------------------------------------------------------
# Awards emitted in the EXPERIENCE entry shape.
#
# The composer's global OUTPUT SHAPE rule says "the H3 line holds the
# org/place, the italic line holds the role/dates". The writer intermittently
# applies that to an award, putting the EMPLOYER on the h3 and the award name
# in the italic line. Parsed literally that promotes the employer to the award
# title and demotes the award to its own description — observed verbatim in a
# production run as "* Jesmond Miranda Nursing Home, Miranda (Aug 2025) /
# Staff Excellence Award."
# ---------------------------------------------------------------------------

from app.services.eval.writers.awards import _normalise_awards_entries


def _awards_body(md: str) -> str:
    return md.split("## Awards", 1)[1].strip()


def test_award_in_experience_shape_is_repaired():
    md = (
        "## Awards\n\n"
        "### Jesmond Miranda Nursing Home | Miranda\n"
        "*Staff Excellence Award | August 2025*\n"
    )
    body = _awards_body(_normalise_awards_entries(md))
    assert body.startswith("* Staff Excellence Award, Jesmond Miranda Nursing Home")
    assert "(August 2025)" in body


def test_correctly_shaped_award_is_unchanged():
    md = (
        "## Awards\n\n"
        "- Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)\n"
        "  Recognised for hard work, caring nature, and positive attitude.\n"
    )
    body = _awards_body(_normalise_awards_entries(md))
    assert body.startswith("* Staff Excellence Award, Jesmond Miranda Nursing Home")
    assert "Recognised for hard work" in body


def test_h3_name_with_italic_description_still_works():
    md = (
        "## Awards\n\n"
        "### Staff Excellence Award, Jesmond Miranda Nursing Home | Miranda\n"
        "*Recognised for hard work, caring nature, and positive attitude | August 2025*\n"
    )
    body = _awards_body(_normalise_awards_entries(md))
    assert body.startswith("* Staff Excellence Award, Jesmond Miranda Nursing Home")
    assert "Recognised for hard work" in body


def test_repair_does_not_fire_without_award_vocabulary():
    # "Dean's List" carries no award keyword and neither does its description,
    # so there is nothing to promote — the entry must be left exactly as-is.
    md = (
        "## Awards\n\n"
        "- Dean's List, University of Sydney (2021)\n"
        "  Top 5% of cohort.\n"
    )
    body = _awards_body(_normalise_awards_entries(md))
    assert body.startswith("* Dean's List, University of Sydney")
    assert "Top 5% of cohort" in body


def test_repair_is_idempotent():
    md = (
        "## Awards\n\n"
        "### Jesmond Miranda Nursing Home | Miranda\n"
        "*Staff Excellence Award | August 2025*\n"
    )
    once = _normalise_awards_entries(md)
    assert _normalise_awards_entries(once) == once
