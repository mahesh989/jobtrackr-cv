from __future__ import annotations

from app.services.pipeline.steps.tailored_cv import (
    _clean_job_title,
    _enforce_career_highlights_words,
    _enforce_summary_opener,
    _trim_to_words,
)


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

