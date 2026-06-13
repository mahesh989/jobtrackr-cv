"""Tests for the canonical CV renderer — structured CV → consistent markdown."""
from __future__ import annotations

from app.services.cv.cv_renderer import render_canonical_cv


SHANTI_STRUCTURED = {
    "contact": {"name": "Shanti Giri", "email": "shanti@example.com",
                "phone": "0415690003", "location": "Hurstville, NSW", "links": []},
    "summary": "Aged Care Support Worker with Cert IV.",
    "experience": [
        {"employer": "RFBI Concord Community Village", "role": "Aged Care Placement",
         "location": "Rhodes, NSW", "start_date": "Dec 2025", "end_date": "Feb 2026",
         "is_current": False,
         "bullets": ["Provided personal care.", "Assisted with medication."]},
        {"employer": "Dimeo Cleaning Excellence", "role": "Office Cleaner",
         "location": "Sydney", "start_date": "", "end_date": "",
         "is_current": False, "bullets": ["Cleaned offices."]},
    ],
    "education": [
        {"institution": "CQ University", "qualification": "Master of Professional Accounting",
         "location": "Sydney", "start_date": "Jul 2025", "end_date": "Present", "completed": False},
        {"institution": "Elite Institute and Technology",
         "qualification": "Certificate IV in Ageing Support",
         "location": "", "start_date": "", "end_date": "Apr 2026",
         "completed": True, "_moved_from_certifications": True},
    ],
    "certifications": [
        {"name": "First Aid", "issuer": "NovaCare", "code": "HLTAID011", "issued_date": "Apr 2026"},
    ],
    "skills": {
        "technical": ["bestmed", "medmobile"],
        "soft_skills": ["empathy", "teamwork"],
        "domain_knowledge": ["personal care", "dementia care"],
    },
    "references": [],
}


class TestRender:
    def test_section_order(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        # Skills above Summary per product decision; Cert/Lic after Education.
        skills_at = out.index("## Skills")
        summary_at = out.index("## Professional Summary")
        experience_at = out.index("## Experience")
        education_at = out.index("## Education")
        cert_at = out.index("## Certifications & Licences")
        assert skills_at < summary_at < experience_at < education_at < cert_at

    def test_skills_use_canonical_labels(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        assert "**Care Skills:**" in out
        assert "**Soft Skills:**" in out
        assert "**Other Skills:**" in out
        # Tech category renders under "Other Skills" for nursing/care.
        assert "BESTMed" in out or "Bestmed" in out  # title-cased

    def test_dates_preserved_verbatim(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        assert "Dec 2025 – Feb 2026" in out
        # Dimeo has no source dates — date slot omitted entirely, never fabricated.
        assert "Office Cleaner" in out
        # The italic line for Dimeo must NOT contain a date range.
        dimeo_block = out[out.index("Dimeo"):out.index("## Education")]
        assert "–" not in dimeo_block.split("Office Cleaner")[1].split("\n")[0]

    def test_ongoing_education_kept(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        assert "Master of Professional Accounting" in out
        assert "Jul 2025 – Present" in out

    def test_cert_iv_lives_under_education(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        edu_section = out[out.index("## Education"):out.index("## Certifications")]
        assert "Certificate IV in Ageing Support" in edu_section
        cert_section = out[out.index("## Certifications"):]
        assert "Certificate IV in Ageing Support" not in cert_section

    def test_empty_certifications_section_omitted(self):
        no_certs = {**SHANTI_STRUCTURED, "certifications": []}
        out = render_canonical_cv(no_certs)
        assert "## Certifications" not in out

    def test_empty_summary_section_omitted(self):
        no_summary = {**SHANTI_STRUCTURED, "summary": ""}
        out = render_canonical_cv(no_summary)
        assert "## Professional Summary" not in out

    def test_pure_function_idempotent(self):
        out1 = render_canonical_cv(SHANTI_STRUCTURED)
        out2 = render_canonical_cv(SHANTI_STRUCTURED)
        assert out1 == out2

    def test_empty_structured_renders_empty_string(self):
        assert render_canonical_cv({}).strip() == ""
        assert render_canonical_cv(None).strip() == ""

    def test_contact_line_format(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        assert "Hurstville, NSW · 0415690003 · [shanti@example.com](mailto:shanti@example.com)" in out

    def test_bullets_rendered_with_dash_prefix(self):
        out = render_canonical_cv(SHANTI_STRUCTURED)
        assert "- Provided personal care." in out
        assert "- Assisted with medication." in out
