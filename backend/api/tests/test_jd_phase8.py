"""Phase 8 regression tests.

Fix: extract_credentials_from_jd was capturing prose fragments when "Cert III"
appeared mid-sentence. Root cause: (1) _has_credential_marker used re.search so
it matched ANY ngram containing "cert iii"; (2) _is_qualification_phrase uses
re.match (prefix-only), so greedy windows like "cert iii and or iv to join our"
also matched.

Fixes applied:
- Removed _has_credential_marker from extract_credentials_from_jd (stays in
  post_process_skills for LLM output).
- Added _trim_qual_phrase: walks the tail after the _QUAL_PATTERN match and
  stops at prose stop words ("to", "join", "our", "will", etc.).
- Word-boundary fix: _QUAL_PATTERN can stop mid-token ("certificate i" from
  "certificate iv") due to i{1,4} before iv in alternation; advance to end of
  current token before inspecting tail.
"""
from __future__ import annotations

from app.services.skills.post_process import (
    extract_credentials_from_jd,
    _trim_qual_phrase,
)


# ---------------------------------------------------------------------------
# _trim_qual_phrase unit tests
# ---------------------------------------------------------------------------

def test_trim_bare_cert():
    assert _trim_qual_phrase("cert iii") == "cert iii"


def test_trim_cert_iv_no_split():
    """'certificate iv' must stay intact — regex stops mid-token 'i' from 'iv'."""
    assert _trim_qual_phrase("certificate iv") == "certificate iv"


def test_trim_cert_and_or_iv():
    assert _trim_qual_phrase("cert iii and or iv") == "cert iii and or iv"


def test_trim_cert_prose_tail():
    assert _trim_qual_phrase("cert iii and or iv to join our") == "cert iii and or iv"


def test_trim_cert_with_specialty():
    """Credential specialty tail is kept."""
    assert _trim_qual_phrase("certificate iii in individual support") == \
        "certificate iii in individual support"


def test_trim_cert_prose_you_will():
    result = _trim_qual_phrase("cert iii and or iv you will provide care")
    assert "you" not in result
    assert "cert iii" in result


def test_trim_stops_at_parenthetical_alternative():
    """'(or equivalent)' / '(or Certificate IV …)' is an alternative, not part of
    the credential name — must not leak a dangling '(or'."""
    assert _trim_qual_phrase(
        "certificate iii in individual support & ageing (or equivalent)"
    ) == "certificate iii in individual support & ageing"
    assert _trim_qual_phrase(
        "certificate iii in ageing (or certificate iv in ageing support)"
    ) == "certificate iii in ageing"


def test_scan_no_dangling_paren_in_credentials():
    out = extract_credentials_from_jd(
        "Certificate III in Individual Support & Ageing (or equivalent) is desirable.\n"
    )
    all_creds = out["required"] + out["preferred"]
    assert not any(c.rstrip().endswith("(or") for c in all_creds)
    assert any("certificate iii in individual support" in c.lower() for c in all_creds)


# ---------------------------------------------------------------------------
# Prose lines must NOT appear as credentials
# ---------------------------------------------------------------------------

_HARDI_JD = (
    "We are currently looking for motivated and passionate Assistant in Nursing (AIN) "
    "Cert III and or IV to join our supportive and friendly team.\n"
    "Offering temporary part-time fixed shifts Mon - Fri AM shifts The Role As an AIN "
    "Cert III and or IV, you will provide individualised residents care.\n"
    "Must have full working rights.\n"
    "NDIS Worker Screening Check (Essential for Aged Care and Disability Facilities)\n"
    "Evidence of COVID-19 vaccination\n"
    "Permanent resident status required for this position\n"
)


def test_no_prose_in_credentials():
    """Fabricated prose like 'and passionate AIN Cert III' must NOT appear."""
    out = extract_credentials_from_jd(_HARDI_JD)
    all_creds = out["required"] + out["preferred"]
    assert not any("passionate" in c.lower() for c in all_creds)
    assert not any("join" in c.lower() for c in all_creds)
    assert not any("shifts" in c.lower() for c in all_creds)
    assert not any("role" in c.lower() for c in all_creds)


def test_ndis_still_captured():
    out = extract_credentials_from_jd(_HARDI_JD)
    all_creds = [c.lower() for c in out["required"] + out["preferred"] + out["eligibility"]]
    assert any("ndis" in c for c in all_creds)


def test_hardi_eligibility():
    out = extract_credentials_from_jd(_HARDI_JD)
    elig = [e.lower() for e in out["eligibility"]]
    assert any("vaccin" in e for e in elig)
    assert any("permanent resident" in e for e in elig)


# ---------------------------------------------------------------------------
# Clean credential lines still work correctly
# ---------------------------------------------------------------------------

_CLEAN_JD = (
    "Requirements:\n"
    "Minimum Certificate III in Aged Care, Certificate IV highly desirable.\n"
    "Current Covid-19 Vaccination required.\n"
    "Valid working rights in Australia.\n"
)


def test_clean_cert_iii_required():
    out = extract_credentials_from_jd(_CLEAN_JD)
    req = [r.lower() for r in out["required"]]
    assert any("certificate iii" in r for r in req)
    assert not any("minimum" in r for r in req)


def test_clean_cert_iv_preferred():
    out = extract_credentials_from_jd(_CLEAN_JD)
    pref = [p.lower() for p in out["preferred"]]
    assert any("certificate iv" in p for p in pref)


def test_clean_vaccination_eligibility():
    out = extract_credentials_from_jd(_CLEAN_JD)
    elig = [e.lower() for e in out["eligibility"]]
    assert any("vaccin" in e for e in elig)
    assert not any("vaccin" in c.lower() for c in out["required"] + out["preferred"])
