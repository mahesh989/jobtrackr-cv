"""Skills-section hygiene: non-skill phrases (qualifications, eligibility/
compliance, bare sector names, JD-phrasing fillers) must never appear as Skills
entries, whether the base classifier or the matched-term surfacing added them."""
from app.services.eval.writers import _is_non_skill_phrase, _strip_non_skill_phrases


def test_predicate_rejects_non_skills():
    for junk in [
        "Aged Care",
        "Aged Care Practices",
        "Australian Work Rights Compliance",
        "Certificate Iii In Individual Support & Ageing Or Equivalent",
        "Experience In Aged Care",
        "Knowledge of dementia care",
        "National Police Check",
        "Diploma of Nursing",
    ]:
        assert _is_non_skill_phrase(junk), junk


def test_predicate_keeps_real_skills():
    for skill in [
        "Personal care",
        "Dementia care",
        "Person-centred care",
        "Medication assistance",
        "Behavioural management techniques",
        "Infection control",
        "Manual handling",
        "Communication",
        "BESTMed",
        "MedMobile",
    ]:
        assert not _is_non_skill_phrase(skill), skill


def test_strip_cleans_skills_section_and_preserves_others():
    md = (
        "# Maheshwor Tiwari\n\n"
        "## Skills\n"
        "**Care Skills:** Personal care, Medication assistance, Dementia care, "
        "Mobility support, Aged Care, Infection control, Manual handling\n"
        "**Soft Skills:** Person-centred care, Communication, Teamwork\n"
        "**Other Skills:** BESTMed, MedMobile, Behavioural management techniques, "
        "Aged Care Practices, Australian Work Rights Compliance, "
        "Certificate Iii In Individual Support & Ageing Or Equivalent, "
        "Experience In Aged Care\n\n"
        "## Certifications\n"
        "- Staff Excellence Award\n"
    )
    out = _strip_non_skill_phrases(md)

    assert "Aged Care," not in out and "Aged Care\n" not in out
    assert "Aged Care Practices" not in out
    assert "Work Rights" not in out
    assert "Certificate Iii" not in out
    assert "Experience In Aged Care" not in out

    # Genuine skills survive.
    assert "Personal care" in out
    assert "Dementia care" in out
    assert "Behavioural management techniques" in out
    assert "BESTMed, MedMobile" in out
    # Untouched sections remain intact.
    assert "## Certifications" in out
    assert "Staff Excellence Award" in out


def test_strip_drops_emptied_category_line():
    md = (
        "## Skills\n"
        "**Care Skills:** Personal care, Dementia care\n"
        "**Other Skills:** Aged Care, Experience In Aged Care\n\n"
        "## Education\n"
    )
    out = _strip_non_skill_phrases(md)
    assert "**Other Skills:**" not in out
    assert "**Care Skills:** Personal care, Dementia care" in out


def test_strip_noops_without_skills_section():
    md = "# Name\n\n## Experience\n- Did things\n"
    assert _strip_non_skill_phrases(md) == md
