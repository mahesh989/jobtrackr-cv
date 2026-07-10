"""Tests for the CV structurizer — normalisation, vertical tagging, gap detection.

The AI call itself isn't tested (it's a thin provider wrapper); we test
`normalise_structured_cv` + `detect_gaps`, which carry all the logic and
must be robust to malformed AI output.
"""
from __future__ import annotations

from app.services.cv.cv_structurizer import (
    STRUCTURED_CV_VERSION,
    normalise_structured_cv,
    detect_gaps,
)


# A realistic raw-AI payload modelled on Shanti's CV (3-month placement +
# off-field accountant/cleaner, ongoing Master's, Cert IV, missing dates).
SHANTI_RAW = {
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
    "awards": [
        {"name": "Staff Excellence Award", "issuer": "The Jesmond Group",
         "location": "Sydney", "date": "August 2025", "description": ""},
    ],
    "certifications": [
        {"name": "Certificate IV in Ageing Support", "issuer": "Elite Institute",
         "code": "CHC43015", "issued_date": "Apr 2026"},
    ],
    "references": [],
}

SHANTI_RAW_WITH_SKILLS = {
    **SHANTI_RAW,
    "skills": {
        "technical": ["bestmed", "MedMobile"],  # case + dedupe target
        "soft_skills": ["empathy", "teamwork", ""],
        "domain_knowledge": ["personal care", "dementia care", "personal care"],  # dedupe target
    },
}


class TestNormalise:
    def test_full_shape_present(self):
        s = normalise_structured_cv(SHANTI_RAW)
        for key in ("summary", "experience", "education", "awards",
                    "certifications", "skills", "references", "gaps"):
            assert key in s

    def test_contact_block_not_emitted(self):
        s = normalise_structured_cv(SHANTI_RAW)
        assert "contact" not in s

    def test_awards_preserved_verbatim(self):
        s = normalise_structured_cv(SHANTI_RAW)
        assert s["awards"] == [{
            "name": "Staff Excellence Award",
            "issuer": "The Jesmond Group",
            "location": "Sydney",
            "date": "August 2025",
            "description": "",
        }]

    def test_awards_default_empty(self):
        s = normalise_structured_cv({"summary": ""})
        assert s["awards"] == []

    def test_languages_normalised(self):
        raw = {"languages": [
            {"language": "English", "proficiency": "Advanced"},
            {"language": "Nepali",  "proficiency": "Native"},
        ]}
        s = normalise_structured_cv(raw)
        assert s["languages"] == [
            {"language": "English", "proficiency": "Advanced"},
            {"language": "Nepali",  "proficiency": "Native"},
        ]

    def test_languages_default_empty(self):
        assert normalise_structured_cv({})["languages"] == []

    def test_experience_sorted_recent_first(self):
        raw = {"experience": [
            {"employer": "Dimeo",  "role": "Cleaner",     "start_date": "", "end_date": "", "is_current": False, "bullets": ["x"]},
            {"employer": "Akala",  "role": "Accountant",  "start_date": "01/2024", "end_date": "05/2025", "is_current": False, "bullets": ["x"]},
            {"employer": "RFBI",   "role": "AIN",         "start_date": "Dec 2025", "end_date": "Feb 2026", "is_current": False, "bullets": ["x"]},
        ]}
        s = normalise_structured_cv(raw)
        employers = [e["employer"] for e in s["experience"]]
        assert employers == ["RFBI", "Akala", "Dimeo"]

    def test_experience_current_role_first(self):
        raw = {"experience": [
            {"employer": "Old", "start_date": "2024", "end_date": "2025", "is_current": False, "bullets": ["x"]},
            {"employer": "Now", "start_date": "2026", "end_date": "Present", "is_current": True, "bullets": ["x"]},
        ]}
        s = normalise_structured_cv(raw)
        assert s["experience"][0]["employer"] == "Now"

    def test_education_dedupes_cert_iv(self):
        """AI sometimes lists the same Cert IV twice — once plain, once with the unit code prefix."""
        raw = {"education": [
            {"institution": "Elite", "qualification": "Certificate IV in Ageing Support",
             "start_date": "", "end_date": "Apr 2026", "completed": True},
            {"institution": "Elite", "qualification": "CHC43015 - Certificate IV in Ageing Support",
             "start_date": "", "end_date": "Apr 2026", "completed": True},
        ]}
        s = normalise_structured_cv(raw)
        assert len(s["education"]) == 1

    def test_cert_iv_dedupes_when_already_in_education(self):
        """If the AI puts the same Cert IV in BOTH education and certifications,
        the router moves it only when not already represented."""
        raw = {
            "education": [
                {"institution": "Elite", "qualification": "Certificate IV in Ageing Support",
                 "start_date": "", "end_date": "Apr 2026", "completed": True},
            ],
            "certifications": [
                {"name": "CHC43015 - Certificate IV in Ageing Support",
                 "issuer": "Elite", "code": "CHC43015", "issued_date": "Apr 2026"},
            ],
        }
        s = normalise_structured_cv(raw)
        assert len(s["education"]) == 1
        assert s["certifications"] == []

    def test_skills_lowercased_and_deduped(self):
        s = normalise_structured_cv(SHANTI_RAW_WITH_SKILLS)
        # Lowercased
        assert "medmobile" in s["skills"]["technical"]
        # Deduped
        assert s["skills"]["domain_knowledge"].count("personal care") == 1
        # Blanks dropped
        assert "" not in s["skills"]["soft_skills"]

    def test_skills_default_empty_when_absent(self):
        s = normalise_structured_cv(SHANTI_RAW)
        assert s["skills"] == {"technical": [], "soft_skills": [], "domain_knowledge": []}

    def test_emits_structured_cv_version(self):
        s = normalise_structured_cv(SHANTI_RAW)
        assert s["_version"] == STRUCTURED_CV_VERSION

    def test_dates_preserved_verbatim(self):
        s = normalise_structured_cv(SHANTI_RAW)
        rfbi = s["experience"][0]
        assert rfbi["start_date"] == "Dec 2025"
        assert rfbi["end_date"] == "Feb 2026"
        dimeo = s["experience"][2]
        assert dimeo["start_date"] == ""
        assert dimeo["end_date"] == ""

    def test_ongoing_education_kept(self):
        s = normalise_structured_cv(SHANTI_RAW)
        masters = [e for e in s["education"] if "Master" in e["qualification"]]
        assert masters and masters[0]["completed"] is False

    def test_cert_iv_routed_to_education(self):
        """The bucketing rule moves care-sector VET quals to education."""
        s = normalise_structured_cv(SHANTI_RAW)
        edu_quals = [e["qualification"] for e in s["education"]]
        cert_names = [c["name"] for c in s["certifications"]]
        assert any("Certificate IV in Ageing Support" in q for q in edu_quals)
        assert not any("Certificate IV" in n for n in cert_names)

    def test_cert_iv_carries_moved_badge(self):
        s = normalise_structured_cv(SHANTI_RAW)
        moved = [e for e in s["education"] if e.get("_moved_from_certifications")]
        assert any("Ageing Support" in e["qualification"] for e in moved)

    def test_non_care_certs_stay_in_certifications(self):
        raw = {"certifications": [
            {"name": "First Aid", "issuer": "Red Cross", "code": "HLTAID011", "issued_date": "2026"},
            {"name": "White Card", "issuer": "Safety Org", "code": "", "issued_date": "2024"},
        ]}
        s = normalise_structured_cv(raw)
        cert_names = [c["name"] for c in s["certifications"]]
        assert "First Aid" in cert_names
        assert "White Card" in cert_names

    def test_disability_cert_iii_also_routed(self):
        raw = {"certifications": [
            {"name": "Certificate III in Individual Support (Disability)",
             "issuer": "TAFE", "code": "CHC33015", "issued_date": "2023"},
        ]}
        s = normalise_structured_cv(raw)
        assert s["certifications"] == []
        assert any("Individual Support" in e["qualification"] for e in s["education"])

    def test_cert_issued_date_strips_label(self):
        raw = {"certifications": [
            {"name": "Statement of Attainment in CPR and First Aid",
             "issuer": "Training Course Experts, Sydney, Australia",
             "code": "", "issued_date": "Issued: Oct. 2024"},
        ]}
        s = normalise_structured_cv(raw)
        assert s["certifications"][0]["issued_date"] == "Oct. 2024"
        assert s["certifications"][0]["issuer"] == "Training Course Experts, Sydney, Australia"

    def test_award_date_strips_label(self):
        raw = {"awards": [
            {"name": "Staff Excellence Award", "issuer": "The Jesmond Group",
             "location": "", "date": "Awarded: August 2025", "description": ""},
        ]}
        s = normalise_structured_cv(raw)
        assert s["awards"][0]["date"] == "August 2025"

    def test_education_dates_strip_label(self):
        raw = {"education": [
            {"institution": "SPES Education", "qualification": "Certificate IV in Ageing Support",
             "location": "", "start_date": "", "end_date": "Completed: Oct. 2024", "completed": True},
        ]}
        s = normalise_structured_cv(raw)
        assert s["education"][0]["end_date"] == "Oct. 2024"

    def test_date_without_label_untouched(self):
        raw = {"certifications": [
            {"name": "White Card", "issuer": "Safety Org", "code": "", "issued_date": "2024"},
        ]}
        s = normalise_structured_cv(raw)
        assert s["certifications"][0]["issued_date"] == "2024"

    def test_merges_wrapped_bullets(self):
        """PDF column wrapping splits one bullet into 2-3 fragments. The
        deterministic merger rejoins them based on continuation cues."""
        raw = {"experience": [{"employer": "Uniting", "role": "AIN",
                               "start_date": "Mar 2026", "end_date": "Present",
                               "bullets": [
                                   "Provide person-centred care to residents, supporting daily living activities such as bathing, dressing,",
                                   "and meal assistance.",
                                   "Monitor and report changes in residents' physical and emotional wellbeing to nursing staff.",
                                   "Maintain a safe and comfortable environment, adhering to manual handling and infection control",
                                   "protocols.",
                                   "Support residents living with dementia using person-centred approaches, behavioural management",
                                   "techniques, and meaningful engagement.",
                               ]}]}
        s = normalise_structured_cv(raw)
        bullets = s["experience"][0]["bullets"]
        # 7 raw fragments → 4 real bullets after merging.
        assert len(bullets) == 4, bullets
        assert "and meal assistance" in bullets[0]
        assert bullets[1].startswith("Monitor")
        assert "infection control protocols" in bullets[2]
        assert "behavioural management techniques" in bullets[3]
        # No bullet begins with a lowercase word after merging.
        for b in bullets:
            assert b[0].isupper() or b[0].isdigit(), b

    def test_does_not_merge_independent_bullets(self):
        """Two independent complete sentences must remain separate."""
        raw = {"experience": [{"employer": "X", "role": "Y",
                               "start_date": "2024", "end_date": "2025",
                               "bullets": [
                                   "Provided personal care to elderly residents.",
                                   "Assisted with medication administration daily.",
                               ]}]}
        s = normalise_structured_cv(raw)
        assert len(s["experience"][0]["bullets"]) == 2

    def test_bullets_strip_leading_markers(self):
        """Bullets stored as text only — leading •/-/·/* stripped so the
        renderer's "- " marker doesn't render twice next to each line."""
        raw = {"experience": [{"employer": "X", "role": "Y",
                               "start_date": "2024", "end_date": "2025",
                               "bullets": ["• Provided care.", "- Assisted with meals.",
                                           "* Documented progress.", "·  Handled handovers.",
                                           "Plain bullet."]}]}
        s = normalise_structured_cv(raw)
        bullets = s["experience"][0]["bullets"]
        # No bullet starts with a marker character anymore.
        for b in bullets:
            assert b and b[0] not in "•-*·"
        # Words after the marker preserved verbatim.
        assert "Provided care." in bullets
        assert "Plain bullet." in bullets

    def test_malformed_input_never_raises(self):
        for junk in (None, [], "string", 42, {"experience": "not a list"}):
            s = normalise_structured_cv(junk)
            assert isinstance(s, dict)


class TestGapDetection:
    def test_flags_missing_experience_dates(self):
        s = normalise_structured_cv(SHANTI_RAW)
        gaps = s["gaps"]
        dimeo_gap = [g for g in gaps if g["section"] == "experience"
                     and g["field"] == "dates" and g["entry_index"] == "2"]
        assert dimeo_gap

    def test_flags_missing_education_year(self):
        raw = {"education": [{"institution": "X", "qualification": "BBA",
                              "start_date": "", "end_date": "", "completed": True}]}
        gaps = detect_gaps(normalise_structured_cv(raw))
        assert any(g["section"] == "education" and g["field"] == "dates" for g in gaps)

    def test_does_not_flag_contact(self):
        """Contact gaps are not surfaced — contact comes from user profile."""
        gaps = detect_gaps(normalise_structured_cv({"summary": "x"}))
        assert not any(g["section"] == "contact" for g in gaps)

    def test_flags_no_summary(self):
        raw = {"summary": ""}
        gaps = detect_gaps(normalise_structured_cv(raw))
        assert any(g["section"] == "summary" for g in gaps)

    def test_flags_role_without_bullets(self):
        raw = {"experience": [{"employer": "X", "role": "Y",
                               "start_date": "2024", "end_date": "2025", "bullets": []}]}
        gaps = detect_gaps(normalise_structured_cv(raw))
        assert any(g["section"] == "experience" and g["field"] == "bullets" for g in gaps)

    def test_clean_cv_has_no_date_or_contact_gaps(self):
        raw = {
            "summary": "Experienced AIN.",
            "experience": [{"employer": "ABC Care", "role": "AIN",
                            "start_date": "Jan 2024", "end_date": "Present",
                            "is_current": True, "bullets": ["Provided personal care."]}],
            "education": [{"institution": "TAFE", "qualification": "Cert III",
                           "start_date": "2023", "end_date": "2023", "completed": True}],
        }
        gaps = detect_gaps(normalise_structured_cv(raw))
        assert not any(g["field"] in ("dates", "email", "bullets") for g in gaps)
        assert not any(g["section"] == "summary" for g in gaps)

    def test_education_sorting_recent_first(self):
        raw = {
            "education": [
                {"qualification": "Bachelor of Business Administration", "end_date": "Completed 2021", "completed": True},
                {"qualification": "Master of Professional Accounting", "end_date": "2025 – Present", "completed": False},
            ],
            "certifications": [
                {"name": "Certificate IV in Ageing Support", "issued_date": "Issued 2026", "issuer": "Elite Institute"},
            ],
        }
        s = normalise_structured_cv(raw)
        edu = s["education"]
        assert len(edu) == 3
        # Expected order: Master (2025 - Present) first, Cert IV (2026) second, Bachelor (2021) third
        assert "Master of Professional Accounting" in edu[0]["qualification"]
        assert "Certificate IV in Ageing Support" in edu[1]["qualification"]
        assert "Bachelor of Business Administration" in edu[2]["qualification"]
