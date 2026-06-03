"""Skills-section hygiene: non-skill phrases (qualifications, eligibility/
compliance, bare sector names, JD-phrasing fillers) must never appear as Skills
entries, whether the base classifier or the matched-term surfacing added them."""
from app.services.eval.enforce import enforce_skills_section
from app.services.eval.enforce_w3 import (
    enforce_summary_breadth_consistency,
    enforce_summary_dedup,
    enforce_summary_title_dedup,
    enforce_summary_skills_dedup,
)
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
    _inject_approved_skills,
    _drop_subsumed_generic_skills,
    _approved_skill_entries,
    _tidy_skill_qualifiers,
)
from app.services.pipeline.steps.keyword_feasibility import (
    _is_filler_keyword,
    _reconcile_with_missing,
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
        "NSW C Class Motor Vehicle Licence",
        "Care For Older People",
        "Home Care Support For Older People",
        "Support for Residents",
        "Working With Disadvantaged And Vulnerable People",
        # Regression: care-setting / environment descriptors — WHERE you work,
        # not a discrete skill. "Acute Healthcare Environment" was the original
        # reported bug. The gate was catching audience phrases but missing
        # work-context endings (environment, setting, facility, ward).
        "Acute Healthcare Environment",
        "Acute Care Setting",
        "Aged Care Environment",
        "Residential Aged Care Setting",
        "Healthcare Environment",
        "Clinical Environment",
        "Hospital Setting",
        "Community Setting",
        "Rehabilitation Ward",
        "Acute Care Facility",
        # Regression: production Rashmi CV listed bare "Residential Care" under
        # Other Skills. A bare sector/setting name (no audience or "setting"
        # suffix to trip the regex) — says WHERE the work happens, not WHAT the
        # candidate can do. Caught via the exact blocklist.
        "Residential Care",
        "Nursing Home",
        "Care Facility",
        "Aged Care Facility",
        "Residential Aged Care Facility",
        # Regression: Sonnet 4.6 production runs (2026-06-03) leaked these into
        # Other Skills / Care Skills. GPT-5.1 produces canonical short skills;
        # Sonnet preserves JD multi-word noun phrases verbatim. These are all
        # sector descriptors, JD verb phrases, or credentials — not skills.
        "Aged Care Delivery",
        "Retirement Community Care",
        "Retirement Living And Community Aged Care",
        "Home Care Or Disability Support Work",
        "Aged Care And Disability Services",
        "Workplace Health And Safety",
        "Workplace Health And Safety (WHS)",
        "Mobile App Usage For Rostering",
        "Covid And Flu Vaccination",
        "First Aid And CPR Certification",
        "Promotion Of Independence For Older People",
        "Maintenance Of Dignity",
        "Aged Care Services",
        "Home Care Provision",
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
        # Guard: skills that happen to END with a word the environment-pattern
        # targets — but only when the WHOLE term ends with it. These are real
        # skills and must NOT be stripped.
        "Roster management",      # ends with "management", not "ward/setting"
        "Wound care",             # ends with "care", not "environment"
        "Theatre nursing",        # "theatre" ≠ a setting-suffix word
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
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (Aug 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_bullet_pipe_form_to_structured():
    md = (
        "## Awards\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home | Aug 2025 – Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (Aug 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_old_bullet_converts_to_structured():
    md = (
        "## Awards\n\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home (Aug 2025)\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (Aug 2025)" in out


def test_normalise_consecutive_bullets_merge():
    md = (
        "## Awards\n"
        "- Staff Excellence Award – Jesmond Miranda Nursing Home | Miranda, NSW, Australia\n"
        "- Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_plain_paragraphs_merge():
    md = (
        "## Awards\n"
        "Staff Excellence Award | Jesmond Miranda Nursing Home, Miranda, NSW, Australia\n"
        "Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_h3_non_date_org_rescue():
    md = (
        "## Awards\n"
        "### Staff Excellence Award | Jesmond Miranda Nursing Home, Miranda, NSW, Australia\n"
        "Recognized for hard work, caring nature, and positive attitude August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)" in out
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
    assert "* Staff Excellence Award, Jesmond Miranda Nursing Home (2025)" in out
    assert "recognised for hard work" in out.lower()


def test_normalise_strips_date_prefix_from_description():
    """Regression: when verify_claims or a re-run prepends the date to the
    description (e.g. 'August 2025. Recognised for...'), it must be stripped
    — the date already lives in the name line '* Name - Org (Date)'."""
    md = (
        "## Awards\n\n"
        "* Staff Excellence Award - Jesmond Miranda Nursing Home (August 2025)\n"
        "August 2025. Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(md)
    # Date must NOT appear in the description line.
    lines = [l for l in out.split("\n") if "Recognised" in l]
    assert lines, "description line missing"
    assert "August 2025" not in lines[0], (
        f"Date leaked into description: {lines[0]!r}"
    )
    assert "recognised for hard work" in lines[0].lower()


def test_normalise_strips_pipe_residue_from_description():
    """Regression: 'Recognised for hard work. | August 2025' (old pipe format)
    must not leave a trailing '|' in the description."""
    md = (
        "## Awards\n\n"
        "### Staff Excellence Award | Jesmond Miranda Nursing Home\n"
        "Recognised for hard work, caring nature, and positive attitude. | August 2025\n"
    )
    out = _normalise_awards_entries(md)
    assert "|" not in out.split("## Awards")[1].split("\n")[2]  # description line


def test_normalise_two_distinct_awards_no_blank_line_both_survive():
    """Regression (bug #1): two GENUINE separate awards as adjacent bullets with
    no blank line between them must BOTH survive — neither starts with
    description language, so they are distinct entries, not an award + its
    orphan description. The old blank-line-only split merged them and silently
    dropped the second."""
    md = (
        "## Awards\n"
        "- Dean's List (2019)\n"
        "- Employee of the Year - Acme Health (2023)\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Dean's List (2019)" in out
    assert "* Employee of the Year, Acme Health (2023)" in out


def test_normalise_description_preserves_proper_noun_casing():
    """Regression (Fix E): the description must not be blanket-lowercased —
    acronyms and proper nouns (NDIS, Jesmond) have to survive."""
    md = (
        "## Awards\n\n"
        "### Staff Excellence Award | Jesmond Miranda Nursing Home\n"
        "Recognised for outstanding NDIS support across the Jesmond team. (Aug 2025)\n"
    )
    out = _normalise_awards_entries(md)
    # "NDIS" only appears in the description; the old blanket .lower() produced
    # "ndis". Its survival proves the casing is preserved.
    assert "NDIS" in out


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
    assert _smartcase_skill("nsw") == "NSW"
    assert _smartcase_skill("VIC") == "VIC"


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
    assert lines[1] == "- **Core Skills:** Personal Care, Medication Assistance"
    assert lines[2] == "- **Soft Skills:** Communication, Teamwork"
    assert lines[3] == "- **Other Skills:** BESTMed, MedMobile"

    # Test via enforce_skills_section
    enforced = enforce_skills_section(md_single_line)
    enforced_lines = enforced.strip().split("\n")
    assert enforced_lines[0] == "## Skills"
    assert enforced_lines[1] == "- **Core Skills:** Personal Care, Medication Assistance"
    assert enforced_lines[2] == "- **Soft Skills:** Communication, Teamwork"
    assert enforced_lines[3] == "- **Other Skills:** BESTMed, MedMobile"


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
    assert lines[1] == "- **Care Skills:** Personal Care, Medication Assistance, Dementia Care"
    assert lines[2] == "- **Soft Skills:** Verbal Communication, Teamwork"
    assert lines[3] == "- **Other Skills:** BESTMed, MedMobile"


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


def test_dedupe_skills_and_canonicalisation():
    md = (
        "## Skills\n"
        "**Care Skills:** Person-Centred Care\n"
        "**Soft Skills:** Advocacy For Patients And Residents\n"
        "**Other Skills:** Patient-Centred Care\n\n"
        "## Experience\n"
    )
    # Test spelling conversions
    assert _canonicalise_skill_spelling("Patient-Centred Care") == "Person-Centred Care"
    assert _canonicalise_skill_spelling("Advocacy For Patients And Residents") == "Patient Advocacy"

    # Test full pass and dropping of empty lines (Other Skills line should be dropped since it only has a duplicate)
    norm = _normalise_skills_case(md)
    deduped = _dedupe_skills_across_lines(norm)

    assert "Person-Centred Care" in deduped
    assert "Patient Advocacy" in deduped
    assert "Other Skills" not in deduped


# ---------------------------------------------------------------------------
# Post-verify skills re-hygiene regression tests.
# verify_claims is an AI step that runs AFTER all deterministic gates — it can
# collapse the three Skills category lines back onto one line, add junk entries
# like "Person-Centred Care Principles" or care-setting descriptors, and break
# case consistency.  The writers must re-run skills hygiene after verify_claims.
# These tests simulate the verify_claims output and confirm the hygiene pipeline
# corrects it deterministically.
# ---------------------------------------------------------------------------

def _run_post_verify_hygiene(md, feasibility=None):
    """Apply the same hygiene chain the writers run post-verify_claims."""
    md = enforce_skills_section(md)
    md = _strip_non_skill_phrases(md)
    md = _normalise_skills_case(md)
    md = _dedupe_skills_across_lines(md)
    md = _inject_approved_skills(md, feasibility)
    md = _drop_subsumed_generic_skills(md)
    md = _normalise_skills_case(md)
    md = _dedupe_skills_across_lines(md)
    return md


def test_post_verify_collapsed_skills_are_split():
    """verify_claims sometimes merges all three skill categories onto one line;
    enforce_skills_section must split them back out."""
    # Simulate verify_claims collapsing categories (bare unbolded single line)
    md = (
        "## Summary\nExperienced nurse.\n\n"
        "## Skills\n"
        "**Care Skills:** Wound Care, Medication Administration "
        "**Soft Skills:** Teamwork, Communication "
        "**Other Skills:** Manual Handling\n\n"
        "## Experience\n### RN - Hospital\n- Did stuff.\n"
    )
    out = _run_post_verify_hygiene(md)
    # All three categories must appear as separate bold lines
    assert "**Care Skills:**" in out
    assert "**Soft Skills:**" in out
    assert "**Other Skills:**" in out
    # Each line should contain only its own items
    for line in out.split("\n"):
        if "**Care Skills:**" in line:
            assert "Teamwork" not in line
        if "**Soft Skills:**" in line:
            assert "Wound Care" not in line


# ---------------------------------------------------------------------------
# enforce_summary_breadth_consistency
#
# The durable contract: when S1 frames experience as BREADTH ("across multiple
# … settings"), naming a SINGLE specific employer in S2 contradicts it. The
# gate strips employer names it reads from the CV's OWN Experience headings —
# so it must work for EVERY grammatical shape the employer can appear in, not
# just a sentence-final "at <Org>." These tests lock in that breadth.
# ---------------------------------------------------------------------------

_BREADTH_S1 = (
    "Experienced Aged Care Worker with 3+ years across multiple residential "
    "aged care settings."
)

# A real Experience section so _employer_candidates() can extract the name.
_EXP_SECTION = (
    "\n\n## Experience\n"
    "### Assistant in Nursing | Jesmond Miranda Nursing Home (2023–2025)\n"
    "- Provided personal care.\n"
)


def _breadth_md(s2: str) -> str:
    return f"## Professional Summary\n{_BREADTH_S1} {s2}{_EXP_SECTION}"


def _assert_clean(out: str) -> None:
    """Common post-conditions on the SUMMARY prose only (the employer name still
    legitimately appears in the Experience heading): employer gone, no double
    space, no stray ' ,' / ' .' / dangling-connector artefacts."""
    summary = out.split("## Experience")[0]
    assert "Jesmond Miranda Nursing Home" not in summary, f"employer leaked: {summary!r}"
    assert "  " not in summary, f"double space leaked: {summary!r}"
    assert " ." not in summary and " ," not in summary, f"stray punct: {summary!r}"


def test_breadth_tail_employer_replaced_with_scope():
    """'…care at Jesmond Miranda Nursing Home.' → '…care across these settings.'"""
    md = _breadth_md(
        "Delivered medication management and person-centred care at Jesmond Miranda Nursing Home."
    )
    out = enforce_summary_breadth_consistency(md)
    _assert_clean(out)
    assert "across these settings" in out


def test_breadth_mid_and_clause_preserved():
    """'…at <Org> and provided care.' → employer gone, continuation survives."""
    md = _breadth_md(
        "Supported residents at Jesmond Miranda Nursing Home and provided person-centred care."
    )
    out = enforce_summary_breadth_consistency(md)
    _assert_clean(out)
    assert "provided person-centred care" in out


def test_breadth_mid_comma_gerund_preserved():
    """Comma + gerund continuation — the shape the OLD regex silently missed."""
    md = _breadth_md(
        "Worked at Jesmond Miranda Nursing Home, providing person-centred care to residents."
    )
    out = enforce_summary_breadth_consistency(md)
    _assert_clean(out)
    assert "providing person-centred care" in out


def test_breadth_mid_where_clause_preserved():
    """'…at <Org> where I delivered care.' relative-clause continuation."""
    md = _breadth_md(
        "Worked at Jesmond Miranda Nursing Home where I delivered medication support."
    )
    out = enforce_summary_breadth_consistency(md)
    _assert_clean(out)
    assert "delivered medication support" in out


def test_breadth_employer_at_sentence_start():
    """S2 that opens on the employer: 'At <Org>, delivered care.'"""
    md = _breadth_md(
        "At Jesmond Miranda Nursing Home, delivered safe medication administration."
    )
    out = enforce_summary_breadth_consistency(md)
    _assert_clean(out)
    assert "delivered safe medication administration".capitalize().split()[0] in out
    assert "medication administration" in out


def test_breadth_semicolon_two_employers_untouched():
    """Two employers joined by ';' = two dominant roles — left entirely alone."""
    s2 = (
        "Delivered care at Jesmond Miranda Nursing Home; "
        "provided clinical support at Uniting."
    )
    md = _breadth_md(s2)
    out = enforce_summary_breadth_consistency(md)
    assert "Jesmond Miranda Nursing Home" in out  # not stripped


def test_breadth_no_breadth_s1_is_noop():
    """S1 without breadth framing → no-op even if S2 names the employer."""
    md = (
        "## Professional Summary\n"
        "Aged Care Worker with 3 years at Jesmond Miranda Nursing Home. "
        "Delivered person-centred care at Jesmond Miranda Nursing Home."
        + _EXP_SECTION
    )
    out = enforce_summary_breadth_consistency(md)
    assert out == md  # unchanged


def test_breadth_setting_type_not_mistaken_for_employer():
    """A capitalised care-SETTING type ('Aged Care') is NOT in the Experience
    headings, so it must NOT be stripped — only real employers are."""
    md = _breadth_md(
        "Delivered person-centred care across Aged Care environments to elderly residents."
    )
    out = enforce_summary_breadth_consistency(md)
    # No employer named → S2 untouched, 'Aged Care' preserved.
    assert "Aged Care environments" in out


def test_breadth_unknown_org_not_stripped():
    """An 'at <Capitalised>' that is NOT one of the candidate's employers is
    left alone — the gate strips known employers only, never guesses."""
    md = _breadth_md(
        "Delivered person-centred care at Christmas events for elderly residents."
    )
    out = enforce_summary_breadth_consistency(md)
    assert "at Christmas events" in out  # not an employer → untouched


def test_post_verify_care_setting_stripped():
    """verify_claims sometimes reintroduces care-setting descriptors
    ('Acute Healthcare Environment', 'Hospital Setting') into Skills.
    _strip_non_skill_phrases must remove them after verify."""
    md = (
        "## Skills\n"
        "**Care Skills:** Wound Care, Acute Healthcare Environment, Medication Administration\n"
        "**Soft Skills:** Communication, Hospital Setting\n"
        "**Other Skills:** Manual Handling\n\n"
        "## Experience\n"
    )
    out = _run_post_verify_hygiene(md)
    assert "Acute Healthcare Environment" not in out
    assert "Hospital Setting" not in out
    assert "Wound Care" in out
    assert "Medication Administration" in out
    assert "Communication" in out


def test_post_verify_principles_junk_stripped():
    """'Person-Centred Care Principles' is junk (principles, not a skill);
    stripped by _is_non_skill_phrase → _strip_non_skill_phrases."""
    md = (
        "## Skills\n"
        "**Care Skills:** Person-Centred Care, Person-Centred Care Principles, Wound Care\n"
        "**Soft Skills:** Communication\n"
        "**Other Skills:** NDIS\n\n"
        "## Experience\n"
    )
    out = _run_post_verify_hygiene(md)
    assert "Person-Centred Care Principles" not in out
    # The base term should survive
    assert "Person-Centred Care" in out


def test_post_verify_duplicate_across_lines_removed():
    """verify_claims can add a skill to multiple categories; dedup must fix it."""
    md = (
        "## Skills\n"
        "**Care Skills:** Wound Care, NDIS\n"
        "**Soft Skills:** Communication\n"
        "**Other Skills:** NDIS, Wound Care\n\n"
        "## Experience\n"
    )
    out = _run_post_verify_hygiene(md)
    # Count occurrences — each should appear exactly once
    assert out.count("NDIS") == 1
    assert out.count("Wound Care") == 1



# ---------------------------------------------------------------------------
# Approved-but-missing skill injection (post-cap safety net) + generic
# subsumption. Fixes the "Approved but missed: verbal/written communication"
# report when the soft-skills cap dropped the writer-surfaced terms.
# ---------------------------------------------------------------------------


def _feasibility(*entries: tuple[str, str, str]) -> dict:
    """Build a feasibility dict from (keyword, category, bucket_name) tuples."""
    plan: dict = {"inject_directly": [], "inject_as_extension": [], "inject_with_inference": []}
    for kw, cat, bucket_name in entries:
        plan[bucket_name].append({"keyword": kw, "category": cat, "bucket": "required"})
    return {"feasibility_plan": plan}


def test_approved_soft_skills_injected_past_cap():
    """verbal/written communication are approved but the cap kept only 6 soft
    skills — the post-cap injector must re-add them."""
    md = (
        "## Skills\n"
        "**Care Skills:** Personal Care, Dementia Care\n"
        "**Soft Skills:** Empathy, Teamwork, Communication, Time Management, Adaptability, Reliability\n"
        "**Other Skills:** BESTMed, MedMobile\n\n"
        "## Experience\n"
    )
    feas = _feasibility(
        ("verbal communication", "soft_skills", "inject_directly"),
        ("written communication", "soft_skills", "inject_directly"),
    )
    out = _run_post_verify_hygiene(md, feas)
    assert "Verbal Communication" in out
    assert "Written Communication" in out


def test_approved_soft_skill_from_extension_bucket_injected():
    """Approval can come from inject_as_extension / inject_with_inference too."""
    md = (
        "## Skills\n"
        "**Care Skills:** Personal Care\n"
        "**Soft Skills:** Empathy, Teamwork, Communication, Time Management, Adaptability, Reliability\n"
        "**Other Skills:** BESTMed\n\n"
        "## Experience\n"
    )
    feas = _feasibility(("written communication", "soft_skills", "inject_with_inference"))
    out = _run_post_verify_hygiene(md, feas)
    assert "Written Communication" in out


def test_generic_communication_subsumed_by_specifics():
    """Once Verbal/Written Communication are present, the bare 'Communication'
    generic is redundant and must be dropped."""
    md = (
        "## Skills\n"
        "**Soft Skills:** Empathy, Communication, Verbal Communication, Written Communication\n\n"
        "## Experience\n"
    )
    out = _drop_subsumed_generic_skills(md)
    skills_block = out.split("## Experience")[0]
    assert "Verbal Communication" in skills_block
    assert "Written Communication" in skills_block
    # The bare generic should be gone (no standalone ", Communication," item)
    items = [s.strip() for s in skills_block.split("Soft Skills:**")[1].split(",")]
    assert "Communication" not in items


def test_injector_skips_already_present_and_non_skill():
    """No duplicate when already present; non-skill phrases never injected."""
    md = (
        "## Skills\n"
        "**Soft Skills:** Empathy, Verbal Communication\n\n"
        "## Experience\n"
    )
    feas = _feasibility(
        ("verbal communication", "soft_skills", "inject_directly"),  # already present
        ("knowledge of whs", "soft_skills", "inject_directly"),       # non-skill filler
    )
    out = _run_post_verify_hygiene(md, feas)
    assert out.count("Verbal Communication") == 1
    assert "Knowledge Of Whs" not in out
    assert "knowledge of whs" not in out.lower()


def test_approved_skill_entries_dedups_across_buckets():
    feas = _feasibility(
        ("verbal communication", "soft_skills", "inject_directly"),
        ("verbal communication", "soft_skills", "inject_as_extension"),
        ("teamwork", "soft_skills", "inject_directly"),
    )
    entries = _approved_skill_entries(feas)
    kws = [k for k, _ in entries]
    assert kws.count("verbal communication") == 1
    assert "teamwork" in kws


def test_no_feasibility_is_noop():
    md = "## Skills\n**Soft Skills:** Empathy\n\n## Experience\n"
    assert _inject_approved_skills(md, None) == md
    assert _inject_approved_skills(md, {}) == md


# ---------------------------------------------------------------------------
# WHS-filler / JD-phrasing exclusion from the feasibility plan. "working
# knowledge of whs" must never reach the plan (neither approved nor honest gap).
# ---------------------------------------------------------------------------


def test_filler_keyword_predicate():
    for filler in [
        "working knowledge of whs",
        "knowledge of infection control",
        "sound knowledge of medication",
        "understanding of person-centred care",
        "an understanding of dementia",
        "ability to work autonomously",
        "experience in aged care",
        "familiarity with ndis",
        "willingness to learn",
        "commitment to safety",
        "demonstrated ability to communicate",
    ]:
        assert _is_filler_keyword(filler), filler

    # Genuine compound skills must survive (no "... of/in/to ..." connective).
    for real in [
        "product knowledge",
        "knowledge management",
        "stakeholder management",
        "wound care",
        "verbal communication",
        "manual handling",
        "infection control",
    ]:
        assert not _is_filler_keyword(real), real


def test_filler_excluded_from_feasibility_plan():
    """A JD-phrasing fragment in the missed set is dropped from the plan —
    not approved, not an honest gap."""
    plan = {b: [] for b in ("inject_directly", "inject_as_extension", "inject_with_inference", "cannot_inject")}
    # AI tried to approve the filler keyword
    plan["inject_directly"].append({
        "keyword": "working knowledge of whs",
        "category": "soft_skills",
        "bucket": "required",
        "evidence": "candidate worked safely",
    })
    missing_block = {"required": {"technical": [], "soft_skills": ["working knowledge of whs"], "domain_knowledge": []},
                     "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []}}
    cleaned = _reconcile_with_missing(plan, missing_block, matching={})
    all_kws = [
        e["keyword"]
        for bucket in cleaned.values()
        for e in bucket
    ]
    assert "working knowledge of whs" not in all_kws


# ---------------------------------------------------------------------------
# Professional-framework phrases ("Scope of Practice", "Duty of Care") are not
# discrete skills and must be stripped from the Skills section.
# ---------------------------------------------------------------------------


def test_framework_phrases_are_non_skills():
    for junk in [
        "Nursing Scope Of Practice",
        "Scope of Practice",
        "Duty of Care",
        "Code of Conduct",
        "Standards of Practice",
        "Model of Care",
    ]:
        assert _is_non_skill_phrase(junk), junk


def test_framework_phrases_keep_real_skills():
    for real in [
        "Personal Care",
        "Wound Care",
        "Dementia Care",
        "Person-Centred Care",
        "Medication Assistance",
        "Project Scope Management",
        "Communication",
        "BESTMed",
    ]:
        assert not _is_non_skill_phrase(real), real


def test_scope_of_practice_stripped_from_other_skills():
    md = (
        "## Skills\n"
        "**Other Skills:** BESTMed, MedMobile, Nursing Scope Of Practice\n\n"
        "## Experience\n"
    )
    out = _strip_non_skill_phrases(md)
    assert "Scope Of Practice" not in out
    assert "BESTMed, MedMobile" in out


def test_care_values_phrases_are_non_skills():
    for junk in [
        "Resident Dignity And Independence",
        "Dignity of Risk",
        "Client Wellbeing",
        "Well-being",
        "Quality of Life",
    ]:
        assert _is_non_skill_phrase(junk), junk


def test_care_values_keep_real_skills():
    for real in [
        "Personal Care",
        "Person-Centred Care",
        "Behavioural Management",
        "Infection Control",
        "Quality Assurance",
    ]:
        assert not _is_non_skill_phrase(real), real


def test_resident_dignity_stripped_from_other_skills():
    md = (
        "## Skills\n"
        "**Other Skills:** BESTMed, MedMobile, Resident Dignity And Independence\n\n"
        "## Experience\n"
    )
    out = _strip_non_skill_phrases(md)
    assert "Dignity" not in out
    assert "BESTMed, MedMobile" in out


# ---------------------------------------------------------------------------
# Skill-entry qualifier tidy ("Strong Communication Skills" → "Communication").
# ---------------------------------------------------------------------------


def test_tidy_strips_leading_qualifier_and_trailing_skills():
    assert _tidy_skill_qualifiers("Strong Communication Skills") == "Communication"
    assert _tidy_skill_qualifiers("Excellent Time Management") == "Time Management"
    assert _tidy_skill_qualifiers("Interpersonal Skills") == "Interpersonal"


def test_tidy_preserves_plain_skills():
    for s in ["Teamwork", "Problem Solving", "Time Management", "Adaptability", "BESTMed"]:
        assert _tidy_skill_qualifiers(s) == s


def test_strong_communication_tidied_in_soft_skills():
    md = (
        "## Skills\n"
        "**Soft Skills:** Reliability, Teamwork, Strong Communication Skills\n\n"
        "## Experience\n"
    )
    out = _strip_non_skill_phrases(md)
    assert "Strong Communication Skills" not in out
    assert "Communication" in out
    assert "Reliability, Teamwork, Communication" in out


# ---------------------------------------------------------------------------
# Professional Summary S1<->S2 de-duplication.
# ---------------------------------------------------------------------------


def test_summary_dedup_drops_fully_redundant_clause():
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing with experience across multiple residential aged care "
        "settings, providing medication support and person-centred care for elderly "
        "residents. Experienced in electronic medication administration, comprehensive "
        "personal care, and supporting residents living with dementia.\n\n"
        "## Skills\n- **Care Skills:** Personal Care\n"
    )
    out = enforce_summary_breadth_consistency(md)  # no-op precondition check
    out = enforce_summary_dedup(md)
    summary = out.split("## Skills")[0]
    # The redundant "comprehensive personal care" clause is gone...
    assert "personal care" not in summary.lower()
    # ...but clauses carrying NEW info survive.
    assert "electronic medication administration" in summary.lower()
    assert "dementia" in summary.lower()


def test_summary_dedup_keeps_distinct_s2():
    """S2 with genuinely new content must be untouched."""
    md = (
        "## Professional Summary\n\n"
        "Registered Nurse with three years in acute care, specialising in wound "
        "management and triage. Reduced medication errors by 30% through a new "
        "double-check protocol at Royal North Shore Hospital.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_dedup(md)
    assert out == md


def test_summary_dedup_preserves_semicolon_two_role_s2():
    """The intentional two-role ';' shape is never thinned."""
    md = (
        "## Professional Summary\n\n"
        "Care professional with experience in aged care and disability support. "
        "Provided personal care at Jesmond Miranda Nursing Home; delivered personal "
        "care at Uniting Marion.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_dedup(md)
    assert out == md


def test_summary_dedup_never_empties_s2():
    """If every clause is redundant, keep the last one — never produce a 1-sentence
    summary."""
    md = (
        "## Professional Summary\n\n"
        "Carer providing personal care and medication support for elderly residents. "
        "Personal care, medication support.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_dedup(md)
    summary = out.split("## Experience")[0]
    # S2 still has content (two sentences preserved).
    sents = [s for s in summary.replace("## Professional Summary", "").split(".") if s.strip()]
    assert len(sents) >= 2


# ---------------------------------------------------------------------------
# Summary title-slot synonym de-dup ("Assistant in Nursing and Care Worker"
# → "Assistant in Nursing"). See enforce_summary_title_dedup.
# ---------------------------------------------------------------------------


def test_title_dedup_strips_synonymous_nursing_titles():
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing and Care Worker with experience across residential "
        "aged care settings, including medication assistance and dementia support "
        "for elderly residents. Delivered safe personal care at multiple "
        "facilities, including incident-free shifts.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_title_dedup(md)
    assert "Assistant in Nursing and Care Worker" not in out
    assert "Assistant in Nursing with experience" in out


def test_title_dedup_strips_data_analyst_synonyms():
    md = (
        "## Professional Summary\n\n"
        "Data Analyst and BI Analyst with three years of experience delivering "
        "dashboards. Reduced reporting time by 30% at iBuild.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_title_dedup(md)
    assert "Data Analyst and BI Analyst" not in out
    assert "Data Analyst with three years" in out


def test_title_dedup_leaves_unrelated_roles_alone():
    """'Cleaner and Receptionist' are NOT synonymous — must NOT collapse."""
    md = (
        "## Professional Summary\n\n"
        "Cleaner and Receptionist with two years of experience supporting busy "
        "offices. Maintained client-facing standards across multiple sites.\n\n"
        "## Experience\n"
    )
    out = enforce_summary_title_dedup(md)
    assert "Cleaner and Receptionist" in out  # untouched


def test_title_dedup_is_idempotent():
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing and Care Worker with experience across aged care. "
        "Delivered safe personal care.\n\n"
        "## Experience\n"
    )
    once = enforce_summary_title_dedup(md)
    twice = enforce_summary_title_dedup(once)
    assert once == twice


# ---------------------------------------------------------------------------
# Summary-vs-Skills de-dup — drop S2 clauses that merely re-list Skills.
# See enforce_summary_skills_dedup.
# ---------------------------------------------------------------------------


def test_skills_dedup_drops_clause_fully_covered_by_skills_section():
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing with experience across residential aged care "
        "settings, including medication assistance, dementia support and "
        "person-centred care for elderly residents. Demonstrated reliability and "
        "quality care, delivering safe personal care and behavioural support for "
        "residents in multiple facilities.\n\n"
        "## Skills\n"
        "- **Care Skills:** Personal Care, Dementia Care, Medication Assistance, "
        "Behavioural Management, Person-Centred Care\n"
        "- **Soft Skills:** Reliability, Teamwork, Communication\n"
        "- **Other Skills:** BESTMed, MedMobile\n\n"
        "## Experience\n"
    )
    out = enforce_summary_skills_dedup(md)
    # The "Demonstrated reliability and quality care" clause has only
    # 'reliability' and 'care' as content words — both in Skills → dropped.
    assert "Demonstrated reliability and quality care" not in out
    # The second clause survives — it contains 'residents', 'multiple',
    # 'facilities' which are NOT in Skills.
    assert "multiple facilities" in out


def test_skills_dedup_keeps_clause_with_novel_content():
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing with experience across aged care. Reduced falls by "
        "20% at Jesmond Miranda, achieving an incident-free six-month record.\n\n"
        "## Skills\n"
        "- **Care Skills:** Personal Care, Dementia Care\n\n"
        "## Experience\n"
    )
    out = enforce_summary_skills_dedup(md)
    # Whole S2 introduces content not in Skills — untouched.
    assert "Reduced falls by 20%" in out
    assert "incident-free" in out


def test_skills_dedup_never_empties_s2():
    """If every clause is Skills-covered, the LAST clause is always kept."""
    md = (
        "## Professional Summary\n\n"
        "Carer providing care for residents. Personal care, dementia care, "
        "medication assistance.\n\n"
        "## Skills\n"
        "- **Care Skills:** Personal Care, Dementia Care, Medication Assistance\n\n"
        "## Experience\n"
    )
    out = enforce_summary_skills_dedup(md)
    # At least one clause survives — output still has two sentences.
    summary = out.split("## Skills")[0]
    sents = [s for s in summary.replace("## Professional Summary", "").split(".") if s.strip()]
    assert len(sents) >= 2


def test_skills_dedup_preserves_semicolon_two_role_s2():
    """Two-distinct-role S2 (joined by ';') is intentional — never thin it."""
    md = (
        "## Professional Summary\n\n"
        "Assistant in Nursing with experience across two aged care employers. "
        "Delivered medication administration at Jesmond Miranda; provided "
        "person-centred care at Uniting – The Marion.\n\n"
        "## Skills\n"
        "- **Care Skills:** Personal Care, Medication Assistance, "
        "Person-Centred Care\n\n"
        "## Experience\n"
    )
    out = enforce_summary_skills_dedup(md)
    assert "Jesmond Miranda" in out
    assert "Uniting – The Marion" in out


def test_skills_dedup_noop_without_skills_section():
    md = (
        "## Professional Summary\n\n"
        "Carer with experience. Reliability, teamwork.\n\n"
        "## Experience\n"
    )
    # No ## Skills section — pool is empty — gate is a no-op.
    assert enforce_summary_skills_dedup(md) == md
