"""Phase 1 (section-scoped recall floor) + Phase 2 (vertical-aware prompt)
regression tests.

Phase 1: enrich_required_skills_from_jd_body honours the optional `skill_text`
parameter — a lexicon canonical present only in boilerplate (the raw jd_text)
but absent from the cleaned skill_text must NOT be injected.

Phase 2: build_jd_analysis_system_prompt injects the right vertical hint block,
and resolve_vertical maps JD text to the correct lexicon vertical.
"""
from __future__ import annotations

from pathlib import Path

from app.services.ai.prompts.jd_analysis import (
    JD_ANALYSIS_SYSTEM,
    build_jd_analysis_system_prompt,
)
from app.services.eval.role_families import resolve_vertical
from app.services.skills.post_process import enrich_required_skills_from_jd_body

_JDS_DIR = Path(__file__).parent / "golden" / "jds"


def _load_jd_body(jd_id: str) -> str:
    text = (_JDS_DIR / f"{jd_id}.md").read_text()
    parts = text.split("---", 2)
    return parts[2].lstrip("\n") if len(parts) >= 3 else text


# ---------------------------------------------------------------------------
# Phase 2 — prompt builder
# ---------------------------------------------------------------------------

def test_build_prompt_none_is_base():
    assert build_jd_analysis_system_prompt(None) == JD_ANALYSIS_SYSTEM


def test_build_prompt_unknown_vertical_is_base():
    assert build_jd_analysis_system_prompt("master") == JD_ANALYSIS_SYSTEM
    assert build_jd_analysis_system_prompt("finance") == JD_ANALYSIS_SYSTEM
    assert build_jd_analysis_system_prompt("") == JD_ANALYSIS_SYSTEM


def test_build_prompt_nursing_injects_cald_hint():
    prompt = build_jd_analysis_system_prompt("nursing")
    assert prompt.startswith(JD_ANALYSIS_SYSTEM)
    assert len(prompt) > len(JD_ANALYSIS_SYSTEM)
    # Collapse whitespace so wrapped phrases match regardless of line breaks.
    lower = " ".join(prompt.lower().split())
    assert "culturally and linguistically diverse" in lower
    assert "cald" in lower
    assert "cultural sensitivity" in lower
    # The hint must steer CALD to soft, not domain.
    assert "soft skill" in lower


def test_build_prompt_tech_injects_tech_hint():
    prompt = build_jd_analysis_system_prompt("tech")
    lower = prompt.lower()
    assert "languages, tools, platforms" in lower or "python" in lower
    assert "agile" in lower  # methodology → domain_knowledge


def test_build_prompt_cleaning_injects_cleaning_hint():
    prompt = build_jd_analysis_system_prompt("cleaning")
    lower = prompt.lower()
    assert "commercial cleaning" in lower
    assert "equipment" in lower


def test_build_prompt_case_insensitive():
    assert build_jd_analysis_system_prompt("NURSING") == build_jd_analysis_system_prompt("nursing")


# ---------------------------------------------------------------------------
# Phase 2 — vertical resolution from JD text
# ---------------------------------------------------------------------------

def test_resolve_vertical_nursing():
    body = _load_jd_body("nursing-residential-ain")
    assert resolve_vertical(None, {"summary": body}) == "nursing"


def test_resolve_vertical_tech():
    body = _load_jd_body("tech-backend-engineer")
    assert resolve_vertical(None, {"summary": body}) == "tech"


def test_resolve_vertical_cleaning():
    body = _load_jd_body("cleaning-commercial")
    # cleaning JD resolves to the manual family → cleaning lexicon
    assert resolve_vertical(None, {"summary": body}) == "cleaning"


def test_resolve_vertical_hint_passthrough():
    assert resolve_vertical("it", None) == "tech"
    assert resolve_vertical("nursing", None) == "nursing"
    assert resolve_vertical("cleaner", None) == "cleaning"
    assert resolve_vertical("master", None) is None
    assert resolve_vertical("other", None) is None


# ---------------------------------------------------------------------------
# Phase 1 — section-scoped recall floor
# ---------------------------------------------------------------------------

def _empty_analysis() -> dict:
    return {
        "summary": "",
        "responsibilities": [],
        "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "skill_evidence": {},
    }


def test_recall_floor_skill_text_scopes_scan():
    """A canonical present only in the raw jd_text (boilerplate) but absent
    from skill_text must NOT be injected by the recall floor."""
    # 'wound care' is a nursing domain canonical. Put it ONLY in the raw text
    # (simulating an About-Us / unrelated mention), not in the cleaned text.
    raw = (
        "About Us: our hospital network provides wound care across the state.\n"
        "Key Responsibilities: assist residents with showering and bathing."
    )
    cleaned = "Key Responsibilities: assist residents with showering and bathing."

    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), raw, role_family_id="nursing", skill_text=cleaned,
    )
    dk = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
    # 'showering and bathing' should be picked up (it's in the cleaned text)...
    assert any("showering" in s or "bathing" in s for s in dk)
    # ...but 'wound care' (only in the stripped boilerplate) must NOT appear.
    assert "wound care" not in dk


def test_recall_floor_without_skill_text_scans_full_jd():
    """Backward-compat: when skill_text is omitted, the full jd_text is scanned
    (the canonical in 'boilerplate' IS picked up — original behaviour)."""
    raw = (
        "About Us: our hospital network provides wound care across the state.\n"
        "Key Responsibilities: assist residents with showering and bathing."
    )
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), raw, role_family_id="nursing",
    )
    dk = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
    assert "wound care" in dk


def test_recall_floor_empty_skill_text_falls_back_to_jd_text():
    """skill_text='' or None → fall back to scanning jd_text (no regression)."""
    raw = "Key Responsibilities: provide wound care and manual handling support."
    out = enrich_required_skills_from_jd_body(
        _empty_analysis(), raw, role_family_id="nursing", skill_text="",
    )
    dk = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
    assert "wound care" in dk
