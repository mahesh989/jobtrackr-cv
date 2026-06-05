"""Lexicon-based Skills re-router (reroute_skills_by_lexicon).

Verifies that entries the LLM placed on the wrong Skills line are moved to the
lexicon-correct one. The canonical cases are from the Hardi and Nepean runs
(2026-06-05) where 'clinical documentation', 'patient care', and 'elderly care'
landed on Other Skills instead of Care Skills for nursing.
"""
from app.services.eval.enforce import reroute_skills_by_lexicon, enforce_skills_section

_SKILLS_HARDI = """\
## Skills

- **Care Skills:** Personal Care, Medication Administration, Dementia Care
- **Soft Skills:** Time Management, Teamwork
- **Other Skills:** BESTMed, MedMobile, Clinical Documentation
"""

_SKILLS_NEPEAN = """\
## Skills

- **Care Skills:** Medication Assistance, Personal Care, Dementia Care
- **Soft Skills:** Prioritisation, Teamwork
- **Other Skills:** BESTMed, MedMobile, Patient Care
"""

_SKILLS_ELDERLY_CARE = """\
## Skills

- **Care Skills:** Personal Care, Medication Administration
- **Soft Skills:** Time Management, Teamwork
- **Other Skills:** BESTMed, Elderly Care
"""

_SKILLS_ALREADY_CORRECT = """\
## Skills

- **Care Skills:** Personal Care, Wound Care, Continence Care
- **Soft Skills:** Time Management, Teamwork
- **Other Skills:** BESTMed, MedMobile
"""

_SKILLS_BESTMED_ON_WRONG_LINE = """\
## Skills

- **Care Skills:** Personal Care, BESTMed
- **Soft Skills:** Time Management, Teamwork
- **Other Skills:** MedMobile
"""


class TestRerouteNursing:

    def test_clinical_documentation_moves_to_care_skills(self):
        out = reroute_skills_by_lexicon(_SKILLS_HARDI, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        other_line = next(l for l in out.splitlines() if "Other Skills" in l)
        assert "Clinical Documentation" in care_line
        assert "Clinical Documentation" not in other_line

    def test_patient_care_moves_to_care_skills(self):
        out = reroute_skills_by_lexicon(_SKILLS_NEPEAN, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        other_line = next(l for l in out.splitlines() if "Other Skills" in l)
        assert "Patient Care" in care_line
        assert "Patient Care" not in other_line

    def test_elderly_care_moves_to_care_skills(self):
        out = reroute_skills_by_lexicon(_SKILLS_ELDERLY_CARE, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "Elderly Care" in care_line

    def test_bestmed_stays_on_other_skills(self):
        out = reroute_skills_by_lexicon(_SKILLS_HARDI, "nursing")
        other_line = next(l for l in out.splitlines() if "Other Skills" in l)
        assert "BESTMed" in other_line

    def test_already_correct_items_unchanged(self):
        out = reroute_skills_by_lexicon(_SKILLS_ALREADY_CORRECT, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "Wound Care" in care_line
        assert "Continence Care" in care_line

    def test_bestmed_moves_from_care_skills_to_other_skills(self):
        out = reroute_skills_by_lexicon(_SKILLS_BESTMED_ON_WRONG_LINE, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        other_line = next(l for l in out.splitlines() if "Other Skills" in l)
        assert "BESTMed" not in care_line
        assert "BESTMed" in other_line

    def test_no_duplication_after_reroute(self):
        out = reroute_skills_by_lexicon(_SKILLS_HARDI, "nursing")
        all_items = []
        for ln in out.splitlines():
            if "Skills:" in ln and "**" in ln:
                colon_idx = ln.index(":**")
                rest = ln[colon_idx + 3:].strip()
                all_items.extend([x.strip() for x in rest.split(",") if x.strip()])
        assert len(all_items) == len(set(i.lower() for i in all_items))


class TestRerouteNoVertical:

    def test_no_vertical_returns_unchanged(self):
        original = _SKILLS_HARDI
        out = reroute_skills_by_lexicon(original, None)
        assert out == original

    def test_empty_vertical_returns_unchanged(self):
        original = _SKILLS_HARDI
        out = reroute_skills_by_lexicon(original, "")
        assert out == original


class TestRerouteEdgeCases:

    def test_no_skills_section_returns_unchanged(self):
        md = "## Experience\n\nSome text\n"
        assert reroute_skills_by_lexicon(md, "nursing") == md

    def test_empty_markdown_returns_unchanged(self):
        assert reroute_skills_by_lexicon("", "nursing") == ""

    def test_reroute_then_enforce_stays_within_cap(self):
        # If reroute pushes a line over cap, the following enforce_skills_section
        # should trim it back to DEFAULT_SKILL_CAPS (14, 6, 6).
        many_items = ", ".join(f"Item{i}" for i in range(20))
        md = (
            "## Skills\n\n"
            f"- **Care Skills:** {many_items}\n"
            "- **Soft Skills:** Teamwork\n"
            "- **Other Skills:** BESTMed\n"
        )
        rerouted = reroute_skills_by_lexicon(md, "nursing")
        final = enforce_skills_section(rerouted)
        care_line = next(l for l in final.splitlines() if "Care Skills" in l)
        items = [x.strip() for x in care_line.split(":**")[1].split(",") if x.strip()]
        assert len(items) <= 14
