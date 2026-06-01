"""
Regression tests for the credentials stamping path.

Credentials captured in the user's profile (police check, NDIS Worker
Screening, WWCC, driver licence, etc.) must surface compactly on tailored
CVs for nursing/healthcare/care role families — and stay OUT of tech/
general CVs. The rendered line never includes negative content
("No licence held"), so a profile with zero held credentials is a no-op.
"""
from app.services.cv.contact_line import (
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
        "Work Rights (Citizen) · "
        "Influenza Vaccination · "
        "COVID-19 Vaccination"
    )


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
        "Work Rights (PR)"
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


def test_work_rights_hours():
    # Visa with work rights + hours -> "Working Right (Full Time)"
    cd = {
        "credentials": {
            "work_rights": "Visa with work rights",
            "work_rights_hours": "Full Time",
        }
    }
    line = build_credentials_line(cd)
    assert line == "Working Right (Full Time)"

    # Visa with work rights but no hours -> fallback to "Work Rights (Visa with work rights)"
    cd_no_hours = {
        "credentials": {
            "work_rights": "Visa with work rights",
            "work_rights_hours": "",
        }
    }
    line_no_hours = build_credentials_line(cd_no_hours)
    assert line_no_hours == "Work Rights (Visa with work rights)"

    # Citizen + hours -> hours ignored -> "Work Rights (Citizen)"
    cd_citizen = {
        "credentials": {
            "work_rights": "Citizen",
            "work_rights_hours": "Part Time",
        }
    }
    line_citizen = build_credentials_line(cd_citizen)
    assert line_citizen == "Work Rights (Citizen)"

