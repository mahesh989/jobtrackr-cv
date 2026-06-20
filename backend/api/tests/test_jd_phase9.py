"""Phase 9 regression tests — deterministic soft-skill grounding gate.

drop_ungrounded_soft_skills removes LLM-emitted soft skills whose canonical or
any lexicon variant does NOT appear verbatim in the JD text. This catches LLM
inferences from employer-preference / scheduling prose (e.g. "reliability",
"flexibility" with no matching word in the JD) while keeping skills genuinely
supported by the JD.
"""
from __future__ import annotations

from app.services.skills.post_process import drop_ungrounded_soft_skills


_HARDI_JD = (
    "We are currently looking for motivated and passionate Assistant in Nursing "
    "Cert III or IV to join our supportive friendly team.\n"
    "Offering temporary part-time fixed shifts Mon-Fri AM shifts only. No PM and "
    "Weekend shifts.\n"
    "Ensure at all times that the safety of the patient is not compromised.\n"
    "Promote and maintain a clean, comfortable and safe environment for residents.\n"
    "Excellent interpersonal communication skills. Experience in working with people "
    "of culturally and linguistically diverse backgrounds. Understanding of teamwork. "
    "Strong computer skills. Ability to work independently. Empathy and patience. "
    "Maintaining residents dignity, respect, comfort.\n"
)


def _analysis(soft):
    return {
        "required_skills": {"technical": [], "soft_skills": list(soft), "domain_knowledge": []},
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "lexicon_meta": {},
    }


def test_drops_ungrounded_reliability_flexibility():
    out = drop_ungrounded_soft_skills(
        _analysis(["communication", "reliability", "flexibility", "teamwork"]),
        _HARDI_JD,
        role_family_id="nursing",
    )
    soft = out["required_skills"]["soft_skills"]
    assert "reliability" not in soft
    assert "flexibility" not in soft
    assert "communication" in soft
    assert "teamwork" in soft


def test_keeps_motivation_word_grounded():
    """'motivation' is grounded by the verbatim 'motivated' variant in the JD."""
    out = drop_ungrounded_soft_skills(
        _analysis(["motivation"]), _HARDI_JD, role_family_id="nursing",
    )
    assert "motivation" in out["required_skills"]["soft_skills"]


def test_keeps_cultural_sensitivity_and_safety_awareness():
    """Both are supported by the JD ('culturally and linguistically diverse
    backgrounds', 'safe environment') via lexicon variants — must NOT be dropped."""
    out = drop_ungrounded_soft_skills(
        _analysis(["cultural sensitivity", "safety awareness"]),
        _HARDI_JD,
        role_family_id="nursing",
    )
    soft = out["required_skills"]["soft_skills"]
    assert "cultural sensitivity" in soft
    assert "safety awareness" in soft


def test_records_drops_in_ungrounded():
    out = drop_ungrounded_soft_skills(
        _analysis(["reliability"]), _HARDI_JD, role_family_id="nursing",
    )
    ung = out["lexicon_meta"]["ungrounded"]
    assert any(u["skill"] == "reliability" and u["reason"] == "soft_skill_not_in_jd" for u in ung)


def test_master_family_noop():
    """No vertical lexicon for master → gate is a no-op (keeps everything)."""
    analysis = _analysis(["reliability", "flexibility"])
    out = drop_ungrounded_soft_skills(analysis, _HARDI_JD, role_family_id="master")
    assert out["required_skills"]["soft_skills"] == ["reliability", "flexibility"]


def test_leadership_not_grounded_by_boilerplate_leading():
    """A casual care role should not gain 'leadership' just because the company
    blurb says 'leading aged care provider'. The weak variants 'lead'/'leading'
    must not ground the requirement on their own."""
    jd = "Bolton Clarke is a leading aged care provider. Provide personal care."
    out = drop_ungrounded_soft_skills(
        _analysis(["leadership"]), jd, role_family_id="nursing",
    )
    assert "leadership" not in out["required_skills"]["soft_skills"]


def test_leadership_grounded_by_real_phrasing():
    """Genuine leadership language ('providing leadership', 'team leadership')
    still grounds the canonical."""
    jd = "You will be providing leadership and team leadership to junior staff."
    out = drop_ungrounded_soft_skills(
        _analysis(["leadership"]), jd, role_family_id="nursing",
    )
    assert "leadership" in out["required_skills"]["soft_skills"]


def test_only_touches_soft_skills():
    """Technical and domain_knowledge buckets are never filtered by this gate."""
    analysis = {
        "required_skills": {
            "technical": ["computer skills"],
            "soft_skills": ["reliability"],
            "domain_knowledge": ["some unrelated domain phrase not in jd"],
        },
        "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        "lexicon_meta": {},
    }
    out = drop_ungrounded_soft_skills(analysis, _HARDI_JD, role_family_id="nursing")
    assert out["required_skills"]["technical"] == ["computer skills"]
    assert out["required_skills"]["domain_knowledge"] == ["some unrelated domain phrase not in jd"]
    assert "reliability" not in out["required_skills"]["soft_skills"]
