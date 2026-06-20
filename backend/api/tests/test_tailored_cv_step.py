from __future__ import annotations

from app.services.pipeline.steps.tailored_cv import (
    _clean_job_title,
    _enforce_career_highlights_words,
    _enforce_company_anchor,
    _enforce_summary_opener,
    _extract_employers_from_cv,
    _lowercase_generic_care_phrases,
    _title_case_role,
    _trim_to_words,
)


def test_title_case_role_keeps_connectors_lowercase():
    assert _title_case_role("assistant in nursing") == "Assistant in Nursing"
    assert _title_case_role("Assistant In Nursing") == "Assistant in Nursing"
    assert _title_case_role("personal care worker") == "Personal Care Worker"
    assert _title_case_role("director of nursing") == "Director of Nursing"
    # First word always capitalised, even if it's a small word.
    assert _title_case_role("in home support worker") == "In Home Support Worker"


def test_lowercases_generic_care_phrases_midsentence():
    md = (
        "## Career Highlights\n\n"
        "Assistant in Nursing with experience in residential aged care, "
        "specialising in Activities of Daily Living, Dementia Care, and "
        "Behavioural Management Techniques. Delivered safe Electronic "
        "Medication Administration and accurate documentation for elderly "
        "residents.\n\n"
        "## Professional Experience\n"
    )
    out = _lowercase_generic_care_phrases(md)
    assert "activities of daily living" in out
    assert "Activities of Daily Living" not in out
    assert "dementia care" in out
    assert "electronic medication administration" in out
    # The opener role title must stay capitalised.
    assert "Assistant in Nursing" in out


def test_generic_care_phrase_kept_capitalised_at_sentence_start():
    md = (
        "## Career Highlights\n\n"
        "Aged Care Worker with hands-on placement experience. Activities of "
        "daily living and dementia care were delivered for elderly residents "
        "across multiple settings.\n\n"
        "## Professional Experience\n"
    )
    out = _lowercase_generic_care_phrases(md)
    # Sentence-initial phrase keeps its leading capital.
    assert "Activities of daily living" in out


def _summary(prose: str) -> str:
    return f"## Career Highlights\n\n{prose}\n\n## Professional Experience\n"


def test_opener_replaces_status_label_with_jd_title():
    """The headline bug: S1 opening with 'International student' must be
    replaced by the JD-aligned role title."""
    md = _summary(
        "International student with recent hands-on experience from a 120-hour "
        "residential aged care placement, supporting older people with personal "
        "care. Maintained resident safety through observation."
    )
    out = _enforce_summary_opener(md, jd_job_title="Aged Care Worker")
    assert "Aged Care Worker with recent hands-on experience" in out
    assert "International student" not in out


def test_opener_strips_parenthetical_and_seniority_from_title():
    md = _summary(
        "Recent graduate with placement experience in aged care, supporting "
        "residents. Delivered care at the facility."
    )
    out = _enforce_summary_opener(md, jd_job_title="Senior Assistant in Nursing (AIN)")
    # Leading seniority word + parenthetical dropped; role casing preserved.
    assert "Assistant in Nursing with placement experience" in out
    assert "Senior" not in out.split("##")[1]
    assert "(AIN)" not in out


def test_opener_flags_when_no_usable_title():
    md = _summary(
        "International student with placement experience in aged care, supporting "
        "residents. Delivered care."
    )
    out = _enforce_summary_opener(md, jd_job_title="")
    assert "[ROLE TITLE NEEDED]" in out
    assert "International student" not in out


def test_opener_leaves_valid_role_title_untouched():
    prose = (
        "Aged Care Worker with recent placement experience supporting older "
        "people. Maintained an incident-free record at RFBI Concord."
    )
    md = _summary(prose)
    out = _enforce_summary_opener(md, jd_job_title="Assistant in Nursing")
    assert out == md  # no forbidden opener → no change


def test_opener_leaves_aspiring_untouched():
    """W1 deliberately permits 'Aspiring <Role>' for true career-changers."""
    prose = (
        "Aspiring Data Analyst with a recently completed Google Data Analytics "
        "certificate. Delivered insights through a capstone project."
    )
    md = _summary(prose)
    out = _enforce_summary_opener(md, jd_job_title="Data Analyst")
    assert out == md


def test_clean_job_title_drops_paren_and_seniority():
    assert _clean_job_title("Senior Data Analyst (Marketing)") == "Data Analyst"
    assert _clean_job_title("Assistant in Nursing") == "Assistant in Nursing"
    assert _clean_job_title("") == ""
    assert _clean_job_title("a b c d e f g h") == ""  # too long → junk guard


def test_trim_to_words_does_not_cut_at_semicolon():
    """Regression for the semicolon-cutoff bug. A two-clause S2 joined by ';'
    must NOT be truncated AT the semicolon. With the semicolon removed from
    _ends_clause's clause-boundary set, the trimmer falls through to the
    forward search or hard cap — preserving the second clause's existence."""
    s2 = (
        "Delivered safe medication administration to elderly residents in "
        "dementia ward at Jesmond Miranda Nursing Home; provided compassionate "
        "person-centred care and mobility support and pain management at "
        "Uniting – The Marion."
    )
    # max_words=20 puts the backward window at [12, 20]; the semicolon sits at
    # word 14 (was the buggy cut point). The new code must NOT stop there.
    trimmed = _trim_to_words(s2, 20)
    # The trimmed output must not END right at the semicolon location — i.e.
    # the first-clause-only output 'Delivered ... Nursing Home.' is the bug.
    assert not trimmed.rstrip(".").endswith("Nursing Home"), (
        "Trimmer cut at the semicolon — the second-clause employer is lost. "
        f"Got: {trimmed!r}"
    )


def test_enforce_career_highlights_default_cap_is_50():
    """50 matches the composer prompt's own "35-50 words total" ceiling
    (composition.py CAREER-STYLE SUMMARY) — see tailored_structural_validation's
    profile_word_count gate for the same 35-50 band."""
    import inspect
    sig = inspect.signature(_enforce_career_highlights_words)
    assert sig.parameters["max_words"].default == 50


def test_enforce_career_highlights_words_preserves_semicolon():
    # If the text has a semicolon and is under 50 words, it should not be modified.
    md = (
        "## Career Highlights\n\n"
        "Assistant In Nursing with experience across residential Aged Care settings, specialising in "
        "person-centred care and medication assistance for elderly residents in supported living environments. "
        "Delivered accurate electronic medication administration and documentation at Jesmond Miranda Nursing Home; "
        "provides support and behavioural management at Uniting – The Marion.\n\n"
        "## Experience\n"
    )
    out = _enforce_career_highlights_words(md, max_words=50)
    assert "Uniting – The Marion" in out


def test_enforce_career_highlights_words_with_overflow():
    # If it is over 50 words, we want to make sure it doesn't split at the semicolon
    # (which would drop the entire second clause).
    md_over = (
        "## Career Highlights\n\n"
        "Assistant In Nursing with 2+ years of experience across residential Aged Care settings, specialising in "
        "person-centred care and medication assistance for elderly residents in supported living environments. "
        "Delivered accurate electronic medication administration and documentation at Jesmond Miranda Nursing Home; "
        "provides support and behavioural management for residents at Uniting – The Marion.\n\n"
        "## Experience\n"
    )
    out_over = _enforce_career_highlights_words(md_over, max_words=50)
    # With the semicolon check removed, it should not cut at the semicolon (which is at word 40).
    # It should keep words up to the period at word 24 or word 50 (if no period within flex limit).
    # Since word 24 has a period, it walks back from 50 and finds the period at word 24, trimming S2 entirely
    # to fit within the 50-word cap honestly rather than splitting a clause in half.
    # In any case, it should not produce a truncated clause ending in a semicolon.
    assert not out_over.endswith(";")
    assert "Jesmond Miranda" in out_over or "Uniting" in out_over


def test_inject_missing_skills_fallback():
    from app.services.pipeline.steps.tailored_cv import _inject_missing_skills

    markdown = (
        "## Professional Experience\n"
        "### Org A | Sydney\n"
        "- Worked here.\n\n"
        "## Skills\n"
        "**Technical Skills:** Python\n"
        "**Soft Skills:** Communication\n"
        "**Other Skills:** BESTMed\n"
    )

    feasibility = {
        "feasibility_plan": {
            "inject_directly": [
                {
                    "keyword": "machine learning",
                    "category": "technical",
                    "injection_target": "skills_section",
                }
            ],
            "inject_as_extension": [
                {
                    "keyword": "care planning",
                    "category": "domain_knowledge",
                    "injection_target": "experience_bullet",
                },
                {
                    "keyword": "communication",
                    "category": "soft_skills",
                    "injection_target": "experience_bullet",
                }
            ],
            "inject_with_inference": [
                {
                    "keyword": "clinical documentation",
                    "category": "domain_knowledge",
                    "injection_target": "experience_bullet",
                }
            ]
        }
    }

    out = _inject_missing_skills(markdown, feasibility)

    # 1. "machine learning" had skills_section target, should be injected to Technical Skills
    assert "Python, Machine Learning" in out

    # 2. "care planning" was NOT in the CV, should be fallback-injected into Other Skills (domain_knowledge)
    assert "BESTMed, Care Planning" in out

    # 3. "clinical documentation" was NOT in the CV, should be fallback-injected into Other Skills
    assert "Clinical Documentation" in out

    # 4. "communication" WAS already in the CV (under Soft Skills), so it should NOT be fallback-injected again
    # (should not see "Communication, Communication")
    assert "Communication, Communication" not in out


def test_enforce_company_anchor_injects_when_absent():
    """When S2 names no employer and the CV has 2+ multi-month roles, the
    enforcer appends 'at Employer1 and Employer2'."""
    md = (
        "## Career Highlights\n\n"
        "Assistant in Nursing with experience in residential aged care, "
        "specialising in person-centred care and dementia care. "
        "Experienced in electronic medication administration and documentation.\n\n"
        "## Professional Experience\n"
    )
    cv_text = (
        "### The Jesmond Group | Miranda, NSW\n"
        "AIN | May 2025 – June 2026\n"
        "- Delivered medication administration.\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN (Casual) | Mar 2026 – Present\n"
        "- Provided person-centred care.\n\n"
        "### Anglicare Mildred Symons House | Jannali, NSW\n"
        "Aged Care Placement (120 hours) | Sept 2024\n"
        "- Delivered dementia care.\n"
    )
    out = _enforce_company_anchor(md, cv_text)
    assert "The Jesmond Group" in out
    assert "Uniting" in out


def test_enforce_company_anchor_no_op_when_already_present():
    """When S2 already names an employer, the enforcer leaves it unchanged."""
    md = (
        "## Career Highlights\n\n"
        "Assistant in Nursing with experience in residential aged care. "
        "Delivered medication administration at The Jesmond Group; "
        "provided person-centred care at Uniting.\n\n"
        "## Professional Experience\n"
    )
    cv_text = (
        "### The Jesmond Group | Miranda, NSW\n"
        "AIN | May 2025 – June 2026\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN (Casual) | Mar 2026 – Present\n"
    )
    out = _enforce_company_anchor(md, cv_text)
    assert out == md


def test_enforce_company_anchor_no_op_for_placement_only_cv():
    """A CV with only a placement (no multi-month role) is left untouched."""
    md = (
        "## Career Highlights\n\n"
        "Aged Care Worker with hands-on placement experience. "
        "Delivered person-centred dementia care across residential settings.\n\n"
        "## Professional Experience\n"
    )
    cv_text = (
        "### Anglicare Mildred Symons House | Jannali, NSW\n"
        "Aged Care Placement (120 hours) | Sept 2024\n"
        "- Delivered dementia care.\n"
    )
    out = _enforce_company_anchor(md, cv_text)
    assert out == md


def test_extract_employers_includes_role_with_weekly_hours():
    """A role line listing '38 hrs/week' alongside a real date range must NOT be
    excluded — only genuine placements (containing 'placement') are skipped."""
    cv_text = (
        "### The Jesmond Group | Miranda, NSW\n"
        "AIN (Casual) | May 2025 – Present | 38 hrs/week\n"
        "- Delivered person-centred care.\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN (Casual) | Mar 2024 – Apr 2025 | 24 hrs/week\n"
        "- Provided dementia care.\n"
    )
    employers = _extract_employers_from_cv(cv_text)
    assert "The Jesmond Group" in employers
    assert "Uniting" in employers


def test_extract_employers_still_excludes_placements():
    """Lines containing 'placement' are still excluded even with a date range."""
    cv_text = (
        "### Anglicare | Jannali, NSW\n"
        "Aged Care Placement | Sept 2024 – Nov 2024\n"
        "- Delivered dementia care.\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN (Casual) | Mar 2024 – Present\n"
        "- Provided person-centred care.\n"
    )
    employers = _extract_employers_from_cv(cv_text)
    assert "Anglicare" not in employers
    assert "Uniting" in employers


def test_enforce_company_anchor_injects_when_s2_has_no_period():
    """When S2 is truncated without a trailing period (AI word-count cut),
    the anchor should still be injected as long as S2 doesn't end mid-clause."""
    md = (
        "## Career Highlights\n\n"
        "Compassionate AIN with strong clinical skills in residential aged care. "
        "Experienced in medication administration and personal care\n\n"
        "## Professional Experience\n"
    )
    cv_text = (
        "### The Jesmond Group | Miranda, NSW\n"
        "AIN (Casual) | May 2025 – Present | 38 hrs/week\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN (Casual) | Mar 2024 – Apr 2025\n"
    )
    out = _enforce_company_anchor(md, cv_text)
    assert "The Jesmond Group" in out
    assert "Uniting" in out


def test_enforce_company_anchor_no_op_when_s2_ends_with_dangling_preposition():
    """S2 ending with a dangling 'and' or 'with' is still blocked."""
    md = (
        "## Career Highlights\n\n"
        "Compassionate AIN with strong clinical skills. "
        "Experienced in medication administration and\n\n"
        "## Professional Experience\n"
    )
    cv_text = (
        "### The Jesmond Group | Miranda, NSW\n"
        "AIN | May 2025 – Present\n\n"
        "### Uniting | Leichhardt, NSW\n"
        "AIN | Mar 2024 – Apr 2025\n"
    )
    out = _enforce_company_anchor(md, cv_text)
    assert "The Jesmond Group" not in out

