"""
Regression tests for the credentials stamping path.

Credentials captured in the user's profile (police check, NDIS Worker
Screening, WWCC, driver licence, etc.) must surface compactly on tailored
CVs for nursing/healthcare/care role families — and stay OUT of tech/
general CVs. The rendered line never includes negative content
("No licence held"), so a profile with zero held credentials is a no-op.
"""
from app.services.cv.contact_line import (
    build_availability_line,
    build_credentials_line,
    stamp_credentials,
)


# ---------------------------------------------------------------------------
# build_credentials_line — line composition
# ---------------------------------------------------------------------------

def test_empty_or_missing_returns_empty_string():
    assert build_credentials_line(None) == ""
    assert build_credentials_line({}) == ""
    assert build_credentials_line({"credentials": None}) == ""
    assert build_credentials_line({"credentials": {}}) == ""


def test_only_truthy_credentials_surface():
    cd = {"credentials": {
        "police_check":          True,
        "ndis_screening":        False,   # explicit false → omitted
        "wwcc":                  True,
        "wwcc_state":            "NSW",
        "first_aid":             True,
        "cpr":                   False,
        "drivers_licence":       "Open",
        "own_car":               True,
        "car_insurance":         False,
        "work_rights":           "Citizen",
        "flu_vaccination":       True,
        "covid_vaccination":     True,
        "medication_competency": True,
        "ahpra_number":          "",     # blank → omitted
    }}
    line = build_credentials_line(cd)
    # Order: registrations → clearances → certs → practical → status
    assert line == (
        "National Police Check · "
        "Working with Children Check (NSW) · "
        "First Aid (HLTAID011) · "
        "Medication Competency · "
        "Driver Licence (Open) · "
        "Own a car · "
        "Citizenship · "
        "Influenza Vaccination · "
        "COVID-19 Vaccination"
    )


def test_availability_is_opt_in_and_separate_from_credentials_line():
    # Availability NEVER appears on the credentials line itself — it is a
    # separate italic line rendered by stamp_credentials.
    cd_on = {"credentials": {
        "police_check": True,
        "availability": ["Casual", "Full Time", "Part Time"],
        "show_availability": True,
    }}
    assert build_credentials_line(cd_on) == "National Police Check"

    # build_availability_line — opt-in gating + canonical order (Full Time →
    # Part Time → Casual) regardless of tick order.
    assert build_availability_line(cd_on) == "Available: Full Time, Part Time, Casual"

    # show_availability off → empty even when types are ticked
    assert build_availability_line({"credentials": {
        "availability": ["Casual", "Part Time"], "show_availability": False,
    }}) == ""

    # opted in but nothing ticked → empty
    assert build_availability_line({"credentials": {
        "availability": [], "show_availability": True,
    }}) == ""


def test_availability_not_in_credentials_section():
    """Availability moved to the Professional Summary — it must NOT appear in
    the Registration & Licences block any more."""
    md = "# Jane\n\nNSW | 0400\n\n## Experience\n- x\n"
    cd = {"credentials": {
        "police_check": True,
        "availability": ["Casual", "Part Time"],
        "show_availability": True,
    }}
    out = stamp_credentials(md, cd, "nursing")
    assert "## Registration & Licences" in out
    assert "National Police Check" in out
    assert "Available" not in out  # availability is stamped into the summary now


def test_availability_appended_to_professional_summary():
    from app.services.cv.contact_line import stamp_availability_in_summary
    md = (
        "# Jane\n\nNSW | 0400\n\n"
        "## Professional Summary\n\nAssistant in Nursing with aged-care experience.\n\n"
        "## Experience\n- x\n"
    )
    cd = {"credentials": {
        "availability": ["Casual", "Full Time", "Part Time"],
        "show_availability": True,
    }}
    out = stamp_availability_in_summary(md, cd, "nursing")
    # italic line, canonical order, sits inside the summary section
    assert "*Available: Full Time, Part Time, Casual*" in out
    summary_part = out.split("## Experience")[0]
    assert "*Available: Full Time, Part Time, Casual*" in summary_part
    # off → no-op
    cd_off = {"credentials": {"availability": ["Casual"], "show_availability": False}}
    assert stamp_availability_in_summary(md, cd_off, "nursing") == md
    # non-credentialed family → no-op
    assert stamp_availability_in_summary(md, cd, "tech") == md


def test_availability_stamp_is_idempotent():
    """Called twice (mid-pipeline + after verify_claims) it must NOT duplicate
    the line, and it must clear any stale/leftover availability line first."""
    from app.services.cv.contact_line import stamp_availability_in_summary
    md = (
        "## Professional Summary\n\nAssistant in Nursing with aged-care experience.\n\n"
        "## Experience\n- x\n"
    )
    cd = {"credentials": {"availability": ["Casual", "Full Time"], "show_availability": True}}
    once = stamp_availability_in_summary(md, cd, "nursing")
    twice = stamp_availability_in_summary(once, cd, "nursing")
    assert once == twice                       # idempotent
    assert once.count("*Available:") == 1      # exactly one note


def test_ahpra_number_leads_when_present():
    line = build_credentials_line({"credentials": {
        "ahpra_number": "NMW0001234567",
        "police_check": True,
    }})
    assert line.startswith("AHPRA NMW0001234567 · ")
    assert "National Police Check" in line


def test_wwcc_without_state_uses_bare_label():
    line = build_credentials_line({"credentials": {"wwcc": True}})
    assert line == "Working with Children Check"


def test_drivers_licence_only_emitted_when_class_specified():
    # A non-empty string indicates the user holds it.
    line = build_credentials_line({"credentials": {"drivers_licence": "Provisional"}})
    assert line == "Driver Licence (Provisional)"
    # Blank / missing class → no entry at all (the field is OFF).
    assert build_credentials_line({"credentials": {"drivers_licence": ""}}) == ""


# ---------------------------------------------------------------------------
# stamp_credentials — markdown injection
# ---------------------------------------------------------------------------

_BASE_MD = (
    "# Maheshwor Tiwari\n\n"
    "Contact line\n\n"
    "## Professional Summary\n\n"
    "Two sentences here.\n\n"
    "## Experience\n\n"
    "### Jesmond Miranda Nursing Home\n"
    "- Did things.\n"
)

_CREDS = {"credentials": {
    "police_check":   True,
    "ndis_screening": True,
    "wwcc":           True,
    "wwcc_state":     "NSW",
    "first_aid":      True,
}}


def test_stamp_inserts_section_when_absent_for_nursing():
    out = stamp_credentials(_BASE_MD, _CREDS, "nursing")
    assert "## Registration & Licences" in out
    assert "National Police Check · NDIS Worker Screening" in out
    # Section sits AFTER Professional Summary (at the end)
    summary_idx = out.index("## Professional Summary")
    creds_idx = out.index("## Registration & Licences")
    assert creds_idx > summary_idx


def test_stamp_replaces_existing_section_body():
    md = (
        "# Name\n\nContact\n\n"
        "## Registration & Licences\n\n"
        "Some AI-emitted noise\n- Bullet 1\n\n"
        "## Experience\n- Did things.\n"
    )
    out = stamp_credentials(md, _CREDS, "nursing")
    # AI body is GONE; the deterministic line is the new body.
    assert "Some AI-emitted noise" not in out
    assert "Bullet 1" not in out
    assert "National Police Check" in out
    # Only one Registration & Licences heading.
    assert out.count("## Registration & Licences") == 1


def test_stamp_noop_for_non_credentialed_family():
    """Tech/general CVs must NEVER carry a Registration & Licences block."""
    for family in ("tech", "master", None):
        out = stamp_credentials(_BASE_MD, _CREDS, family)
        assert "## Registration & Licences" not in out, family
        assert out == _BASE_MD, family


def test_manual_family_renders_trade_certs_and_drops_clinical():
    """Manual / Service CVs surface trade certs (White Card, Forklift) and
    basic clearances/transport — NOT AHPRA, NDIS, First Aid, CPR, or
    Medication Competency (those are nursing-only)."""
    cd = {"credentials": {
        "white_card":         True,
        "forklift_licence":   "LF",
        "police_check":       True,
        "wwcc":               True,
        "wwcc_state":         "NSW",
        "drivers_licence":    "Open",
        "own_car":            True,
        "work_rights":        "PR",
        # Nursing-only fields supplied but MUST be excluded:
        "ahpra_number":       "NMW0001234567",
        "ndis_screening":     True,
        "first_aid":          True,
        "cpr":                True,
        "medication_competency": True,
        "car_insurance":      True,
        "flu_vaccination":    True,
        "covid_vaccination":  True,
    }}
    line = build_credentials_line(cd, family_id="manual")
    assert line == (
        "White Card · "
        "Forklift Licence (LF) · "
        "National Police Check · "
        "Working with Children Check (NSW) · "
        "Driver Licence (Open) · "
        "Own a car · "
        "PR"
    )


def test_manual_family_stamps_section():
    """The manual family is wired into stamp_credentials, so a manual CV
    gets the Registration & Licences block injected just like nursing."""
    cd = {"credentials": {"white_card": True, "police_check": True}}
    out = stamp_credentials(_BASE_MD, cd, "manual")
    assert "## Registration & Licences" in out
    assert "White Card · National Police Check" in out


def test_stamp_noop_when_credentials_empty():
    out = stamp_credentials(_BASE_MD, {"credentials": {}}, "nursing")
    assert out == _BASE_MD
    out2 = stamp_credentials(_BASE_MD, None, "nursing")
    assert out2 == _BASE_MD


def test_stamp_noop_when_all_creds_false():
    """A profile with every credential field False/empty must produce no
    section — we never advertise what the candidate doesn't hold."""
    cd = {"credentials": {
        "police_check": False, "ndis_screening": False, "wwcc": False,
        "first_aid": False, "cpr": False, "own_car": False,
        "car_insurance": False, "flu_vaccination": False,
        "medication_competency": False,
        "drivers_licence": "", "work_rights": "", "ahpra_number": "",
    }}
    out = stamp_credentials(_BASE_MD, cd, "nursing")
    assert "## Registration & Licences" not in out
    assert out == _BASE_MD


def test_drivers_licence_yes_no():
    # If drivers_licence is "Yes", render as "Driver Licence" (no parentheses)
    line_yes = build_credentials_line({"credentials": {"drivers_licence": "Yes"}})
    assert line_yes == "Driver Licence"
    
    # If drivers_licence is "No", omit entirely
    line_no = build_credentials_line({"credentials": {"drivers_licence": "No"}})
    assert line_no == ""


def test_work_rights_visa_with_hours():
    # Visa with work rights + hours -> "Work Rights (Full Time)"
    cd = {
        "credentials": {
            "work_rights": "Visa with work rights",
            "work_rights_hours": "Full Time",
        }
    }
    assert build_credentials_line(cd) == "Work Rights (Full Time)"

    cd_pt = {
        "credentials": {
            "work_rights": "Visa with work rights",
            "work_rights_hours": "Part Time",
        }
    }
    assert build_credentials_line(cd_pt) == "Work Rights (Part Time)"


def test_work_rights_visa_without_hours():
    # Visa with work rights but no hours -> bare "Work Rights"
    # (never the self-referential "Work Rights (Visa with work rights)")
    cd_no_hours = {
        "credentials": {
            "work_rights": "Visa with work rights",
            "work_rights_hours": "",
        }
    }
    line = build_credentials_line(cd_no_hours)
    assert line == "Work Rights"
    assert "Visa with work rights" not in line


def test_work_rights_citizen_renders_citizenship():
    # Citizen -> "Citizenship" (hours ignored)
    cd = {"credentials": {"work_rights": "Citizen", "work_rights_hours": "Part Time"}}
    assert build_credentials_line(cd) == "Citizenship"


def test_work_rights_pr_renders_pr():
    # PR -> "PR" (hours ignored)
    cd = {"credentials": {"work_rights": "PR", "work_rights_hours": "Full Time"}}
    assert build_credentials_line(cd) == "PR"

