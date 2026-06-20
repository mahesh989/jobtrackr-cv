"""Phase 3 — Validator-based LLM prompting regression tests.

Tests cover:
- retrieve_skill_candidates: correct lexicon hits for known verticals
- retrieve_skill_candidates: empty result for unrecognised text
- _normalise_validator_output: routes accepted → required vs preferred
- _normalise_validator_output: includes new_discoveries with correct categories
- _normalise_validator_output: populates skill_evidence in run_jd_analysis normalisation
- _normalise_validator_output: handles missing / malformed fields gracefully
- build_jd_analysis_validator_prompt: base + vertical hints
- VALIDATOR_MIN_CANDIDATES threshold logic (via _run_validator / _run_extraction selection)
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest

from app.services.ai.prompts import (
    JD_ANALYSIS_VALIDATOR_SYSTEM,
    JD_ANALYSIS_VALIDATOR_USER_TEMPLATE,
    build_jd_analysis_validator_prompt,
)
from app.services.pipeline.steps.jd_analysis import (
    VALIDATOR_MIN_CANDIDATES,
    _normalise_validator_output,
    _normalise_skill_block,
)
from app.services.skills.retrieval import retrieve_skill_candidates


# ---------------------------------------------------------------------------
# retrieve_skill_candidates
# ---------------------------------------------------------------------------


def test_retrieval_nursing_finds_canonicals():
    jd = (
        "The successful candidate will provide wound care and medication administration "
        "to residents in our aged care facility. Manual handling training is required."
    )
    candidates = retrieve_skill_candidates(jd, "nursing")
    canonicals = {c["canonical"].lower() for c in candidates}
    # These are all in nursing.json lexicon
    assert any("wound care" in c for c in canonicals), canonicals
    assert any("aged care" in c for c in canonicals), canonicals


def test_retrieval_tech_finds_canonicals():
    jd = (
        "We need a backend engineer proficient in Python and SQL. "
        "Experience with AWS and Docker is required. Agile methodology preferred."
    )
    candidates = retrieve_skill_candidates(jd, "tech")
    canonicals = {c["canonical"].lower() for c in candidates}
    assert any("python" in c for c in canonicals), canonicals
    assert any("sql" in c for c in canonicals), canonicals


def test_retrieval_all_candidates_have_required_fields():
    jd = "Care worker needed for residential aged care. Must have wound care experience."
    candidates = retrieve_skill_candidates(jd, "nursing")
    for c in candidates:
        assert "canonical" in c
        assert "category" in c
        assert "vertical" in c
        assert c["category"] in ("technical", "soft_skills", "domain_knowledge")


def test_retrieval_empty_jd_returns_empty():
    assert retrieve_skill_candidates("", "nursing") == []
    assert retrieve_skill_candidates("   ", "tech") == []


def test_retrieval_unrecognised_text_returns_few_or_empty():
    jd = "We offer unparalleled synergies and leverage next-generation paradigms daily."
    candidates = retrieve_skill_candidates(jd, "nursing")
    # Shouldn't hallucinate; may find 0 or very few
    assert len(candidates) < VALIDATOR_MIN_CANDIDATES


def test_retrieval_respects_top_k():
    # A very rich JD could hit many canonicals; top_k caps output
    jd = " ".join([
        "wound care, medication administration, manual handling, infection control,",
        "personal care, aged care, residential aged care, home care, dementia care,",
        "palliative care, continence care, pressure area care, mobility support,",
        "person-centred care, individual support, communication, teamwork, empathy,",
        "compassion, reliability, attention to detail, Leecare, eMMS",
    ])
    candidates = retrieve_skill_candidates(jd, "nursing", top_k=5)
    assert len(candidates) <= 5


def test_retrieval_unknown_vertical_still_scans_all():
    jd = "Python and SQL experience required."
    candidates_with_vertical = retrieve_skill_candidates(jd, "tech")
    candidates_no_vertical = retrieve_skill_candidates(jd, None)
    # With None vertical, cross-vertical scan still finds tech canonicals
    tech_canonical_found = any("python" in c["canonical"].lower() for c in candidates_no_vertical)
    assert tech_canonical_found


def test_retrieval_category_ordering():
    """domain_knowledge candidates should appear before soft_skills."""
    jd = (
        "Provide wound care and manual handling support. "
        "Strong communication skills essential. "
        "Must be compassionate and reliable."
    )
    candidates = retrieve_skill_candidates(jd, "nursing")
    if len(candidates) < 2:
        pytest.skip("not enough candidates to test ordering")
    cats = [c["category"] for c in candidates]
    # domain_knowledge before soft_skills
    dk_indices = [i for i, c in enumerate(cats) if c == "domain_knowledge"]
    ss_indices = [i for i, c in enumerate(cats) if c == "soft_skills"]
    if dk_indices and ss_indices:
        assert min(dk_indices) < min(ss_indices)


# ---------------------------------------------------------------------------
# _normalise_validator_output
# ---------------------------------------------------------------------------


def _make_validator_raw(
    accepted: List[Dict] = None,
    rejected: List[str] = None,
    new_discoveries: List[Dict] = None,
) -> Dict[str, Any]:
    return {
        "job_title": "Care Worker",
        "seniority_level": "entry",
        "summary": "A care worker role in aged care.",
        "responsibilities": ["Provide personal care"],
        "experience_years_required": None,
        "accepted": accepted or [],
        "rejected": rejected or [],
        "new_discoveries": new_discoveries or [],
    }


def test_normalise_validator_required_vs_preferred():
    raw = _make_validator_raw(
        accepted=[
            {"skill": "wound care", "category": "domain_knowledge",
             "requirement_level": "required", "evidence": "wound care required"},
            {"skill": "communication", "category": "soft_skills",
             "requirement_level": "preferred", "evidence": "good communication preferred"},
        ]
    )
    out = _normalise_validator_output(raw)
    assert "wound care" in [s["skill"] for s in out["required_skills"]["domain_knowledge"]]
    assert "communication" in [s["skill"] for s in out["preferred_skills"]["soft_skills"]]


def test_normalise_validator_new_discoveries_included():
    raw = _make_validator_raw(
        new_discoveries=[
            {"skill": "empathy", "category": "soft_skills",
             "requirement_level": "required", "evidence": "must be empathetic"},
        ]
    )
    out = _normalise_validator_output(raw)
    assert any(s["skill"] == "empathy" for s in out["required_skills"]["soft_skills"])


def test_normalise_validator_bad_category_skipped():
    raw = _make_validator_raw(
        accepted=[
            {"skill": "something weird", "category": "NOT_A_CATEGORY",
             "requirement_level": "required", "evidence": "..."},
        ]
    )
    out = _normalise_validator_output(raw)
    all_skills = (
        out["required_skills"]["technical"]
        + out["required_skills"]["soft_skills"]
        + out["required_skills"]["domain_knowledge"]
    )
    assert not any(s["skill"] == "something weird" for s in all_skills)


def test_normalise_validator_preserves_metadata():
    raw = _make_validator_raw()
    out = _normalise_validator_output(raw)
    assert out["job_title"] == "Care Worker"
    assert out["seniority_level"] == "entry"
    assert out["responsibilities"] == ["Provide personal care"]
    assert out["experience_years_required"] is None


def test_normalise_validator_empty_lists():
    raw = _make_validator_raw()
    out = _normalise_validator_output(raw)
    for cat in ("technical", "soft_skills", "domain_knowledge"):
        assert out["required_skills"][cat] == []
        assert out["preferred_skills"][cat] == []


def test_normalise_validator_evidence_in_skill_block():
    """After _normalise_skill_block, evidence_out is populated from validator items."""
    raw = _make_validator_raw(
        accepted=[
            {"skill": "wound care", "category": "domain_knowledge",
             "requirement_level": "required", "evidence": "provide wound care to residents"},
        ]
    )
    out = _normalise_validator_output(raw)
    # Pass through _normalise_skill_block (same path as run_jd_analysis)
    evidence: Dict[str, str] = {}
    normalised = _normalise_skill_block(
        out["required_skills"], block_name="required_skills", evidence_out=evidence
    )
    assert "wound care" in normalised["domain_knowledge"]
    assert evidence.get("wound care") == "provide wound care to residents"


# ---------------------------------------------------------------------------
# Validator prompt builder
# ---------------------------------------------------------------------------


def test_validator_prompt_base():
    prompt = build_jd_analysis_validator_prompt(None)
    assert prompt == JD_ANALYSIS_VALIDATOR_SYSTEM


def test_validator_prompt_unknown_vertical_is_base():
    assert build_jd_analysis_validator_prompt("master") == JD_ANALYSIS_VALIDATOR_SYSTEM
    assert build_jd_analysis_validator_prompt("finance") == JD_ANALYSIS_VALIDATOR_SYSTEM


def test_validator_prompt_nursing_injects_hint():
    prompt = build_jd_analysis_validator_prompt("nursing")
    assert prompt.startswith(JD_ANALYSIS_VALIDATOR_SYSTEM)
    assert len(prompt) > len(JD_ANALYSIS_VALIDATOR_SYSTEM)
    lower = " ".join(prompt.lower().split())
    assert "culturally and linguistically diverse" in lower


def test_validator_prompt_case_insensitive():
    assert build_jd_analysis_validator_prompt("NURSING") == build_jd_analysis_validator_prompt("nursing")


def test_validator_user_template_has_placeholders():
    rendered = JD_ANALYSIS_VALIDATOR_USER_TEMPLATE.format(
        candidates_json='[{"canonical": "wound care"}]',
        jd_text="Some JD text here.",
    )
    assert "wound care" in rendered
    assert "Some JD text here." in rendered


# ---------------------------------------------------------------------------
# VALIDATOR_MIN_CANDIDATES constant
# ---------------------------------------------------------------------------


def test_validator_min_candidates_is_positive():
    assert VALIDATOR_MIN_CANDIDATES > 0
