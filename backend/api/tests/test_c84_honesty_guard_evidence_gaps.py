"""C84 — regression tests for honesty_guard.py evidence/date/credential gaps
(findings #6, #7, #8, #9 from the C79 writers/* read-through, documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

  #6 — enforce_source_settings's evidence check is OR-of-generic-keywords,
       not "does the source actually support this claim." For claim "acute
       hospital", evidence = (r"acute", r"hospital") combined with any(...)
       — either word ALONE anywhere in source bullets "proves" the claim.

  #7 — enforce_source_dates's _dates_appear_in_source validates by checking
       if year digits appear ANYWHERE in the source text — collides with
       Australian postcodes (a source address like "...NSW 2017" makes a
       fabricated "Jan 2017 - Dec 2017" pass validation on the
       employer-match-failed fallback path).

  #8 — enforce_credential_claims only strips a credential when immediately
       followed by a fixed trailing-noun list (clearance|check|screening|
       endorsement|compliance|requirements). Real phrasings escape: "AIN
       with current WWCC and First Aid certification" and "Holds a current
       National Police Certificate" both survive unstripped.

  #9 — _SETTING_DESCRIPTORS regex strips lack a trailing word boundary,
       corrupting partial words: "NDIS Homecare Package" -> strip produces
       'care Package' (consumed "NDIS Home" out of "Homecare").
"""
from __future__ import annotations

from app.services.eval.writers.honesty_guard import (
    enforce_credential_claims,
    enforce_source_dates,
    enforce_source_settings,
)


# ---------------------------------------------------------------------------
# #9 — trailing word boundary corrupts partial words
# ---------------------------------------------------------------------------


def test_c9_ndis_home_descriptor_does_not_corrupt_homecare():
    """'NDIS Homecare Package' must not be mangled into 'care Package' —
    the descriptor 'ndis home' must not match inside the single word
    'Homecare'."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*NDIS Homecare Package Coordinator | Jan 2020 – Present*\n"
        "- Coordinated support plans for participants.\n"
    )
    cv_text = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Support Worker | Jan 2020 – Present*\n"
        "- Delivered residential aged care.\n"
    )
    out, _notes = enforce_source_settings(md, cv_text)
    # "NDIS Home" has no trailing word boundary before "care" (same word,
    # no space) so the descriptor must not match "Homecare" at all — the
    # role line must survive completely untouched, not partially mangled
    # into e.g. "care Package Coordinator".
    assert out == md, f"role line was corrupted:\n{out}"


# ---------------------------------------------------------------------------
# #6 — OR-of-generic-keywords evidence check
# ---------------------------------------------------------------------------


def test_c6_acute_hospital_descriptor_not_evidenced_by_incidental_hospital_mention():
    """Source = residential aged care, one bullet incidentally mentions
    'hospital' (liaising with discharge planners, not the candidate's own
    hospital experience) — must NOT be enough to evidence an 'acute
    hospital' claim in the tailored role header."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Acute Hospital Placement | Jan 2020 – Present*\n"
        "- Delivered personal care to residents.\n"
    )
    cv_text = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- Liaised with hospital discharge planners to coordinate resident "
        "transitions.\n"
    )
    out, notes = enforce_source_settings(md, cv_text)
    assert "Acute Hospital" not in out, f"fabricated setting survived: {out!r}"
    assert notes, "expected a strip note"


def test_c6_acute_hospital_descriptor_evidenced_by_genuine_hospital_ward_source():
    """Sanity: genuine hospital-ward evidence in source must still let the
    descriptor survive — this isn't a blanket strip."""
    md = (
        "## Experience\n\n"
        "### City Hospital | Sydney, NSW\n"
        "*Acute Hospital Placement | Jan 2020 – Present*\n"
        "- Supported patients on a surgical ward.\n"
    )
    cv_text = (
        "## Experience\n\n"
        "### City Hospital\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- Worked on the acute hospital ward supporting patient care.\n"
    )
    out, _notes = enforce_source_settings(md, cv_text)
    assert "Acute Hospital" in out


def test_c6_operating_theatre_descriptor_not_evidenced_by_theatre_outing():
    """'theatre' alone in the source (a resident activities outing, not
    surgical theatre) must not evidence an 'operating theatre' claim."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Operating Theatre Support | Jan 2020 – Present*\n"
        "- Assisted residents with daily care.\n"
    )
    cv_text = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care\n"
        "*Lifestyle Assistant | Jan 2020 – Present*\n"
        "- Organised theatre outings for residents.\n"
    )
    out, _notes = enforce_source_settings(md, cv_text)
    assert "Operating Theatre" not in out


# ---------------------------------------------------------------------------
# #7 — postcode/date-year collision
# ---------------------------------------------------------------------------


def test_c7_fabricated_date_range_not_validated_by_a_matching_postcode():
    """A source address containing an AU postcode that happens to match a
    fabricated role's year figures must not "prove" the date range —
    'NSW 2017' must not validate a fabricated 'Jan 2017 - Dec 2017'."""
    md = (
        "## Experience\n\n"
        "### Unmatched Employer Pty Ltd | Sydney, NSW\n"
        "*Support Worker | Jan 2017 – Dec 2017*\n"
        "- Provided personal care.\n"
    )
    # Genuine source entry (so facts.entries is non-empty) for a DIFFERENT
    # employer, plus a postcode address that shares digits with the
    # fabricated role's years above — the employer above has no matching
    # source entry, so the fallback "does this year appear anywhere in
    # source text" path is exercised.
    cv_text = (
        "## Experience\n\n"
        "### Real Employer Pty Ltd | Sydney, NSW 2017\n"
        "*Support Worker | Jan 2019 – Dec 2020*\n"
        "- Provided personal care.\n"
    )
    out, notes = enforce_source_dates(md, cv_text)
    assert "Jan 2017 – Dec 2017" not in out, (
        f"fabricated date range survived, validated by a postcode digit "
        f"match:\n{out}\nnotes={notes}"
    )


def test_c7_genuine_matching_year_still_validates():
    """Sanity: a year that genuinely appears in source prose (not just a
    postcode) must still validate — this isn't a blanket rejection."""
    md = (
        "## Experience\n\n"
        "### Unmatched Employer Pty Ltd | Sydney, NSW\n"
        "*Support Worker | Jan 2019 – Dec 2019*\n"
        "- Provided personal care.\n"
    )
    cv_text = (
        "## Experience\n\n"
        "### Real Employer Pty Ltd | Sydney, NSW\n"
        "*Support Worker | Jan 2019 – Dec 2020*\n"
        "- Provided personal care.\n"
    )
    out, _notes = enforce_source_dates(md, cv_text)
    assert "Jan 2019 – Dec 2019" in out


# ---------------------------------------------------------------------------
# #8 — narrow trailing-noun list on credential claims
# ---------------------------------------------------------------------------


def test_c8_wwcc_followed_by_and_survives_unstripped_currently_a_bug():
    """'AIN with current WWCC and First Aid certification' — WWCC is a
    self-contained credential name (the 'C' already stands for Check) and
    must be stripped when unheld, regardless of what follows it."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- AIN with current WWCC and First Aid certification.\n"
    )
    out, notes = enforce_credential_claims(md, {"credentials": {}})
    assert "WWCC" not in out, f"unverifiable WWCC claim survived: {out!r}"
    assert notes


def test_c8_national_police_certificate_survives_unstripped_currently_a_bug():
    """'Holds a current National Police Certificate' — 'Certificate' is a
    real trailing noun for a police credential claim, not just
    clearance/check/screening/endorsement/compliance/requirements."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- Holds a current National Police Certificate.\n"
    )
    out, notes = enforce_credential_claims(md, {"credentials": {}})
    assert "Police Certificate" not in out, f"unverifiable claim survived: {out!r}"
    assert notes


def test_c8_wwcc_stripped_when_user_genuinely_holds_it():
    """Sanity: a WWCC claim must survive when the user's profile evidences
    they actually hold it — this isn't a blanket strip."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- Current WWCC.\n"
    )
    out, _notes = enforce_credential_claims(md, {"credentials": {"wwcc": True}})
    assert "WWCC" in out


def test_c8_compound_clause_strip_unaffected_by_the_trailing_noun_refactor():
    """Regression lock for the pre-existing compound-clause path (no prior
    test coverage existed for this shape) — _COMPOUND_CLAIM_RE was rebuilt
    on the shared _CREDENTIAL_TRAILING_NOUNS constant as part of the #8
    fix; this confirms the original working case is untouched."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- AIN with current compliance for pre-employment medical, police, "
        "and NDIS worker clearances.\n"
    )
    out, notes = enforce_credential_claims(md, {"credentials": {}})
    assert "- AIN\n" in out
    assert "pre-employment medical" not in out
    assert notes


def test_c8_compound_clause_strip_with_certificate_as_the_trailing_noun():
    """A police claim ending in 'Certificate' rather than 'clearance'/'check'
    must also be caught — via the per-family Stage 2 path (see the
    'compound clause must NOT gain certificate' tests below for why this
    isn't routed through the compound-clause regex)."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2020 – Present*\n"
        "- AIN with current National Police Certificate.\n"
    )
    out, notes = enforce_credential_claims(md, {"credentials": {}})
    assert "Police Certificate" not in out
    assert notes


# ---------------------------------------------------------------------------
# Round-2 independent review findings (3 blockers on the first #8/#9 fix)
# ---------------------------------------------------------------------------


class TestCompoundClauseMustNotOverStripOnCertificate:
    """BLOCKER 1: adding certificate(s)/certification(s) to the COMPOUND
    clause's trailing-noun set (not just the per-family Stage 2 set) let
    the unanchored ' with ... (trailing noun)' filler span across entirely
    unrelated prose whenever a genuine qualification sentence ("Certificate
    III in Individual Support" — the standard AU aged-care qualification)
    happened to follow a ' with ' earlier in the same bullet, deleting
    everything in between including real content."""

    def test_ndis_practice_standards_familiarity_not_mangled(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Familiar with NDIS Practice Standards and hold a current "
            "Certificate III in Individual Support.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "Certificate III in Individual Support" in out
        assert "Familiar" in out

    def test_worked_with_ndis_participants_not_mangled(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Worked with NDIS participants across community access, "
            "holding Certificate III in Individual Support.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "Certificate III in Individual Support" in out
        assert "Worked" in out

    def test_liaised_with_police_officers_not_mangled(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Liaised with police liaison officers and community services "
            "while completing my Certificate IV in Ageing Support.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "Certificate IV in Ageing Support" in out
        assert "Liaised" in out


class TestSelfContainedFamiliesMustNotStripDutyProse:
    """BLOCKER 2: dropping the trailing-noun requirement entirely for
    WWCC/pre-employment-medical (so they'd strip on the bare family word
    alone) also stripped genuine DUTY descriptions — administering or
    processing a credential for OTHERS, not claiming to hold one."""

    def test_coordinating_pre_employment_medical_assessments_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Coordinated pre-employment medical assessments for 40+ new "
            "care staff.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "pre-employment medical" in out.lower()

    def test_maintaining_the_wwcc_register_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Maintained the WWCC register for 60 staff members as "
            "rostering coordinator.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" in out

    def test_training_staff_on_blue_card_renewal_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Trained new staff on the blue card renewal process for the "
            "facility.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "blue card" in out.lower()

    def test_genuine_wwcc_claim_still_stripped_when_unheld(self):
        """Sanity: a genuine first-person claim ('with current WWCC') must
        still be stripped — this isn't a blanket exemption for WWCC."""
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- AIN with current WWCC and First Aid certification.\n"
        )
        out, notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" not in out
        assert notes


class TestClaimPrefixModeDoesNotMatchBarePrepositionalWith:
    """Round-3 independent review found the claim_prefix mode's original
    '\\bwith\\s+(?:current\\s+)?' alternative made "current" optional, so
    it matched ANY 'with <family>' — including duty prose that also uses
    "with" as an ordinary preposition, not a first-person credential
    claim."""

    def test_liaised_with_wwcc_administrators_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Liaised with WWCC administrators at the department.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" in out

    def test_assisted_with_pre_employment_medical_bookings_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Assisted with pre-employment medical bookings for new hires.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "pre-employment medical" in out.lower()

    def test_worked_with_blue_card_holders_not_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Rostering Coordinator | Jan 2020 – Present*\n"
            "- Worked with blue card holders to schedule community access "
            "shifts.\n"
        )
        out, _notes = enforce_credential_claims(md, {"credentials": {}})
        assert "blue card" in out.lower()


class TestClaimPrefixFamiliesAlsoCatchTrailingNounClaims:
    """Round-3 independent review: making claim_prefix families require a
    PREFIX regressed coverage for genuine claims phrased with a trailing
    noun instead — 'Obtained WWCC clearance' has no 'with current'/'holds'/
    'current' prefix, but is still an unambiguous claim. The check must be
    additive: trailing-noun suffix OR claim-prefix, either one proves it."""

    def test_obtained_wwcc_clearance_still_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Obtained WWCC clearance in 2019 prior to commencing.\n"
        )
        out, notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" not in out
        assert notes

    def test_completed_wwcc_check_still_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Completed WWCC check before starting the role.\n"
        )
        out, notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" not in out
        assert notes

    def test_renewed_wwcc_check_still_stripped(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Renewed my WWCC check in March 2023.\n"
        )
        out, notes = enforce_credential_claims(md, {"credentials": {}})
        assert "WWCC" not in out
        assert notes


class TestSettingDescriptorPluralsStillStrip:
    """BLOCKER 3: adding a bare trailing \\b to every _SETTING_DESCRIPTORS
    pattern (not just 'ndis home', which needed it to avoid matching inside
    'Homecare') broke plural matching for every OTHER descriptor —
    'Retirement Villages Coordinator' etc. now survived unstripped even
    with zero source evidence, the opposite direction from the original
    corruption bug (a fabrication surviving, not a real phrase mangled)."""

    def test_retirement_villages_plural_still_strips_without_evidence(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Retirement Villages Coordinator | Jan 2020 – Present*\n"
            "- Coordinated activities for residents.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Delivered residential aged care.\n"
        )
        out, _notes = enforce_source_settings(md, cv_text)
        assert "Retirement Villages" not in out

    def test_hospital_wards_plural_still_strips_without_evidence(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Hospital Wards Assistant | Jan 2020 – Present*\n"
            "- Provided personal care to residents.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care\n"
            "*Assistant in Nursing | Jan 2020 – Present*\n"
            "- Delivered residential aged care.\n"
        )
        out, _notes = enforce_source_settings(md, cv_text)
        assert "Hospital Wards" not in out

    def test_operating_theatres_plural_still_strips_without_evidence(self):
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Operating Theatres Aide | Jan 2020 – Present*\n"
            "- Assisted residents with daily care.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care\n"
            "*Lifestyle Assistant | Jan 2020 – Present*\n"
            "- Organised theatre outings for residents.\n"
        )
        out, _notes = enforce_source_settings(md, cv_text)
        assert "Operating Theatres" not in out

    def test_ndis_home_still_does_not_corrupt_homecare_with_plural_suffix(self):
        """Regression guard: adding s? before \\b to fix the plural bug
        must not reopen the original #9 'Homecare' corruption."""
        md = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*NDIS Homecare Package Coordinator | Jan 2020 – Present*\n"
            "- Coordinated support plans for participants.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care\n"
            "*Support Worker | Jan 2020 – Present*\n"
            "- Delivered residential aged care.\n"
        )
        out, _notes = enforce_source_settings(md, cv_text)
        assert out == md


class TestDateGuardPostcodeExclusionDoesNotDropGenuineDates:
    """MEDIUM: excluding every year-after-state-abbreviation occurrence
    unconditionally also excluded GENUINE inline year mentions that happen
    to follow a state abbreviation without a postcode's typical
    end-of-address termination — a heading like 'Brisbane QLD 2015 - 2018'
    or prose like 'Relocated to NSW 2016 and continued casual shifts'."""

    def test_year_immediately_followed_by_a_dash_range_still_counts(self):
        md = (
            "## Experience\n\n"
            "### Unmatched Employer Pty Ltd | Sydney, NSW\n"
            "*Support Worker | Jan 2015 – Dec 2015*\n"
            "- Provided personal care.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Aged Care Plus, Brisbane QLD 2015 - 2018\n"
            "*Support Worker | Jan 2015 – Dec 2018*\n"
            "- Provided personal care.\n"
        )
        out, _notes = enforce_source_dates(md, cv_text)
        assert "Jan 2015 – Dec 2015" in out

    def test_year_immediately_followed_by_and_still_counts(self):
        md = (
            "## Experience\n\n"
            "### Unmatched Employer Pty Ltd | Sydney, NSW\n"
            "*Support Worker | Jan 2016 – Dec 2016*\n"
            "- Provided personal care.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Real Employer Pty Ltd\n"
            "*Support Worker | Jan 2019 – Dec 2020*\n"
            "- Relocated to NSW 2016 and continued casual shifts.\n"
        )
        out, _notes = enforce_source_dates(md, cv_text)
        assert "Jan 2016 – Dec 2016" in out

    def test_postcode_at_end_of_address_still_excluded(self):
        """Sanity: the original #7 repro (a bare postcode with nothing
        date-like following it) must still be excluded — this isn't a
        blanket re-opening of the hole."""
        md = (
            "## Experience\n\n"
            "### Unmatched Employer Pty Ltd | Sydney, NSW\n"
            "*Support Worker | Jan 2017 – Dec 2017*\n"
            "- Provided personal care.\n"
        )
        cv_text = (
            "## Experience\n\n"
            "### Real Employer Pty Ltd | Sydney, NSW 2017\n"
            "*Support Worker | Jan 2019 – Dec 2020*\n"
            "- Provided personal care.\n"
        )
        out, _notes = enforce_source_dates(md, cv_text)
        assert "Jan 2017 – Dec 2017" not in out
