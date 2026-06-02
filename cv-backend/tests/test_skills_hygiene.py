"""Skills-section hygiene: non-skill phrases (qualifications, eligibility/
compliance, bare sector names, JD-phrasing fillers) must never appear as Skills
entries, whether the base classifier or the matched-term surfacing added them."""
from app.services.eval.writers import (
    _is_non_skill_phrase,
    _strip_non_skill_phrases,
    _relabel_awards_only_certifications,
    _normalise_awards_entries,
    ensure_awards,
    _extract_original_credentials,
    _strip_ungrounded_credentials,
    _smartcase_skill,
    _normalise_skills_case,
    _canonicalise_skill_spelling,
    _dedupe_skills_across_lines,
)

_CV_WITH_AWARD = (
    "Maheshwor Tiwari\nNSW\n\n"
    "Experience\nJesmond Miranda Nursing Home\n\n"
    "Education\nHeritage Skills Institute\nCertificate IV in Ageing Support\n\n"
    "Certifications\n- Staff Excellence Award - Jesmond Miranda Nursing Home (Aug 2025)\n"
)

_TAILORED_NO_AWARD = (
    "# Maheshwor Tiwari\nNSW | email\n\n"
    "## Experience\n### Jesmond Miranda Nursing Home\n- Did care.\n\n"
    "## Education\n### Heritage Skills Institute\n*Certificate IV in Ageing Support*\n\n"
    "## Skills\n**Care Skills:** Personal care\n"
)


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
        # Regression: production Dovida CV listed these under Other Skills.
        # They are JD-experience requirements ("desirable if you have
        # professional or personal experience in aged care") — not skills.
        # Predicate must match "experience in" anywhere in the term, not
        # just as a prefix.
        "Professional Experience In Aged Care",
        "Personal Experience In Aged Care",
        "Professional Experience In Disability Support",
        "Personal Experience In Disability Support",
        "Hands-on Experience With Dementia",
        "Prior Experience Working In NDIS",
        "Lived Experience",
        "Personal Experience",
        "Professional Experience",
        # Regression: production Dovida CV listed "Working With Seniors" as
        # an Other Skill. That's the JD's audience-framing
        # ("passion for the lives of seniors"), not a discrete competency.
        "Working With Seniors",
        "Working With Older People",
        "Working With The Elderly",
        "Working With Children",
        "Supporting Older Adults",
        "Caring For Patients",
        "Engaging With Residents",
        "Supporting Vulnerable People",
        # Regression: production Dovida CV listed "Aged Care Clients" under
        # Other Skills. Same family — bare audience phrase, not a skill.
        # "[sector] [audience]" without any verb prefix.
        "Aged Care Clients",
        "Aged Care Residents",
        "Nursing Home Residents",
        "NDIS Participants",
        "NDIS Clients",
        "Disability Clients",
        "Home Care Clients",
        "Residential Care Residents",
        "Community Care Participants",
        "Hospital Patients",
        "Clinical Clients",
        "Palliative Patients",
        "In-home Clients",
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
        # Guard against over-matching: words that contain "experience" or
        # "personal" as a substring but are legitimate single-skill terms.
        "Personal trainer",
        "Personal hygiene support",
        "User experience design",
        "Customer experience",
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


def test_relabel_awards_only_certifications():
    md = (
        "## Certifications\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home (Aug 2025)\n\n"
        "## Education\n"
    )
    out = _relabel_awards_only_certifications(md)
    assert "## Awards" in out
    assert "## Certifications" not in out
    assert "Staff Excellence Award" in out


def test_relabel_keeps_real_certifications():
    md = (
        "## Certifications\n"
        "- Certificate IV in Ageing Support\n"
        "- Staff Excellence Award (Aug 2025)\n\n"
        "## Education\n"
    )
    out = _relabel_awards_only_certifications(md)
    assert "## Certifications" in out
    assert "## Awards" not in out


def test_relabel_noops_without_certifications():
    md = "## Skills\n**Care Skills:** Personal care\n"
    assert _relabel_awards_only_certifications(md) == md


def test_relabel_handles_recognition_heading():
    """Regression: production Sanctuary CV emitted ## Recognition (not
    ## Certifications). The relabel must catch the alternative heading and
    normalise to ## Awards so it lands at the canonical post-Skills slot."""
    md = (
        "## Skills\n**Care Skills:** Personal Care\n\n"
        "## Recognition\n"
        "### Staff Excellence Award, Jesmond Miranda Nursing Home | Miranda, NSW, Australia\n"
        "*Recognised For Hard Work, Caring Nature, And Positive Attitude | Aug 2025*\n"
    )
    out = _relabel_awards_only_certifications(md)
    assert "## Awards" in out
    assert "## Recognition" not in out
    assert "Staff Excellence Award" in out


def test_relabel_handles_achievements_heading():
    md = (
        "## Achievements\n"
        "- Dean's List 2023 — Charles Darwin University\n\n"
        "## Skills\n"
    )
    out = _relabel_awards_only_certifications(md)
    assert "## Awards" in out
    assert "## Achievements" not in out


def test_relabel_keeps_recognition_with_real_credential():
    """A Recognition section that contains a real credential entry stays
    unchanged — the relabel only fires for award-only sections."""
    md = (
        "## Recognition\n"
        "- Staff Excellence Award (Aug 2025)\n"
        "- First Aid Certificate HLTAID011\n"
    )
    out = _relabel_awards_only_certifications(md)
    assert "## Awards" not in out
    assert "## Recognition" in out


# ---------------------------------------------------------------------------
# _normalise_awards_entries — canonicalise the bullet shape
# ---------------------------------------------------------------------------

def test_normalise_h3_italic_block_to_structured():
    """Old H3+italic shape converts to the new bullet format:
       * Name - Org (Date) / Description.
    """
    md = (
        "## Awards\n\n"
        "### Staff Excellence Award, Jesmond Miranda Nursing Home | Miranda, NSW, Australia\n"
        "*Recognised For Hard Work, Caring Nature, And Positive Attitude | Aug 2025*\n\n"
        "## Education\n"
    )
    out = _normalise_awards_entries(md)
    # New shape: bullet holds Name - Org (Date); next line is Description.
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (Aug 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_bullet_pipe_form_to_structured():
    md = (
        "## Awards\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home | Aug 2025 – Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (Aug 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_old_bullet_converts_to_structured():
    md = (
        "## Awards\n\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home (Aug 2025)\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (Aug 2025)" in out


def test_normalise_consecutive_bullets_merge():
    md = (
        "## Awards\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home | Miranda, NSW, Australia\n"
        "- Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_plain_paragraphs_merge():
    md = (
        "## Awards\n"
        "Staff Excellence Award | Jesmond Miranda Nursing Home, Miranda, NSW, Australia\n"
        "Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_h3_non_date_org_rescue():
    md = (
        "## Awards\n"
        "### Staff Excellence Award | Jesmond Miranda Nursing Home, Miranda, NSW, Australia\n"
        "Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()



def test_normalise_noops_without_awards_section():
    md = "## Skills\n**Care Skills:** Personal Care\n"
    assert _normalise_awards_entries(md) == md


def test_normalise_handles_award_without_organisation():
    """Award entry with no org (e.g. Dean's List). With no org the bullet
    has no dash separator — just '* Name (Date)'."""
    md = (
        "## Awards\n"
        "- Dean's List (2023)\n"
    )
    out = _normalise_awards_entries(md)
    # Bullet with no org → no dash in the line.
    assert "* Dean's List (2023)" in out


def test_normalise_paren_date_with_description_keeps_description():
    """Bullet 'Award – Org (Date), description' must now KEEP the description."""
    md = (
        "## Awards\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home (2025), "
        "recognised for hard work, caring nature, patience, and positive "
        "attitude in resident care.\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award - Jesmond Miranda Nursing Home (2025)" in out
    assert "recognised for hard work" in out.lower()


def test_extract_original_credentials():
    out = _extract_original_credentials(_CV_WITH_AWARD)
    assert out == ["Staff Excellence Award - Jesmond Miranda Nursing Home (Aug 2025)"]


def test_ensure_awards_recovers_dropped_award():
    out = ensure_awards(_TAILORED_NO_AWARD, _CV_WITH_AWARD)
    assert "## Certifications" in out  # canonical heading; relabel renames later
    assert "Staff Excellence Award" in out


def test_ensure_awards_noop_when_already_present():
    already = _TAILORED_NO_AWARD + "\n## Certifications\n- Staff Excellence Award (Aug 2025)\n"
    out = ensure_awards(already, _CV_WITH_AWARD)
    assert out.count("Staff Excellence Award") == 1


def test_ensure_awards_does_not_readd_credential_in_education():
    cv = (
        "Education\nHeritage Skills Institute\n\n"
        "Certifications\n- Certificate IV in Ageing Support\n"
    )
    tailored = (
        "# Name\n\n## Education\n### Heritage Skills Institute\n"
        "*Certificate IV in Ageing Support*\n"
    )
    out = ensure_awards(tailored, cv)
    assert out.count("Certificate IV in Ageing Support") == 1
    assert "## Certifications" not in out


def test_ensure_awards_noop_without_source_section():
    cv = "Name\n\nExperience\nDid things\n"
    tailored = "# Name\n\n## Experience\n- Did things\n"
    assert ensure_awards(tailored, cv) == tailored


def test_ensure_awards_recovers_when_only_mentioned_inline():
    """Regression: award mentioned in an Experience bullet must NOT prevent
    the dedicated Awards entry from being recovered. The inline mention is
    not a substitute for a section entry — recruiters scan for the dedicated
    section, and the deterministic relabel only fires when the section exists.
    """
    tailored = (
        "# Maheshwor Tiwari\nNSW | email\n\n"
        "## Experience\n### Jesmond Miranda Nursing Home\n"
        "- Received Staff Excellence Award for caring nature; delivered care.\n\n"
        "## Education\n### Heritage Skills Institute\n*Certificate IV in Ageing Support*\n"
    )
    out = ensure_awards(tailored, _CV_WITH_AWARD)
    # Inline mention is preserved AND dedicated section recovered:
    assert "## Certifications" in out
    assert out.count("Staff Excellence Award") == 2  # 1 inline + 1 in section


def test_ensure_awards_skips_certs_recovers_only_awards():
    cv = (
        "Certifications\n"
        "- Certificate IV in Ageing Support\n"
        "- National Police Check\n"
        "- Staff Excellence Award (Aug 2025)\n"
    )
    tailored = "# Name\n\n## Experience\n- Did care.\n"
    out = ensure_awards(tailored, cv)
    assert "Staff Excellence Award" in out
    # Certs / checks are NOT recovered here.
    assert "Certificate IV in Ageing Support" not in out
    assert "National Police Check" not in out


def test_strip_ungrounded_drops_placeholder_entry():
    cv = "Maheshwor Tiwari\n\nExperience\nDid care.\n"
    md = (
        "# Name\n\n"
        "## Certifications\n"
        "- First Aid / Manual Handling Training – [Provider not specified]\n\n"
        "## Education\n### Heritage Skills Institute\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "First Aid" not in out
    # Whole emptied section is dropped.
    assert "## Certifications" not in out
    assert "## Education" in out


def test_strip_ungrounded_drops_fabricated_check():
    cv = "Maheshwor Tiwari\nNSW\n\nExperience\nDid care.\n"
    md = (
        "# Name\n\n"
        "## Checks & Clearances\n"
        "- Driver Licence (NSW)\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "Driver Licence" not in out
    assert "## Checks & Clearances" not in out
    assert "## Skills" in out


def test_strip_ungrounded_keeps_grounded_entry():
    cv = (
        "Certifications\n- Certificate IV in Ageing Support\n"
        "- Staff Excellence Award (Aug 2025)\n"
    )
    md = (
        "# Name\n\n"
        "## Certifications\n"
        "- Certificate IV in Ageing Support\n"
        "- Staff Excellence Award (Aug 2025)\n\n"
        "## Education\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "Certificate IV in Ageing Support" in out
    assert "Staff Excellence Award" in out
    assert "## Certifications" in out


def test_strip_ungrounded_drops_only_fabricated_keeps_real():
    cv = "Certifications\n- Certificate IV in Ageing Support\n"
    md = (
        "# Name\n\n"
        "## Certifications\n"
        "- Certificate IV in Ageing Support\n"
        "- First Aid Training – [Provider not specified]\n\n"
        "## Education\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "Certificate IV in Ageing Support" in out
    assert "First Aid" not in out
    assert "## Certifications" in out


def test_strip_ungrounded_noops_non_credential_sections():
    cv = "Name\n\nExperience\nDid things\n"
    md = "# Name\n\n## Experience\n- Did something unrelated to the CV\n"
    assert _strip_ungrounded_credentials(md, cv) == md


# ---------------------------------------------------------------------------
# Skills-line case normalisation
# ---------------------------------------------------------------------------

def test_smartcase_plain_words():
    assert _smartcase_skill("communication") == "Communication"
    assert _smartcase_skill("time management") == "Time Management"
    assert _smartcase_skill("TEAMWORK") == "Teamwork"


def test_smartcase_preserves_acronyms():
    assert _smartcase_skill("SQL") == "SQL"
    assert _smartcase_skill("AWS") == "AWS"
    assert _smartcase_skill("NDIS Worker Screening") == "NDIS Worker Screening"
    assert _smartcase_skill("AHPRA") == "AHPRA"


def test_smartcase_preserves_mixed_case_products():
    assert _smartcase_skill("BESTMed") == "BESTMed"
    assert _smartcase_skill("MedMobile") == "MedMobile"
    assert _smartcase_skill("eHealth") == "eHealth"
    assert _smartcase_skill("iCare") == "iCare"


def test_smartcase_preserves_digit_tokens():
    assert _smartcase_skill("GA4") == "GA4"
    assert _smartcase_skill("AS400") == "AS400"
    assert _smartcase_skill("YOLOv8") == "YOLOv8"


def test_smartcase_handles_hyphens():
    assert _smartcase_skill("person-centred care") == "Person-Centred Care"
    assert _smartcase_skill("PERSON-CENTRED CARE") == "Person-Centred Care"
    assert _smartcase_skill("Person-centred Care") == "Person-Centred Care"


def test_normalise_skills_case_consistent_line():
    md = (
        "## Skills\n"
        "**Care Skills:** Personal care, dementia care, MEDICATION ASSISTANCE, BESTMed, MedMobile\n"
        "**Soft Skills:** Communication, time management, teamwork, Person-centred care\n"
        "**Other Skills:** SQL, ndis worker screening, behavioural management techniques\n\n"
        "## Education\n"
    )
    out = _normalise_skills_case(md)
    assert "Personal Care, Dementia Care, Medication Assistance, BESTMed, MedMobile" in out
    assert "Communication, Time Management, Teamwork, Person-Centred Care" in out
    assert "SQL, NDIS Worker Screening, Behavioural Management Techniques" in out
    # Acronyms / mixed-case products preserved.
    assert "BESTMed" in out and "MedMobile" in out and "SQL" in out and "NDIS" in out
    # Other sections untouched.
    assert "## Education" in out


def test_normalise_skills_case_is_idempotent():
    md = (
        "## Skills\n"
        "**Soft Skills:** Communication, time management, Person-centred care\n"
    )
    once = _normalise_skills_case(md)
    twice = _normalise_skills_case(once)
    assert once == twice


def test_normalise_skills_case_noops_without_skills_section():
    md = "# Name\n\n## Experience\n- Did things\n"
    assert _normalise_skills_case(md) == md


def test_availability_and_shift_patterns_rejected():
    assert _is_non_skill_phrase("Availability For Day Shifts 8am-4pm Monday Tuesday Friday")
    assert _is_non_skill_phrase("available for night shifts")
    assert _is_non_skill_phrase("monday to friday")
    assert _is_non_skill_phrase("8am-4pm")
    assert _is_non_skill_phrase("rostered shifts")

    # legitimate care / coord skills must survive
    assert not _is_non_skill_phrase("roster management")
    assert not _is_non_skill_phrase("roster coordination")
    assert not _is_non_skill_phrase("shift handover")
    assert not _is_non_skill_phrase("shift lead")


def test_ensure_awards_recovers_flexible_headings():
    cv = (
        "Maheshwor Tiwari\n\n"
        "## Awards & Achievements\n"
        "- Staff Excellence Award\n"
    )
    tailored = (
        "# Name\n\n## Experience\n- Did care.\n"
    )
    out = ensure_awards(tailored, cv)
    assert "Staff Excellence Award" in out
    assert "## Certifications" in out


def test_user_has_credential_mapping():
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "drivers_licence": "Open C Class",
            "own_car": True,
            "car_insurance": False,
            "police_check": True,
        }
    }

    assert user_has_credential("valid driver licence", contact)
    assert user_has_credential("open driver's license", contact)
    assert user_has_credential("driving and access to reliable car", contact)
    assert user_has_credential("reliable vehicle", contact)
    assert user_has_credential("national police check", contact)

    # False because car_insurance is False
    assert not user_has_credential("comprehensive car insurance", contact)
    # False because not in profile
    assert not user_has_credential("wwcc", contact)


def test_split_compound_skills_single_line():
    from app.services.eval.enforce import _split_compound_skills, enforce_skills_section

    md_single_line = (
        "## Skills\n"
        "**Core Skills:** Personal Care, Medication Assistance **Soft Skills:** Communication, Teamwork **Other Skills:** BESTMed, MedMobile\n"
        "\n"
        "## Education\n"
    )

    # Test direct _split_compound_skills
    split_md = _split_compound_skills(md_single_line)
    lines = split_md.strip().split("\n")
    assert lines[0] == "## Skills"
    assert lines[1] == "**Core Skills:** Personal Care, Medication Assistance"
    assert lines[2] == "**Soft Skills:** Communication, Teamwork"
    assert lines[3] == "**Other Skills:** BESTMed, MedMobile"

    # Test via enforce_skills_section
    enforced = enforce_skills_section(md_single_line)
    enforced_lines = enforced.strip().split("\n")
    assert enforced_lines[0] == "## Skills"
    assert enforced_lines[1] == "**Core Skills:** Personal Care, Medication Assistance"
    assert enforced_lines[2] == "**Soft Skills:** Communication, Teamwork"
    assert enforced_lines[3] == "**Other Skills:** BESTMed, MedMobile"


def test_split_compound_skills_bare_unbolded_line():
    """Regression: the writer sometimes emits all categories on one line with
    NO bold markers. Bare '<Word> Skills:' labels must still split + bold."""
    from app.services.eval.enforce import _split_compound_skills

    md_bare = (
        "## Skills\n"
        "Care Skills: Personal Care, Medication Assistance, Dementia Care "
        "Soft Skills: Verbal Communication, Teamwork "
        "Other Skills: BESTMed, MedMobile\n"
        "\n"
        "## Experience\n"
    )
    lines = _split_compound_skills(md_bare).strip().split("\n")
    assert lines[0] == "## Skills"
    assert lines[1] == "**Care Skills:** Personal Care, Medication Assistance, Dementia Care"
    assert lines[2] == "**Soft Skills:** Verbal Communication, Teamwork"
    assert lines[3] == "**Other Skills:** BESTMed, MedMobile"


def test_split_compound_skills_leaves_plain_content_untouched():
    """A single category line with comma-separated items (no embedded second
    category) must NOT be falsely split — only category-marker boundaries split."""
    from app.services.eval.enforce import _split_compound_skills

    md_ok = (
        "## Skills\n"
        "**Care Skills:** Personal Care, Medication Assistance, Dementia Care\n"
        "**Soft Skills:** Teamwork\n"
        "**Other Skills:** BESTMed\n"
        "\n"
        "## Experience\n"
    )
    lines = _split_compound_skills(md_ok).strip().split("\n")
    assert lines[1] == "**Care Skills:** Personal Care, Medication Assistance, Dementia Care"
    assert lines[2] == "**Soft Skills:** Teamwork"
    assert lines[3] == "**Other Skills:** BESTMed"
