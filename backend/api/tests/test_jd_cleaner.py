"""Tests for app.services.preprocessing.jd_cleaner.

Covers:
  - Golden JD transparency (no boilerplate in golden fixtures → output preserves
    all skill content and does NOT trigger the fallback).
  - Synthetic JDs with boilerplate sections → boilerplate stripped, skills kept.
  - All-boilerplate JD → fallback returns raw text unchanged.
  - Heading variants: ALL CAPS, with and without colons, markdown markers.
  - Preamble preservation (content before any heading is always kept).
  - Empty-input guard.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Tuple

import pytest

from app.services.preprocessing.jd_cleaner import clean_jd_text

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_JDS_DIR = Path(__file__).parent / "golden" / "jds"


def _load_jd_body(jd_id: str) -> str:
    """Return the JD body from a golden fixture (strips YAML frontmatter)."""
    text = (_JDS_DIR / f"{jd_id}.md").read_text()
    parts = text.split("---", 2)
    if len(parts) < 3:
        return text
    return parts[2].lstrip("\n")


# ---------------------------------------------------------------------------
# Golden JD transparency — no boilerplate in the golden corpus
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("jd_id,expected_phrases", [
    (
        "nursing-residential-ain",
        ["personal care", "showering", "mobility", "clinical documentation",
         "empathy", "communication"],
    ),
    (
        "nursing-home-care-pcw",
        ["showering", "toileting", "empathy", "verbal communication", "driver"],
    ),
    (
        "tech-backend-engineer",
        ["python", "postgresql", "docker", "kubernetes", "rest api",
         "problem solving", "communication"],
    ),
    (
        "cleaning-commercial",
        ["vacuuming", "mopping", "bathroom cleaning", "cleaning chemicals",
         "attention to detail"],
    ),
])
def test_golden_jd_preserves_skill_content(jd_id: str, expected_phrases: list):
    """Golden JDs contain no boilerplate — the cleaner must keep all content."""
    body = _load_jd_body(jd_id)
    cleaned, sections = clean_jd_text(body)

    # Fallback must NOT fire — all four golden JDs have at least one skill heading.
    assert "_fallback" not in sections, (
        f"{jd_id}: fallback triggered unexpectedly; "
        f"detected sections: {list(sections)}"
    )

    # Every expected skill phrase must survive in the cleaned output.
    cleaned_lower = cleaned.lower()
    for phrase in expected_phrases:
        assert phrase.lower() in cleaned_lower, (
            f"{jd_id}: expected phrase '{phrase}' missing from cleaned output"
        )


# ---------------------------------------------------------------------------
# Synthetic JDs with boilerplate
# ---------------------------------------------------------------------------

_SYNTHETIC_WITH_BOILERPLATE = """\
Residential Care Worker — Aged Care

We are hiring compassionate care workers for our 80-bed home.

About Us:
Founded in 2005, Sunshine Care Group has grown to become one of
Sydney's most trusted aged care providers. We hold ISO 9001 certification.

Key Responsibilities:
- Provide personal care including showering, dressing and grooming.
- Assist residents with mobility and hoist transfers.
- Administer medications under RN supervision.

Benefits:
- Competitive salary above award.
- Free parking on site.
- Staff wellness programme.

What We Are Looking For:
- Certificate III in Individual Support or equivalent.
- Current First Aid and CPR.
- Empathy and commitment to person-centred care.

How to Apply:
Send your CV to careers@sunshinecare.com.au with the subject line
"Care Worker Application".
"""

def test_synthetic_boilerplate_stripped():
    cleaned, sections = clean_jd_text(_SYNTHETIC_WITH_BOILERPLATE)
    cleaned_lower = cleaned.lower()

    # Skill content must be present.
    assert "personal care" in cleaned_lower
    assert "showering" in cleaned_lower
    assert "mobility" in cleaned_lower
    assert "empathy" in cleaned_lower
    assert "certificate iii" in cleaned_lower
    assert "first aid" in cleaned_lower

    # Boilerplate content must be absent.
    assert "iso 9001" not in cleaned_lower, "About Us content should be stripped"
    assert "competitive salary" not in cleaned_lower, "Benefits should be stripped"
    assert "careers@sunshinecare" not in cleaned_lower, "How to Apply should be stripped"

    # Section map should record discarded headings.
    assert "_boilerplate" in sections


def test_synthetic_boilerplate_no_fallback():
    _, sections = clean_jd_text(_SYNTHETIC_WITH_BOILERPLATE)
    assert "_fallback" not in sections


# ---------------------------------------------------------------------------
# All-boilerplate JD → fallback
# ---------------------------------------------------------------------------

_ALL_BOILERPLATE = """\
About Us:
We are a family-owned aged care company since 1978. Quality care since forever.

Benefits:
- Above-award wages.
- 5 weeks annual leave.
- Study support.

How to Apply:
Email your application to hr@example.com.
"""

def test_all_boilerplate_triggers_fallback():
    cleaned, sections = clean_jd_text(_ALL_BOILERPLATE)
    assert "_fallback" in sections
    # Fallback must return the raw text unchanged.
    assert cleaned == _ALL_BOILERPLATE


# ---------------------------------------------------------------------------
# Preamble preservation
# ---------------------------------------------------------------------------

_WITH_PREAMBLE = """\
Support Worker — NDIS

This is a fantastic opportunity for a caring individual to join our team.

Requirements:
- Current NDIS Worker Screening Check.
- Certificate III in Individual Support or equivalent.
- Manual handling experience.
"""

def test_preamble_kept():
    cleaned, sections = clean_jd_text(_WITH_PREAMBLE)
    # The preamble (lines before first heading) must be in the output.
    assert "fantastic opportunity" in cleaned
    # Skill content too.
    assert "manual handling" in cleaned.lower()
    assert "_fallback" not in sections


# ---------------------------------------------------------------------------
# Heading format variants
# ---------------------------------------------------------------------------

_ALL_CAPS_HEADINGS = """\
REQUIREMENTS
- Experience in residential aged care.
- Ability to work rotating shifts.

ABOUT US
Established in 1990, we care deeply about our staff.

BENEFITS
- Great pay.
- Flexible rosters.
"""

def test_all_caps_skill_heading_kept():
    cleaned, sections = clean_jd_text(_ALL_CAPS_HEADINGS)
    cleaned_lower = cleaned.lower()
    assert "residential aged care" in cleaned_lower
    assert "rotating shifts" in cleaned_lower


def test_all_caps_boilerplate_stripped():
    cleaned, _ = clean_jd_text(_ALL_CAPS_HEADINGS)
    cleaned_lower = cleaned.lower()
    assert "established in 1990" not in cleaned_lower
    assert "great pay" not in cleaned_lower


_NO_COLON_KNOWN_HEADING = """\
About The Role
Provide person-centred care and support daily living activities.

About Us
We are a leading provider across New South Wales.
"""

def test_known_heading_without_colon():
    cleaned, sections = clean_jd_text(_NO_COLON_KNOWN_HEADING)
    # "About The Role" is a known skill heading even without a colon.
    assert "person-centred care" in cleaned.lower()
    # "About Us" is boilerplate.
    assert "leading provider" not in cleaned.lower()
    assert "_fallback" not in sections


# ---------------------------------------------------------------------------
# Empty / minimal input
# ---------------------------------------------------------------------------

def test_empty_string():
    cleaned, sections = clean_jd_text("")
    assert cleaned == ""
    assert sections == {}


def test_no_headings_all_prose():
    """A JD with zero headings → entire text is preamble → kept via fallback."""
    raw = (
        "We are looking for a nurse to join our team. "
        "Experience in aged care preferred. Must have AHPRA registration."
    )
    cleaned, sections = clean_jd_text(raw)
    # No headings → skill_count = 0 → fallback
    assert "_fallback" in sections
    assert cleaned == raw


# ---------------------------------------------------------------------------
# section_map contract
# ---------------------------------------------------------------------------

def test_section_map_contains_preamble_key():
    """The section_map always has a '_preamble' key for content before first heading."""
    body = _load_jd_body("nursing-residential-ain")
    _, sections = clean_jd_text(body)
    # The nursing-ain golden JD starts with preamble text before "Key responsibilities:".
    assert "_preamble" in sections


def test_section_map_records_all_headings():
    _, sections = clean_jd_text(_SYNTHETIC_WITH_BOILERPLATE)
    # Both skill and boilerplate headings should appear as keys.
    heading_keys = [k for k in sections if not k.startswith("_")]
    assert len(heading_keys) >= 3  # at least About Us, Key Responsibilities, Benefits


def test_boilerplate_key_lists_stripped_headings():
    _, sections = clean_jd_text(_SYNTHETIC_WITH_BOILERPLATE)
    assert "_boilerplate" in sections
    # The boilerplate string should name the discarded headings.
    boilerplate_str = sections["_boilerplate"].lower()
    assert "about us" in boilerplate_str or "benefits" in boilerplate_str
