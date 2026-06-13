"""JD setting classifier regressions.

Tests for _classify_jd_setting in writers.py.
The classifier drives the Career Highlights bridge phrase — getting it wrong
causes the wrong setting to appear in every tailored CV for that JD.

Key invariant: "NDIS Workers Check" in a residential aged care JD is a
credential requirement, NOT a service-setting indicator. It must not trigger
the NDIS bridge.
"""
from __future__ import annotations

import pytest

from app.services.eval.writers import _classify_jd_setting


# ---------------------------------------------------------------------------
# Bolton Clarke regression (2026-06-06)
# Residential aged care JD that mentions "NDIS Workers Check" as a credential
# requirement → must NOT classify as ndis_disability.
# ---------------------------------------------------------------------------

_BOLTON_CLARKE_JD = (
    "Bolton Clarke is Australia's largest independent, not-for-profit aged care "
    "provider shaping the future of positive ageing. Today, our exceptional teams "
    "support more than 130,000 people to live independently at home and across our "
    "43 retirement living communities and 88 residential aged care homes. "
    "The Role: As a Personal Care Worker you'll provide assistance to our residents. "
    "To provide high quality, safe, and timely contemporary personal care; assisting "
    "with the functions of daily living. Support and care for residents as they age "
    "and assisting them to maintain their independence and live with dignity. "
    "Prior to commencement - complete a National Police Check and or a NDIS Workers "
    "Check (or willingness to obtain). Located in Marrickville, Willandra provides "
    "high-quality aged care in a friendly, secure and comfortable residential environment."
)

_BOLTON_ANALYSIS = {
    "job_title": "Personal Care Worker - Night shift",
    "responsibilities": [
        "provide high quality, safe and timely contemporary personal care to residents",
        "assist residents with functions of daily living according to individual needs",
        "support residents to maintain independence, dignity, self-determination and comfort",
    ],
}


def test_bolton_clarke_residential_not_ndis():
    """Bolton Clarke PCW JD mentions 'NDIS Workers Check' as a credential
    requirement only — the setting is residential aged care. Must not trigger
    the NDIS bridge."""
    result = _classify_jd_setting(_BOLTON_CLARKE_JD, _BOLTON_ANALYSIS)
    assert result == "residential", (
        f"Expected 'residential' for Bolton Clarke JD, got {result!r}. "
        "'NDIS Workers Check' is a credential requirement, not a service setting."
    )


@pytest.mark.parametrize("cred_phrase", [
    "NDIS Workers Check",
    "NDIS worker screening check",
    "NDIS worker clearance",
    "NDIS worker screening clearance",
    "NDIS worker induction module",
    "NDIS worker orientation module",
    # The abbreviation — was missing from the v228 strip and caused the
    # Australian Unity AIN bridge regression (2026-06-10).
    "NDISWC",
    "current NDISWC",
    "willingness to apply for NDISWC",
    "NDISWCs",
])
def test_ndis_credential_phrase_alone_does_not_trigger_ndis(cred_phrase):
    """Any JD that mentions only an NDIS credential phrase (no NDIS service
    delivery language) should not be classified as ndis_disability."""
    jd = (
        f"Located in a residential aged care home. "
        f"Prior to commencement complete a National Police Check and {cred_phrase}. "
        f"High-quality care in a comfortable residential environment."
    )
    analysis = {
        "job_title": "Personal Care Worker",
        "responsibilities": [
            "provide personal care to aged care residents in a residential facility"
        ],
    }
    result = _classify_jd_setting(jd, analysis)
    assert result != "ndis_disability", (
        f"Credential phrase {cred_phrase!r} incorrectly triggered NDIS setting. "
        f"Got {result!r}."
    )


# ---------------------------------------------------------------------------
# Real NDIS JDs — must still classify correctly as ndis_disability
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("jd_snippet,analysis_title,resp0", [
    (
        "NDIS registered provider supporting participants with disability. "
        "As a disability support worker you will support NDIS participants to "
        "achieve their goals. NDIS worker screening check required.",
        "NDIS Support Worker",
        "support ndis participants with disability to achieve their goals",
    ),
    (
        "We support people living with disability through NDIS funding. "
        "High intensity support needs. Acquired brain injury support. "
        "NDIS worker screening required.",
        "Disability Support Worker",
        "support individuals with disability using ndis plans and funding",
    ),
    (
        "Community care for NDIS participants. Disability support services. "
        "Non-verbal participant communication strategies. NDIS Workers Check required.",
        "Community Support Worker",
        "deliver ndis support to participants with disability in the community",
    ),
])
def test_real_ndis_jd_still_classifies_as_ndis(jd_snippet, analysis_title, resp0):
    """Genuine NDIS JDs must still classify as ndis_disability even after
    the credential-stripping fix."""
    analysis = {"job_title": analysis_title, "responsibilities": [resp0]}
    result = _classify_jd_setting(jd_snippet, analysis)
    assert result == "ndis_disability", (
        f"Expected ndis_disability for {analysis_title!r}, got {result!r}"
    )


# ---------------------------------------------------------------------------
# Other settings — unchanged by the NDIS fix
# ---------------------------------------------------------------------------

def test_home_care_setting():
    jd = "Support clients in their home with domestic assistance and meal preparation."
    analysis = {
        "job_title": "Home Care Worker",
        "responsibilities": ["assist clients in their home with daily living tasks"],
    }
    assert _classify_jd_setting(jd, analysis) == "home_community"


def test_hospital_setting():
    jd = "Work in a surgical ward with acute care patients. Hospital setting."
    analysis = {
        "job_title": "Assistant in Nursing",
        "responsibilities": ["assist patients in the surgical ward and acute care environment"],
    }
    assert _classify_jd_setting(jd, analysis) == "hospital_acute"


def test_residential_default():
    jd = "Residential aged care home. High-quality care for elderly residents."
    analysis = {
        "job_title": "Personal Care Worker",
        "responsibilities": ["provide personal care to residents in aged care home"],
    }
    assert _classify_jd_setting(jd, analysis) == "residential"


# ---------------------------------------------------------------------------
# Australian Unity AIN (2026-06-10) — NDISWC abbreviation regression
# ---------------------------------------------------------------------------

_AUSTRALIAN_UNITY_JD = (
    "Assistant in Nursing / Care Companion. The assistant in nursing provides "
    "daily care and companionship to residents in a household-style aged care "
    "environment. The role focuses on building strong relationships with "
    "residents, families, and colleagues while maintaining safety. Casual "
    "afternoon and night shifts across weekdays. Must hold a current NDISWC or "
    "have willingness to apply for NDISWC. Aged care experience preferred."
)

_AUSTRALIAN_UNITY_ANALYSIS = {
    "job_title": "Assistant In Nursing",
    "responsibilities": [
        "support residents with daily personal care and companionship",
        "build strong, trusting relationships with residents, families, and team members",
    ],
}


def test_australian_unity_ain_ndiswc_does_not_trigger_ndis():
    """Australian Unity AIN regression: the JD uses the NDISWC abbreviation
    twice but is residential aged care. Must NOT classify as ndis_disability
    (which would inject 'disability support settings' into the summary)."""
    result = _classify_jd_setting(_AUSTRALIAN_UNITY_JD, _AUSTRALIAN_UNITY_ANALYSIS)
    assert result == "residential", (
        f"Expected 'residential' for Australian Unity AIN JD, got {result!r}. "
        "NDISWC is the NDIS Workers Check abbreviation, not a sector indicator."
    )


# ---------------------------------------------------------------------------
# OLC Care PCW (lifestyle) regression (2026-06-12) — incidental
# "disability support" mention in a residential JD must not flip to NDIS.
# ---------------------------------------------------------------------------


_OLC_PCW_LIFESTYLE_JD = """\
Personal Care Worker (lifestyle) Residential Aged Care (NSW)

The role is a part-time Personal Care Worker (lifestyle) position in a
residential aged care facility in Miranda, NSW. The worker will provide
personal care and activity support, focusing on residents' leisure,
lifestyle, and social and cultural needs.

Required qualifications include Certificate III/IV in Individual Support,
Aged Care, or Disability Support. Police check required.
"""

_OLC_PCW_LIFESTYLE_ANALYSIS = {
    "job_title": "Personal Care Worker (lifestyle)",
    "responsibilities": [
        "provide personal care to residents in a residential aged care setting",
        "support residents with leisure and lifestyle activities",
    ],
}


def test_olc_pcw_lifestyle_residential_does_not_trigger_ndis():
    """OLC Care PCW (lifestyle) regression: the JD body lists 'Disability
    Support' as a qualification option, but the role is unambiguously
    residential aged care (in title, resp0, and JD body). The classifier
    must require a STRONG NDIS signal in PRIMARY (title or resp0), not
    a passing 'disability support' mention in the body, before flipping
    to NDIS. A strong residential signal in PRIMARY blocks the weak NDIS
    fallback."""
    result = _classify_jd_setting(_OLC_PCW_LIFESTYLE_JD, _OLC_PCW_LIFESTYLE_ANALYSIS)
    assert result == "residential", (
        f"Expected 'residential' for OLC PCW (lifestyle) JD, got {result!r}. "
        "'Disability support' appearing only in the qualifications list is a "
        "credential mention, not an NDIS setting marker."
    )


def test_genuine_ndis_role_still_classified_correctly():
    """Counter-test: a real Disability Support Worker JD with NDIS in the
    title still classifies as NDIS via the STRONG-tier check."""
    jd = (
        "Disability Support Worker — NDIS\n\n"
        "Provide one-on-one disability support to NDIS participants in their "
        "homes and community settings."
    )
    analysis = {
        "job_title": "Disability Support Worker",
        "responsibilities": [
            "provide disability support to NDIS participants",
        ],
    }
    result = _classify_jd_setting(jd, analysis)
    assert result == "ndis_disability", (
        f"Expected 'ndis_disability' for a Disability Support Worker role, got {result!r}."
    )


def test_disability_support_in_body_only_with_no_residential_anchor():
    """When 'disability support' appears in PRIMARY (resp0/title) and there's
    no competing residential anchor, the WEAK-tier check still fires NDIS."""
    jd = "Support Worker\n\nDeliver disability support to clients."
    analysis = {
        "job_title": "Support Worker",
        "responsibilities": [
            "deliver disability support to clients in their homes",
        ],
    }
    result = _classify_jd_setting(jd, analysis)
    # PRIMARY has 'disability support' AND no 'residential aged care' anchor →
    # WEAK tier triggers NDIS. This documents the intended fallback behaviour.
    assert result in ("ndis_disability", "home_community"), (
        f"Expected NDIS or home/community for a generic support worker JD, got {result!r}."
    )
