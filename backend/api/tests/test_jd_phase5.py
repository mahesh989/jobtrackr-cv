"""Phase 5 regression tests.

- _build_credentials_block assembles required/preferred/eligibility from sidecars.
- _build_job_context picks setting labels from sidecars.
- post_process_jd_analysis emits top-level `credentials` and `job_context` fields.
- Soft-skill recall floor: literal canonicals are injected; cross-family blocked.
"""
from __future__ import annotations

from app.services.skills.post_process import (
    _build_credentials_block,
    _build_job_context,
    enrich_required_skills_from_jd_body,
    post_process_jd_analysis,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _empty_sidecar():
    return {
        "credential": [],
        "eligibility": [],
        "noise": [],
        "unknown": [],
        "moved": [],
        "setting_label": [],
    }


def _empty_analysis():
    return {
        "summary": "",
        "responsibilities": [],
        "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "skill_evidence": {},
    }


# ---------------------------------------------------------------------------
# _build_credentials_block
# ---------------------------------------------------------------------------

def test_credentials_block_required_and_preferred():
    req = {**_empty_sidecar(), "credential": ["Certificate III in Aged Care"]}
    pref = {**_empty_sidecar(), "credential": ["Certificate IV in Aged Care"]}
    out = _build_credentials_block(req, pref)
    assert out["required"] == ["Certificate III in Aged Care"]
    assert out["preferred"] == ["Certificate IV in Aged Care"]
    assert out["eligibility"] == []


def test_credentials_block_eligibility_merged():
    req = {**_empty_sidecar(), "eligibility": ["valid working rights"]}
    pref = {**_empty_sidecar(), "eligibility": ["current NDIS check"]}
    out = _build_credentials_block(req, pref)
    assert "valid working rights" in out["eligibility"]
    assert "current NDIS check" in out["eligibility"]


def test_credentials_block_dedup():
    req = {**_empty_sidecar(), "credential": ["cert iii", "cert iii"]}
    pref = {**_empty_sidecar(), "credential": []}
    out = _build_credentials_block(req, pref)
    assert out["required"].count("cert iii") == 1


def test_credentials_block_empty():
    out = _build_credentials_block(_empty_sidecar(), _empty_sidecar())
    assert out == {"required": [], "preferred": [], "eligibility": []}


# ---------------------------------------------------------------------------
# _build_job_context
# ---------------------------------------------------------------------------

def test_job_context_setting_first():
    req = {**_empty_sidecar(), "setting_label": ["residential aged care", "aged care"]}
    out = _build_job_context(req, _empty_sidecar())
    assert out["setting"] == "residential aged care"
    assert "aged care" in out["settings"]


def test_job_context_empty():
    out = _build_job_context(_empty_sidecar(), _empty_sidecar())
    assert out["setting"] is None
    assert out["settings"] == []


# ---------------------------------------------------------------------------
# post_process_jd_analysis — top-level fields
# ---------------------------------------------------------------------------

def test_post_process_emits_credentials_and_job_context():
    """post_process_jd_analysis must attach top-level credentials and job_context."""
    analysis = {
        "job_title": "Assistant in Nursing",
        "seniority_level": "entry",
        "summary": "Provide care in residential aged care.",
        "responsibilities": [],
        "experience_years_required": None,
        "required_skills": {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": [
                "Certificate III in Aged Care",   # credential — should be stripped
                "residential aged care",           # setting label — should be stripped
                "personal care",
            ],
        },
        "preferred_skills": {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": ["Certificate IV in Aged Care"],  # credential
        },
        "skill_evidence": {},
    }
    out = post_process_jd_analysis(analysis, role_family_id="nursing")

    assert "credentials" in out
    assert "job_context" in out

    # Certificate III must have been stripped from skills and appear in credentials.required
    dk_req = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
    assert "certificate iii in aged care" not in dk_req
    assert any("certificate iii" in c.lower() for c in out["credentials"]["required"])

    # Certificate IV → credentials.preferred
    dk_pref = [s.lower() for s in out["preferred_skills"]["domain_knowledge"]]
    assert "certificate iv in aged care" not in dk_pref
    assert any("certificate iv" in c.lower() for c in out["credentials"]["preferred"])

    # residential aged care → job_context, not skills
    assert "residential aged care" not in dk_req
    assert out["job_context"]["setting"] is not None

    # personal care stays in skills
    assert "personal care" in dk_req


def test_contract_keys_preserved():
    """All prior top-level keys survive the addition of credentials/job_context."""
    out = post_process_jd_analysis(_empty_analysis(), role_family_id="master")
    for key in ("required_skills", "preferred_skills", "skill_evidence", "lexicon_meta"):
        assert key in out
    assert "credentials" in out
    assert "job_context" in out


# ---------------------------------------------------------------------------
# Soft-skill recall floor — literal injection allowed
# ---------------------------------------------------------------------------

def test_soft_skill_recall_written_communication():
    """'written communication skills' in JD body → written communication injected."""
    jd = (
        "Requirements: A high level of written communication skills "
        "and verbal communication skills are essential."
    )
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), jd, role_family_id="nursing", skill_text=jd,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    assert "written communication" in soft


def test_soft_skill_recall_verbal_communication():
    jd = "Requirements: strong verbal communication skills required."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), jd, role_family_id="nursing", skill_text=jd,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    assert "verbal communication" in soft


def test_soft_skill_recall_cross_family_blocked():
    """'compassionate' must NOT inject canonical 'empathy' (cross-family)."""
    jd = "We need a compassionate and caring individual to join our team."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), jd, role_family_id="nursing", skill_text=jd,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    assert "empathy" not in soft


def test_soft_skill_recall_only_in_text():
    """A canonical only in boilerplate (stripped via skill_text) must NOT be injected."""
    raw = "About Us: excellent written communication skills team wide.\nRequirements: personal care."
    cleaned = "Requirements: personal care."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), raw, role_family_id="nursing", skill_text=cleaned,
    )
    soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
    assert "written communication" not in soft
