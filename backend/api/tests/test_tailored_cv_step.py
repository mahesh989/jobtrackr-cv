from __future__ import annotations

from app.services.pipeline.steps.tailored_cv import (
    _enforce_career_highlights_words,
    _trim_to_words,
)


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


def test_enforce_career_highlights_default_cap_is_65():
    """The default cap was raised 50 → 65 so two-employer S2 has headroom."""
    import inspect
    sig = inspect.signature(_enforce_career_highlights_words)
    assert sig.parameters["max_words"].default == 65


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


def test_enforce_degree_relevance_respects_keep_all_rule():
    from app.services.eval.enforce_w3 import enforce_degree_relevance

    # Scenario 1: 3 entries (Master's not related to nursing, Bachelor's, Cert IV) -> should not drop Master's!
    md_3_entries = (
        "## Education\n\n"
        "### Central Queensland University | Sydney\n"
        "*Master of Professional Accounting | 2024 – 2026*\n\n"
        "### Pokhara University | Nepal\n"
        "*Bachelor in Business Administration | 2017 – 2021*\n\n"
        "### Elite Institute and Technology | Australia\n"
        "*Certificate IV in Ageing Support | 2025 – 2026*\n"
    )
    # JD analysis with nursing vocab
    jd_analysis = {
        "job_title": "Assistant In Nursing",
        "required_skills": {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": ["personal care", "aged care", "dementia care"],
        }
    }
    
    out_3 = enforce_degree_relevance(md_3_entries, jd_analysis)
    assert "Master of Professional Accounting" in out_3
    assert "Bachelor in Business Administration" in out_3
    assert "Certificate IV in Ageing Support" in out_3

    # Scenario 2: 4 entries (Master's unrelated, 3 other entries) -> Master's should be dropped!
    md_4_entries = (
        "## Education\n\n"
        "### Central Queensland University | Sydney\n"
        "*Master of Professional Accounting | 2024 – 2026*\n\n"
        "### Pokhara University | Nepal\n"
        "*Bachelor in Business Administration | 2017 – 2021*\n\n"
        "### Elite Institute and Technology | Australia\n"
        "*Certificate IV in Ageing Support | 2025 – 2026*\n\n"
        "### Another Institution | Location\n"
        "*Some Other Course | 2022*\n"
    )
    
    out_4 = enforce_degree_relevance(md_4_entries, jd_analysis)
    # Master's should be dropped because it is irrelevant graduate degree and len(entries) > 3
    assert "Master of Professional Accounting" not in out_4
    assert "Bachelor in Business Administration" in out_4
    assert "Certificate IV in Ageing Support" in out_4

