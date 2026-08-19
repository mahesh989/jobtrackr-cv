"""Skills-section hygiene: non-skill phrases (qualifications, eligibility/
compliance, bare sector names, JD-phrasing fillers) must never appear as Skills
entries, whether the base classifier or the matched-term surfacing added them."""
from app.services.eval.enforce import enforce_skills_section
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
        # Regression: production Jane CV listed bare "Residential Care" under
        # Other Skills. A bare sector/setting name (no audience or "setting"
        # suffix to trip the regex) — says WHERE the work happens, not WHAT the
        # candidate can do. Caught via the exact blocklist.
        "Residential Care",
        "Nursing Home",
        "Care Facility",
        "Aged Care Facility",
        "Residential Aged Care Facility",
        # Opus 4.7/4.8 leaked these in the post-Phase-1 Anglicare run.
        # Casual variants of "aged care" and sector-plus-"support" descriptors.
        "Ageing Care",
        "Home Care Support",
        # GPT-5.1 nursing run (post-Phase-1.7) injected "Experience As A Support
        # Worker In Home Care Or Disability" into Other Skills — JD-verb-phrase
        # filler. The "experience as" prefix was missing from the predicate.
        "Experience As A Support Worker In Home Care Or Disability",
        "Experience As A Care Worker",
        "Experience Working In Aged Care",
        # Driver-licence variants — credential belongs in Registration & Licences,
        # not Skills. The candidate's real driving "skill" IS the licence.
        "Driving NSW C Class Motor Vehicle",
        "Driving Motor Vehicle",
        "C Class Driver Licence",
        "C Class Motor Vehicle Licence",
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
        # Phase 1.8 guards: legitimate "Skills" entries that look similar to
        # the new patterns but are real.
        "Basic Computer Skills",   # "computer" + "skills" → KEEP the "Skills" word
        "Computer Skills",
        "People Skills",
        "Technology Skills",
        "Driving Buses",           # no licence/class/motor-vehicle suffix
        "Defensive Driving",       # no licence/class/motor-vehicle suffix
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


def test_normalise_h3_with_standalone_italic_date_keeps_date():
    """Regression: H3 name/org followed by a STANDALONE italic date line
    (`*August 2025*`) then an italic description. The lone italic date used to
    fall through to the org/discard branches and was dropped entirely — the
    award rendered as 'Staff Excellence Award, The Jesmond Group' with no date,
    even though the source CV carried one."""
    md = (
        "## Awards\n\n"
        "### Staff Excellence Award, The Jesmond Group\n"
        "*August 2025*\n"
        "*Recognised for hard work, caring nature, and positive attitude.*\n\n"
        "## Education\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, The Jesmond Group (August 2025)" in out
    assert "recognised for hard work, caring nature, and positive attitude." in out.lower()


def test_normalise_middle_dot_bullet_keeps_date():
    """Regression: the canonical renderer emits awards as
    'Name · Issuer · Date' (cv_renderer._render_award_lines). The middle-dot
    form had no handler, so the whole string mashed into `name` and the date
    was lost on re-parse."""
    md = (
        "## Awards\n\n"
        "- Staff Excellence Award · The Jesmond Group · August 2025\n"
        "  Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(md)
    assert "* Staff Excellence Award, The Jesmond Group (August 2025)" in out
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


def test_format_award_entry_strips_leading_bullet_marker():
    """Regression: the description sometimes arrives from the writer/structurizer
    with a literal leading '- '. Rendered on the 2-space-indented continuation
    line that parses as a NESTED markdown bullet, so it must be stripped."""
    from app.services.eval.writers.awards_parsing import _format_award_entry
    lines = _format_award_entry(
        "Staff Excellence Award", "The Jesmond Group", "August 2025",
        "- Recognised for hard work, caring nature, and positive attitude.",
    )
    desc_line = lines[-1]
    assert not desc_line.lstrip().startswith("- "), desc_line
    assert "Recognised for hard work" in desc_line


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


def test_strip_ungrounded_drops_fabricated_check_under_manual_familys_certifications_and_checks_heading():
    # REGRESSION (C22j): restore_and_order renames "## Certifications" back
    # to "## Certifications & Checks" for the manual role family
    # (_TO_CANONICAL["manual"]'s reverse mapping — a real, prescribed
    # section_order heading, not hypothetical) BEFORE this gate runs.
    # Without "certifications & checks" in _GROUNDED_SECTION_WORDS, this
    # heading never entered the grounding check at all, so a fabricated
    # credential entry survived unchecked.
    cv = "Maheshwor Tiwari\nNSW\n\nExperience\nDid care.\n"
    md = (
        "# Name\n\n"
        "## Certifications & Checks\n"
        "- Advanced First Aid Instructor Certification\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "Advanced First Aid Instructor Certification" not in out
    assert "## Certifications & Checks" not in out
    assert "## Skills" in out


def test_strip_ungrounded_keeps_grounded_entry_under_certifications_and_checks_heading():
    cv = "Maheshwor Tiwari\nNSW\n\n## Certifications & Checks\n- Police Check\n"
    md = (
        "# Name\n\n"
        "## Certifications & Checks\n"
        "- Police Check\n"
        "- Advanced First Aid Instructor Certification\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "Police Check" in out
    assert "Advanced First Aid Instructor Certification" not in out
    assert "## Certifications & Checks" in out


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


def test_REGRESSION_C22q_middle_dot_separated_entry_extracts_the_correct_lead_phrase():
    """
    Regression, execution chunk C22q (found during C22j's independent
    review — cosmetic/low-priority, "currently harmless" per that review,
    but a real drift-prevention fix): _strip_ungrounded_credentials' own
    lead-phrase-split regex didn't recognise the middle-dot (·) separator
    that ensure_awards' sibling regex already did (matching
    contact_line.py's build_credentials_line, which joins stamped
    credential parts with " · "). Without it, a middle-dot-separated
    bullet entry's "core" was the WHOLE string (no split point found)
    instead of just the lead phrase — a false NOT-grounded result even
    when the lead phrase genuinely appears in the source CV, since the
    full string (including a trailing detail the source CV doesn't
    verbatim repeat) is far less likely to be a substring match. Now
    consolidated into one shared _LEAD_PHRASE_SPLIT_RE both functions use.
    """
    cv = "Maheshwor Tiwari\n\nHolds a First Aid Certificate.\n"
    md = (
        "# Name\n\n"
        "## Certifications\n"
        "- First Aid Certificate · HLTAID011 · Renewed 2023\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "First Aid Certificate" in out
    assert "## Certifications" in out


def test_strip_ungrounded_noops_non_credential_sections():
    cv = "Name\n\nExperience\nDid things\n"
    md = "# Name\n\n## Experience\n- Did something unrelated to the CV\n"
    assert _strip_ungrounded_credentials(md, cv) == md


def test_REGRESSION_C22n_prose_only_credential_section_survives():
    """
    Regression, execution chunk C22n (found during C22j's independent
    review — newly reachable for manual CVs via C22j's own fix, since that
    fix made "certifications & checks" enter this gate at all). A
    credential/checks section written as plain prose (no bullet markers)
    only ever appended its lines to `kept` unconditionally — prose is never
    individually grounding-checked — but the section's SURVIVAL decision
    was gated on `kept_bullet`, a flag only a surviving BULLET could set.
    So a 100%-legitimate prose-only section was wrongly deleted in its
    entirety, including the prose lines the loop above had just kept.
    """
    cv = "Maheshwor Tiwari\n\nPolice Check current, renewed annually.\n"
    md = (
        "# Name\n\n"
        "## Certifications & Checks\n"
        "Police Check current, renewed annually.\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "## Certifications & Checks" in out
    assert "Police Check current, renewed annually." in out
    assert "## Skills" in out


def test_strip_ungrounded_still_drops_a_section_where_every_bullet_is_ungrounded():
    """Non-regression guard for the C22n fix: a section made ENTIRELY of
    bullets, all of which are ungrounded, must still be dropped whole —
    the fix broadens survival to "any real kept content", not "always
    keep the heading"."""
    cv = "Maheshwor Tiwari\n\nExperience\nDid care.\n"
    md = (
        "# Name\n\n"
        "## Checks & Clearances\n"
        "- Driver Licence (NSW)\n"
        "- Working with Children Check (VIC)\n\n"
        "## Skills\n**Care Skills:** Personal care\n"
    )
    out = _strip_ungrounded_credentials(md, cv)
    assert "## Checks & Clearances" not in out
    assert "Driver Licence" not in out
    assert "## Skills" in out


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


def test_user_has_credential_keeps_anchored_credential_modifiers():
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "police_check": True,
            "ndis_screening": True,
            "forklift_licence": True,
            "first_aid": True,
            "cpr": True,
            "drivers_licence": "Open C Class",
            "flu_vaccination": True,
            "covid_vaccination": True,
        }
    }
    for phrase in (
        "current criminal history check",
        "valid NDIS worker screening check",
        "current forklift licence",
        "current first aid certification",
        "valid CPR certification",
        "NSW driver's licence",
        "current flu vaccination",
        "current COVID-19 vaccination",
        "proof of COVID-19 vaccination",
    ):
        assert user_has_credential(phrase, contact), phrase


def test_exact_eligibility_lookup_does_not_accept_decorated_context():
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {"visa_status": "citizen", "credentials": {}}
    assert not user_has_credential("experience with work rights", contact)
    assert not user_has_credential("knowledge of visa", contact)


def test_user_has_credential_preserves_compound_check_semantics():
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    both = {"credentials": {"police_check": True, "ndis_screening": True}}
    police_only = {"credentials": {"police_check": True, "ndis_screening": False}}

    assert user_has_credential("national police check and ndis worker check", both)
    assert not user_has_credential(
        "national police check and ndis worker check", police_only
    )
    assert user_has_credential(
        "national police check or ndis workers check requirements", police_only
    )


def test_profile_credential_context_tail_is_not_force_injected():
    """Profile data must not become synthetic evidence for a duty phrase."""
    plan = {
        bucket: []
        for bucket in (
            "inject_directly",
            "inject_as_extension",
            "inject_with_inference",
            "cannot_inject",
        )
    }
    missing = {
        "required": {
            "technical": ["AHPRA compliance administration"],
            "soft_skills": [],
            "domain_knowledge": [],
        },
        "preferred": {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": [],
        },
    }

    cleaned = _reconcile_with_missing(
        plan,
        missing,
        matching={},
        contact_details={"credentials": {"ahpra_number": "NMW0001234567"}},
    )

    assert cleaned["inject_directly"] == []
    assert [entry["keyword"] for entry in cleaned["cannot_inject"]] == [
        "ahpra compliance administration"
    ]


def test_user_has_credential_does_not_fabricate_transport_duty_from_own_car():
    """Finding #1 (chunk C17) — "patient transport" is a clinical/support-work
    DUTY (moving patients/residents between wards, appointments, etc.), not a
    personal-vehicle need. Ticking "own car" must NOT be treated as evidence
    for it — that was being force-injected into delivered CVs as a fabricated
    skill with synthetic evidence.

    First draft tried to EXCLUDE known duty phrasings (patient/resident/
    client transport, noun-phrase and verb-first order). An independent
    review adversarially found a long list of realistic escapes — this test
    pins that exact list so they can never silently regress. The real fix
    inverted the design: REQUIRE an affirmative personal-vehicle cue
    (own/reliable/personal/private, or "access to"/"means of"/"use of")
    before "transport" counts as own_car evidence, instead of chasing an
    open-ended blocklist of duty phrasings.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {"credentials": {"own_car": True, "drivers_licence": "Open C Class"}}

    # The exact failure scenario from the audit's reproduction, plus every
    # escape the independent review found against the first (blocklist)
    # draft of this fix.
    escapes = [
        "patient transport",
        "resident transport",
        "client transport",
        "transporting patients between wards",
        "provide transport for clients",
        "providing transport to residents",
        "transportation of patients",
        "transporting a patient",
        "transport a resident",
        "transport elderly clients",
        "transporting consumers to appointments",
        "consumer transport",
        "transport of consumers",
        "transporting service users",
        "wheelchair transport",
        "stretcher transport",
        "transport trolley",
        "patient transfer and transport",
        "hospital transport",
        "ambulance transport",
        "specimen transport",
        "transport of specimens",
        "medication transport",
    ]
    for kw in escapes:
        assert not user_has_credential(kw, contact), f"fabricated own_car from duty phrasing: {kw!r}"

    # Genuine commute-capability phrasing must still correctly match — the
    # fix requires an affirmative cue, it doesn't remove "transport" as
    # own_car evidence entirely.
    assert user_has_credential("own transport", contact)
    assert user_has_credential("reliable transport to work", contact)
    assert user_has_credential("must have access to transport", contact)
    assert user_has_credential("means of transport", contact)
    assert user_has_credential("use of own transport", contact)

    # An explicit own-car/vehicle cue must still win even when the SAME
    # phrase also mentions a transport duty — the independent review's
    # point 3, and the repo's own existing fixture phrasing in
    # test_jd_sector_strip.py:230 ("a reliable vehicle to transport
    # residents"). "car"/"vehicle" match unconditionally, so these are
    # covered without needing to inspect what follows them.
    assert user_has_credential("own car required for client transport", contact)
    assert user_has_credential("must have own car and transport patients", contact)
    assert user_has_credential("own vehicle to transport residents", contact)
    assert user_has_credential("a reliable vehicle to transport residents", contact)


def test_user_has_credential_car_insurance_ignores_bare_car_and_auto_substrings():
    """Rule 1 had the SAME bare-substring bug already fixed in rule 5 for
    "own car": a plain `"car" in kw` check matches "car" hiding inside
    "care"/"childcare"/"aftercare" — words that appear constantly in this
    product's own aged-care JDs. Independent review also caught that the
    first fix pass word-boundary-guarded "car" but left "auto" bare on the
    same line — "automation insurance claims" / "autonomy insurance" both
    fabricated car_insurance evidence.

    Round 2 of the same review then caught that the FIRST auto fix
    (`\\bauto\\b(?!-)`) was simultaneously too broad — it wrongly excluded
    "auto-insurance policy", a completely standard spelling — and too
    narrow — it still matched the unhyphenated "auto renewal insurance
    admin". Targeted the actual excluded term ("auto-renewal"/"auto
    renewal") instead of blocking every hyphenated "auto-" form.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {"credentials": {"car_insurance": True}}

    assert not user_has_credential("aged care insurance", contact)
    assert not user_has_credential("childcare insurance excess", contact)
    assert not user_has_credential("automation insurance claims", contact)
    assert not user_has_credential("autonomy insurance", contact)
    assert not user_has_credential("insurance auto-renewal processing", contact)
    assert not user_has_credential("auto renewal insurance admin", contact)
    # Genuine car-insurance phrasing must still correctly match.
    assert user_has_credential("comprehensive car insurance", contact)
    assert user_has_credential("vehicle insurance", contact)
    assert user_has_credential("auto insurance", contact)
    assert user_has_credential("auto-insurance policy", contact)


def test_user_has_credential_flu_word_boundary():
    """Independent review of finding #1 found a bare "flu" substring
    (rule 13) fabricating a flu-vaccination record from "fluid balance
    charting" — a core nursing keyword, arguably a worse fabrication than
    the originally reported one since it stamps a medical record the user
    never confirmed.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {"credentials": {"flu_vaccination": True}}

    assert not user_has_credential("fluid balance charting", contact)
    assert not user_has_credential("fluency in english", contact)
    assert not user_has_credential("affluent clients", contact)
    # Genuine phrasing must still correctly match.
    assert user_has_credential("flu vaccination", contact)
    assert user_has_credential("annual flu shot", contact)
    assert user_has_credential("influenza immunisation", contact)


def test_user_has_credential_does_not_fabricate_vehicle_credentials_from_duties():
    """C17b: a bare car/vehicle noun describes many care-sector duties.

    It must not become evidence that the candidate owns a car.  Positive
    possession/access language remains valid profile-backed evidence.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "own_car": True,
            "drivers_licence": "Open C Class",
        }
    }

    duty_phrases = [
        "patient vehicle transfers",
        "wheelchair to vehicle transfers",
        "car seat fitting for children",
        "car park management",
        "vehicle fleet rostering",
        "vehicle cleaning and maintenance",
        "motor vehicle accident rehabilitation",
    ]
    for phrase in duty_phrases:
        assert not user_has_credential(phrase, contact), phrase

    genuine_requirements = [
        "own car",
        "own a car",
        "own reliable vehicle",
        "reliable vehicle",
        "access to a reliable car",
        "use of own vehicle",
        "must have a car",
        "personal vehicle required",
    ]
    for phrase in genuine_requirements:
        assert user_has_credential(phrase, contact), phrase

    # A compound ownership + insurance requirement needs both profile facts.
    assert not user_has_credential("reliable insured vehicle", contact)
    assert not user_has_credential(
        "ownership of reliable comprehensively insured vehicle", contact
    )
    assert not user_has_credential(
        "ownership of a reliable comprehensively insured vehicle", contact
    )
    assert not user_has_credential("vehicle ownership with comprehensive insurance", contact)
    insured_contact = {
        "credentials": {
            "own_car": True,
            "car_insurance": True,
        }
    }
    assert user_has_credential("vehicle ownership with comprehensive insurance", insured_contact)
    assert user_has_credential("reliable insured vehicle", insured_contact)
    assert user_has_credential(
        "ownership of reliable comprehensively insured vehicle", insured_contact
    )
    assert user_has_credential(
        "ownership of a reliable comprehensively insured vehicle", insured_contact
    )
    assert user_has_credential(
        "reliable vehicle with minimum third party vehicle insurance",
        insured_contact,
    )
    assert not user_has_credential("car insurance policy administration", insured_contact)


def test_user_has_credential_does_not_fabricate_medication_or_wwcc_from_duties():
    """C17b: generic administration and child-facing work are duties, not
    proof of medication competency or a Working with Children Check.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "medication_competency": True,
            "wwcc": True,
        }
    }

    for phrase in (
        "administer payroll",
        "administer staff rosters",
        "administer training programs",
        "administer client records",
        "administration of office systems",
        "medication stock ordering",
    ):
        assert not user_has_credential(phrase, contact), phrase

    for phrase in (
        "working with children with autism",
        "experience working with children and families",
        "working with children in a disability support setting",
        "Blue Card application processing",
        "child check-in procedures",
    ):
        assert not user_has_credential(phrase, contact), phrase

    assert user_has_credential("medication administration competency", contact)
    assert user_has_credential("administer prescribed medication", contact)
    assert user_has_credential("current Working with Children Check", contact)
    assert user_has_credential("valid WWCC", contact)
    assert user_has_credential("Blue Card clearance", contact)
    assert user_has_credential("Working with Children Check (NSW)", contact)
    assert user_has_credential("Working with Children Check NSW", contact)
    assert user_has_credential("Victorian Working with Children Check", contact)
    assert user_has_credential("Western Australian Working with Children Check", contact)


def test_user_has_credential_does_not_fabricate_checks_or_registration_from_context():
    """C17b: broad criminal/registration context must not stamp a saved
    police check or AHPRA registration into the delivered CV.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "police_check": True,
            "ahpra_number": "NMW0001234567",
        }
    }

    for phrase in (
        "criminal law knowledge",
        "criminal justice experience",
        "support for victims of criminal offences",
        "liaise with police and emergency services",
        "police referral coordination",
        "criminal history research",
        "background check administration",
    ):
        assert not user_has_credential(phrase, contact), phrase

    for phrase in (
        "registration for the nursing conference",
        "event registration for nurses and midwives",
        "manage nursing course registration enquiries",
        "registered nurse recruitment",
        "worked alongside registered nurses",
        "nursing registration administration",
        "AHPRA compliance administration",
    ):
        assert not user_has_credential(phrase, contact), phrase

    assert user_has_credential("National Police Check", contact)
    assert user_has_credential("criminal history check", contact)
    assert user_has_credential("current AHPRA registration", contact)
    assert user_has_credential("current registration as a nurse", contact)
    assert user_has_credential("Nursing and Midwifery Board registration", contact)
    assert user_has_credential("registration with the Nursing and Midwifery Board of Australia", contact)
    assert user_has_credential("general registration with the Nursing and Midwifery Board of Australia", contact)


def test_user_has_credential_does_not_fabricate_driver_ndis_or_vaccination_credentials():
    """C17b full-rule sweep: professional licences, NDIS duties and disease
    context are not proof of a driver licence, screening or vaccination.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {
        "credentials": {
            "drivers_licence": "Open C Class",
            "ndis_screening": True,
            "covid_vaccination": True,
            "car_insurance": True,
        }
    }

    for phrase in (
        "security licence administration",
        "professional licence renewals",
        "software license management",
        "open source license compliance",
        "driving clients to appointments",
        "driver licence application processing",
    ):
        assert not user_has_credential(phrase, contact), phrase

    for phrase in (
        "NDIS plan implementation",
        "NDIS participant support",
        "experience delivering NDIS services",
        "NDIS orientation program facilitation",
        "NDIS quality and safeguarding framework implementation",
    ):
        assert not user_has_credential(phrase, contact), phrase

    for phrase in (
        "COVID-19 infection control",
        "coronavirus response planning",
        "COVID ward experience",
        "motor vehicle accident insurance claims",
        "COVID status dashboard administration",
    ):
        assert not user_has_credential(phrase, contact), phrase

    assert user_has_credential("valid driver licence", contact)
    assert user_has_credential("NDIS worker screening check", contact)
    assert user_has_credential("Yellow Card clearance", contact)
    assert user_has_credential("COVID-19 vaccination requirements", contact)
    assert user_has_credential("Class C licence", contact)
    assert user_has_credential("current unrestricted Australian licence", contact)
    assert user_has_credential("COVID booster requirement", contact)


def test_user_has_credential_does_not_treat_any_visa_or_citizenship_text_as_work_rights():
    """C17b: the profile's work-rights flag satisfies requirements, not
    unrelated prose that merely contains the words visa or citizenship.
    """
    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    contact = {"visa_status": "citizen", "credentials": {}}

    for phrase in (
        "visa sponsorship available",
        "administer visa application support",
        "citizenship ceremony coordination",
        "citizenship support services",
        "Australian citizen support services",
        "work rights advocacy program",
    ):
        assert not user_has_credential(phrase, contact), phrase

    assert user_has_credential("Australian work rights required", contact)
    assert user_has_credential("valid visa with work rights", contact)
    assert user_has_credential("Australian citizenship required", contact)
    assert user_has_credential("right to work in Australia", contact)
    # Exact canonical eligibility entries remain profile-backed even though
    # the same words embedded in unrelated prose no longer match.
    assert user_has_credential("visa", contact)
    assert user_has_credential("work visa", contact)
    assert user_has_credential("citizenship", contact)
    assert user_has_credential("permanent residency or citizenship", contact)
    assert user_has_credential("temporary resident visa", contact)
    assert user_has_credential("bridging visa with work rights", contact)


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
        "**Soft Skills:** Advocacy For Patients And Residents, Person-Centered Care\n"
        "\n"
        "## Experience\n"
    )
    # Test spelling conversions
    assert _canonicalise_skill_spelling("Person-Centered Care") == "Person-Centred Care"
    assert _canonicalise_skill_spelling("Advocacy For Patients And Residents") == "Patient Advocacy"

    # Test full pass and dropping of empty lines (Soft Skills line should be
    # dropped once its only remaining entry, the American-spelling
    # duplicate, is deduped against Care Skills' British-spelled entry)
    norm = _normalise_skills_case(md)
    deduped = _dedupe_skills_across_lines(norm)

    assert "Person-Centred Care" in deduped
    assert "Patient Advocacy" in deduped
    assert deduped.count("Person-Centred Care") == 1


def test_c89_patient_centred_and_person_centred_are_distinct_skills_not_deduped():
    """C89 (finding #23): patient-centred and person-centred are different
    healthcare concepts, not a spelling variant of each other -- they must
    both survive as distinct entries, not collapse into one via
    _canonicalise_skill_spelling."""
    md = (
        "## Skills\n"
        "**Care Skills:** Person-Centred Care\n"
        "**Other Skills:** Patient-Centred Care\n\n"
        "## Experience\n"
    )
    assert _canonicalise_skill_spelling("Patient-Centred Care") == "Patient-Centred Care"

    norm = _normalise_skills_case(md)
    deduped = _dedupe_skills_across_lines(norm)

    assert "Person-Centred Care" in deduped
    assert "Patient-Centred Care" in deduped
    assert "Other Skills" in deduped


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


def test_REGRESSION_C22p_writer_w8_verified_reruns_the_grounding_gate_after_verify_claims():
    """
    Regression, execution chunk C22p (found during C22j's independent
    review): verify_claims (the AI entailment-verification step) is an AI
    call that can rewrite ANY section, including reintroducing a
    fabricated credential into a Certifications/Checks section — but the
    grounding gate (_strip_ungrounded_credentials, step 4a) only ran ONCE,
    before verify_claims saw the document. Everything else this exact
    function re-runs post-verify (awards normalisers, skills hygiene,
    Sprint A/B/C passes) is because verify_claims can undo it; the
    grounding gate was the one deterministic pass in that category that
    never got re-run, capping C22j's own fix's real-world effectiveness.

    Full async integration (mocking the AI client through verify_claims)
    is disproportionate for a one-line wiring fix — this asserts the
    actual source of _writer_w8_verified calls _strip_ungrounded_credentials
    a second time, AFTER verify_claims, and BEFORE the awards-relabel
    re-run (matching the original pipeline's own relative ordering:
    ground before relabel/split), the same structural-assertion pattern
    already used elsewhere in this test suite (see
    test_cv_jd_matching_fixes.py's inspect.getsource call-site guards).
    """
    import inspect
    import re as _re

    from app.services.eval.writers import _impl

    src = inspect.getsource(_impl._writer_w8_verified)
    verify_idx = src.index("verify_claims(client")
    ground_idx = src.index("_strip_ungrounded_credentials(verified_md, cv_text)")
    relabel_idx = src.index("_relabel_awards_only_certifications(verified_md)")
    assert verify_idx < ground_idx < relabel_idx, (
        "expected verify_claims -> _strip_ungrounded_credentials -> "
        "_relabel_awards_only_certifications, in that order"
    )
    # Also confirm it's called on the VERIFIED markdown, not the pre-verify
    # variable — a copy-paste of the wrong variable name would defeat the
    # entire point of a "re-run after verify_claims" pass.
    call_line = _re.search(r"^\s*verified_md = _strip_ungrounded_credentials\(.*\)$", src, _re.MULTILINE)
    assert call_line is not None


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
