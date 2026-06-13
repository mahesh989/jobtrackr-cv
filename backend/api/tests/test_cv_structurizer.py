"""Tests for the CV structurizer — normalisation, vertical tagging, gap detection.

The AI call itself isn't tested (it's a thin provider wrapper); we test
`normalise_structured_cv` + `detect_gaps`, which carry all the logic and
must be robust to malformed AI output.
"""
from __future__ import annotations

from app.services.cv.cv_structurizer import (
    normalise_structured_cv,
    detect_gaps,
)


# A realistic raw-AI payload modelled on Shanti's CV (3-month placement +
# off-field accountant/cleaner, ongoing Master's, Cert IV, missing dates).
SHANTI_RAW = {
    "contact": {"name": "Shanti Giri", "email": "shanti@example.com",
                "phone": "0415690003", "location": "Hurstville, NSW", "links": []},
    "summary": "Aged Care Support Worker with Certificate IV in Ageing Support.",
    "experience": [
        {"employer": "RFBI Concord Community Village", "role": "Aged Care Placement",
         "location": "Rhodes, NSW", "start_date": "Dec 2025", "end_date": "Feb 2026",
         "is_current": False,
         "bullets": ["Provided personal care to elderly residents including dementia support.",
                     "Assisted with medication administration and mobility support."]},
        {"employer": "Akala Motors", "role": "Junior Accountant",
         "location": "Pokhara, Nepal", "start_date": "Jan 2024", "end_date": "May 2025",
         "is_current": False,
         "bullets": ["Maintained financial records and processed transactions."]},
        {"employer": "Dimeo Cleaning Excellence", "role": "Office Cleaner",
         "location": "Sydney", "start_date": "", "end_date": "",  # no dates in source
         "is_current": False, "bullets": ["Cleaned office areas."]},
    ],
    "education": [
        {"institution": "CQ University", "qualification": "Master of Professional Accounting",
         "location": "Sydney", "start_date": "Jul 2025", "end_date": "Present", "completed": False},
        {"institution": "Pokhara University", "qualification": "Bachelor of Business Administration",
         "location": "Pokhara", "start_date": "", "end_date": "Completed 2021", "completed": True},
    ],
    "certifications": [
        {"name": "Certificate IV in Ageing Support", "issuer": "Elite Institute",
         "code": "CHC43015", "issued_date": "Apr 2026"},
    ],
    "references": [],
}

SHANTI_SKILLS = {
    "technical": ["bestmed"],
    "soft_skills": ["empathy", "teamwork"],
    "domain_knowledge": ["personal care", "dementia care", "medication administration"],
}


class TestNormalise:
    def test_full_shape_present(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=SHANTI_SKILLS)
        for key in ("contact", "summary", "experience", "education",
                    "certifications", "skills", "references", "gaps"):
            assert key in s

    def test_skills_merged_verbatim(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=SHANTI_SKILLS)
        assert "personal care" in s["skills"]["domain_knowledge"]
        assert "bestmed" in s["skills"]["technical"]

    def test_skills_default_empty_when_none(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        assert s["skills"] == {"technical": [], "soft_skills": [], "domain_knowledge": []}

    def test_dates_preserved_verbatim(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        rfbi = s["experience"][0]
        assert rfbi["start_date"] == "Dec 2025"
        assert rfbi["end_date"] == "Feb 2026"
        # Dimeo has no dates — must stay blank, never fabricated.
        dimeo = s["experience"][2]
        assert dimeo["start_date"] == ""
        assert dimeo["end_date"] == ""

    def test_ongoing_education_kept(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        masters = [e for e in s["education"] if "Master" in e["qualification"]]
        assert masters and masters[0]["completed"] is False

    def test_cert_iv_in_certifications_not_education(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        cert_names = [c["name"] for c in s["certifications"]]
        edu_quals = [e["qualification"] for e in s["education"]]
        assert any("Certificate IV" in n for n in cert_names)
        assert not any("Certificate IV" in q for q in edu_quals)

    def test_experience_vertical_tagged(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        rfbi = s["experience"][0]
        assert rfbi["vertical_hint"] == "nursing"  # care bullets resolve to nursing
        # Akala accounting should NOT be nursing.
        akala = s["experience"][1]
        assert akala["vertical_hint"] != "nursing"

    def test_malformed_input_never_raises(self):
        for junk in (None, [], "string", 42, {"experience": "not a list"}):
            s = normalise_structured_cv(junk, skills=None)
            assert isinstance(s, dict)
            assert s["experience"] == [] if not isinstance(junk, dict) else True


class TestGapDetection:
    def test_flags_missing_experience_dates(self):
        s = normalise_structured_cv(SHANTI_RAW, skills=None)
        gaps = s["gaps"]
        dimeo_gap = [g for g in gaps if g["section"] == "experience"
                     and g["field"] == "dates" and g["entry_index"] == "2"]
        assert dimeo_gap

    def test_flags_missing_education_year(self):
        raw = {"education": [{"institution": "X", "qualification": "BBA",
                              "start_date": "", "end_date": "", "completed": True}]}
        gaps = detect_gaps(normalise_structured_cv(raw, skills=None))
        assert any(g["section"] == "education" and g["field"] == "dates" for g in gaps)

    def test_flags_missing_email(self):
        raw = {"contact": {"name": "X", "email": ""}}
        gaps = detect_gaps(normalise_structured_cv(raw, skills=None))
        assert any(g["section"] == "contact" and g["field"] == "email" for g in gaps)

    def test_flags_no_summary(self):
        raw = {"summary": ""}
        gaps = detect_gaps(normalise_structured_cv(raw, skills=None))
        assert any(g["section"] == "summary" for g in gaps)

    def test_flags_role_without_bullets(self):
        raw = {"experience": [{"employer": "X", "role": "Y",
                               "start_date": "2024", "end_date": "2025", "bullets": []}]}
        gaps = detect_gaps(normalise_structured_cv(raw, skills=None))
        assert any(g["section"] == "experience" and g["field"] == "bullets" for g in gaps)

    def test_clean_cv_has_no_date_or_contact_gaps(self):
        raw = {
            "contact": {"name": "Jane", "email": "jane@x.com"},
            "summary": "Experienced AIN.",
            "experience": [{"employer": "ABC Care", "role": "AIN",
                            "start_date": "Jan 2024", "end_date": "Present",
                            "is_current": True, "bullets": ["Provided personal care."]}],
            "education": [{"institution": "TAFE", "qualification": "Cert III",
                           "start_date": "2023", "end_date": "2023", "completed": True}],
        }
        gaps = detect_gaps(normalise_structured_cv(raw, skills=None))
        assert not any(g["field"] in ("dates", "email", "bullets") for g in gaps)
        assert not any(g["section"] == "summary" for g in gaps)
