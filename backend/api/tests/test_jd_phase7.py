"""Phase 7 regression tests.

Follow-up fixes after the second AIN run:
- Merged credentials split: "Minimum Certificate III in Aged Care, Certificate IV
  highly desirable" → Cert III (required) + Cert IV (preferred), "Minimum" stripped.
- Vaccination routed to eligibility, not required credentials.
- Values/motivational fluff ("making a positive difference") dropped from skills.
"""
from __future__ import annotations

from app.services.skills.post_process import (
    extract_credentials_from_jd,
    post_process_skills,
    _is_fluff_phrase,
)


# ---------------------------------------------------------------------------
# Credential clause splitting
# ---------------------------------------------------------------------------

_MERGED_JD = (
    "Requirements:\n"
    "Minimum Certificate III in Aged Care, Certificate IV highly desirable.\n"
    "Current Covid-19 Vaccination required.\n"
    "Valid working rights in Australia.\n"
)


def test_merged_credentials_split():
    out = extract_credentials_from_jd(_MERGED_JD)
    req = [r.lower() for r in out["required"]]
    pref = [p.lower() for p in out["preferred"]]
    # Cert III is the "minimum" → required, without a merged Cert IV tail
    assert any("certificate iii" in r for r in req)
    assert not any("certificate iv" in r for r in req)
    # Cert IV is "highly desirable" → preferred
    assert any("certificate iv" in p for p in pref)


def test_leading_minimum_stripped():
    out = extract_credentials_from_jd(_MERGED_JD)
    assert not any(r.lower().startswith("minimum") for r in out["required"])


def test_preferred_marker_not_in_phrase():
    """'highly desirable' must not bleed into the captured credential phrase."""
    out = extract_credentials_from_jd(_MERGED_JD)
    assert not any("desirable" in p.lower() for p in out["preferred"])


# ---------------------------------------------------------------------------
# Vaccination → eligibility
# ---------------------------------------------------------------------------

def test_vaccination_routes_to_eligibility():
    out = extract_credentials_from_jd(_MERGED_JD)
    elig = [e.lower() for e in out["eligibility"]]
    assert any("vaccin" in e for e in elig)
    # And NOT in required/preferred credentials
    assert not any("vaccin" in c.lower() for c in out["required"] + out["preferred"])


def test_working_rights_still_eligibility():
    out = extract_credentials_from_jd(_MERGED_JD)
    elig = [e.lower() for e in out["eligibility"]]
    assert any("working rights" in e for e in elig)


# ---------------------------------------------------------------------------
# Fluff filter
# ---------------------------------------------------------------------------

def test_is_fluff_phrase():
    assert _is_fluff_phrase("making a positive difference") is True
    assert _is_fluff_phrase("make a difference") is True
    assert _is_fluff_phrase("teamwork") is False
    assert _is_fluff_phrase("written communication") is False


def test_fluff_dropped_from_skills():
    cleaned, sidecar = post_process_skills(
        {
            "technical": [],
            "soft_skills": ["teamwork", "making a positive difference", "written communication"],
            "domain_knowledge": [],
        },
        role_family_id="nursing",
    )
    soft = [s.lower() for s in cleaned["soft_skills"]]
    assert "making a positive difference" not in soft
    assert "teamwork" in soft
    assert "written communication" in soft
    assert any("positive difference" in n.lower() for n in sidecar["noise"])
