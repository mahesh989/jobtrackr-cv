"""Regression tests for role-family routing (resolve_role_family).

Origin incident (Rashmi / Moran, 2026-06-27): explicit-vertical routing mapped
a "general" profile hint straight to the `master` family, short-circuiting the
JD-based detection below it. A clearly-nursing aged-care JD filed under a
"general" search profile was therefore composed with the generic `master` role
pack (Projects section, "Professional Experience" heading) instead of the
nursing pack — the composer then dropped the candidate's real experience and
regurgitated the prompt's worked example.

The contract these tests pin:
  - A SPECIFIC explicit hint (nursing/tech/manual + aliases) is authoritative.
  - A GENERIC hint ("general"/"other"/"master"/"") is NOT a vertical: it falls
    through to JD detection, then to the master fallback only when the JD is
    genuinely ambiguous.
"""
from __future__ import annotations

from app.services.eval.role_families import resolve_role_family

_NURSING_JD = {
    "job_title": "Carer / Assistant in Nursing",
    "summary": (
        "Aged care carer supporting older residents with personal care and "
        "activities of daily living in a residential aged care home"
    ),
    "responsibilities": ["personal care", "medication assistance", "dementia support"],
}
_TECH_JD = {
    "job_title": "Data Analyst",
    "summary": "SQL Python dashboards data pipelines analytics",
    "responsibilities": ["build dashboards", "etl"],
}
_AMBIGUOUS_JD = {
    "job_title": "Coordinator",
    "summary": "general office coordination",
    "responsibilities": ["scheduling"],
}


class TestGenericHintFallsThroughToJd:
    """The regression: generic hints must NOT suppress JD detection."""

    def test_general_hint_with_nursing_jd_routes_nursing(self):
        # Exactly the Moran case — must NOT return master.
        assert resolve_role_family("general", _NURSING_JD).id == "nursing"

    def test_other_and_master_hints_also_fall_through(self):
        assert resolve_role_family("other", _NURSING_JD).id == "nursing"
        assert resolve_role_family("master", _NURSING_JD).id == "nursing"

    def test_empty_and_none_hints_fall_through(self):
        assert resolve_role_family("", _NURSING_JD).id == "nursing"
        assert resolve_role_family(None, _NURSING_JD).id == "nursing"

    def test_general_hint_with_tech_jd_routes_tech(self):
        assert resolve_role_family("general", _TECH_JD).id == "tech"

    def test_general_hint_with_ambiguous_jd_falls_back_to_master(self):
        assert resolve_role_family("general", _AMBIGUOUS_JD).id == "master"


class TestSpecificHintIsAuthoritative:
    """ac1b772's intent stays: an explicit specific vertical overrides the JD."""

    def test_nursing_hint_wins_over_tech_jd(self):
        assert resolve_role_family("nursing", _TECH_JD).id == "nursing"

    def test_tech_hint_wins_over_nursing_jd(self):
        assert resolve_role_family("tech", _NURSING_JD).id == "tech"

    def test_manual_hint_routes_manual(self):
        assert resolve_role_family("manual", _NURSING_JD).id == "manual"

    def test_alias_hints_route_to_their_family(self):
        assert resolve_role_family("healthcare", _TECH_JD).id == "nursing"
        assert resolve_role_family("it", _NURSING_JD).id == "tech"
        assert resolve_role_family("cleaner", _NURSING_JD).id == "manual"
