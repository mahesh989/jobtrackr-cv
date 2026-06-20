"""Phase 6 regression tests.

- extract_credentials_from_jd: deterministic JD-text scan for credentials/eligibility.
- _is_setting_descriptor: containment check for setting-experience phrases.
- Setting-experience strip: post_process routes "residential aged care facility experience" to setting_label.
- Conjunction-split: recall floor injects both "written communication" and "verbal communication"
  from a JD containing "written and verbal communication skills".
- Negative: "manual handling and infection control" does NOT spuriously expand.
"""
from __future__ import annotations

from app.services.skills.post_process import (
    _is_setting_descriptor,
    extract_credentials_from_jd,
    post_process_skills,
    enrich_required_skills_from_jd_body,
    post_process_jd_analysis,
)


# ---------------------------------------------------------------------------
# _is_setting_descriptor
# ---------------------------------------------------------------------------

def test_is_setting_descriptor_exact():
    assert _is_setting_descriptor("aged care") is True
    assert _is_setting_descriptor("residential aged care") is True
    assert _is_setting_descriptor("home care") is True
    assert _is_setting_descriptor("community care") is True


def test_is_setting_descriptor_with_experience():
    assert _is_setting_descriptor("residential aged care facility experience") is True
    assert _is_setting_descriptor("residential aged care experience") is True
    assert _is_setting_descriptor("aged care experience") is True


def test_is_setting_descriptor_false():
    assert _is_setting_descriptor("personal care") is False
    assert _is_setting_descriptor("health monitoring") is False
    assert _is_setting_descriptor("activities of daily living") is False


# ---------------------------------------------------------------------------
# extract_credentials_from_jd
# ---------------------------------------------------------------------------

_NURSING_JD = """
Assistant in Nursing

Requirements:
- Certificate III in Individual Support (Ageing) required.
- Certificate IV in Aged Care is highly desirable.
- Current NDIS Worker Screening Check.
- Valid working rights in Australia.
- Police check required.
- Covid vaccination required.
"""


def test_extract_credentials_cert_iii_required():
    out = extract_credentials_from_jd(_NURSING_JD)
    req_lower = [r.lower() for r in out["required"]]
    assert any("certificate iii" in r for r in req_lower)


def test_extract_credentials_cert_iv_preferred():
    out = extract_credentials_from_jd(_NURSING_JD)
    pref_lower = [p.lower() for p in out["preferred"]]
    assert any("certificate iv" in p for p in pref_lower)


def test_extract_credentials_eligibility():
    out = extract_credentials_from_jd(_NURSING_JD)
    # Police check and working rights should be in eligibility
    elig_lower = [e.lower() for e in out["eligibility"]]
    assert any("police" in e or "working rights" in e or "ndis" in e for e in elig_lower)


def test_extract_credentials_no_false_positives():
    """Skills should not appear in credentials."""
    out = extract_credentials_from_jd("Requirements: personal care and empathy.\n")
    all_creds = out["required"] + out["preferred"] + out["eligibility"]
    assert not any("personal care" in c.lower() for c in all_creds)
    assert not any("empathy" in c.lower() for c in all_creds)


def test_extract_credentials_empty_jd():
    out = extract_credentials_from_jd("")
    assert out == {"required": [], "preferred": [], "eligibility": []}


# ---------------------------------------------------------------------------
# Setting-experience strip via post_process_skills
# ---------------------------------------------------------------------------

def test_setting_experience_stripped_from_skills():
    """'residential aged care facility experience' must not survive as a skill."""
    cleaned, sidecar = post_process_skills(
        {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": ["residential aged care facility experience", "personal care"],
        },
        role_family_id="nursing",
    )
    all_skills = (
        cleaned["technical"] + cleaned["soft_skills"] + cleaned["domain_knowledge"]
    )
    all_lower = [s.lower() for s in all_skills]
    assert "residential aged care facility experience" not in all_lower
    assert any("personal care" in s for s in all_lower)
    assert len(sidecar["setting_label"]) >= 1


def test_setting_experience_in_job_context():
    """post_process_jd_analysis must route the phrase to job_context, not skills."""
    analysis = {
        "summary": "",
        "responsibilities": [],
        "required_skills": {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": ["residential aged care facility experience", "personal care"],
        },
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "skill_evidence": {},
    }
    out = post_process_jd_analysis(analysis, role_family_id="nursing")
    dk = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
    assert "residential aged care facility experience" not in dk
    assert out["job_context"]["setting"] is not None


# ---------------------------------------------------------------------------
# Conjunction-split recall: "written and verbal communication skills"
# ---------------------------------------------------------------------------

def _empty_analysis():
    return {
        "summary": "",
        "responsibilities": [],
        "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "skill_evidence": {},
    }


def test_conjunction_split_injects_both():
    jd = "Requirements: written and verbal communication skills are essential."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), jd, role_family_id="nursing", skill_text=jd,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    assert "written communication" in soft
    assert "verbal communication" in soft


def test_conjunction_split_no_false_positive():
    """'manual handling and infection control' must NOT expand to spurious skills."""
    jd = "Requirements: manual handling and infection control procedures."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), jd, role_family_id="nursing", skill_text=jd,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    # Neither "manual handling communication" nor similar should appear
    assert not any("communication" in s for s in soft)


# ---------------------------------------------------------------------------
# Contract: all prior top-level keys preserved
# ---------------------------------------------------------------------------

def test_phase6_contract_keys():
    out = post_process_jd_analysis(_empty_analysis(), role_family_id="master")
    for key in ("required_skills", "preferred_skills", "skill_evidence", "lexicon_meta",
                "credentials", "job_context"):
        assert key in out
