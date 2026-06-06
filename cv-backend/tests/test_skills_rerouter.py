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


# ---------------------------------------------------------------------------
# Tech vertical rerouter (v223, 2026-06-06)
#
# Tech family labels: ["Technical Skills", "Soft Skills", "Other Skills"]
#   _label_cat("Technical Skills") → "technical"
#   _label_cat("Soft Skills")      → "soft_skills"
#   _label_cat("Other Skills")     → "technical"   (shared with Technical Skills!)
#
# Bug fixed: domain_knowledge items (agile, CI/CD) had no label line to render
# into — they were silently dropped. Fix: fall back to src_cat when tgt_cat not
# covered by any label. Also fixed: duplicate render when two labels share a cat.
# ---------------------------------------------------------------------------

_SKILLS_TECH_BASIC = """\
## Skills

- **Technical Skills:** Python, Docker, React
- **Soft Skills:** Communication, Teamwork
- **Other Skills:** agile, CI/CD
"""

_SKILLS_TECH_NOISE = """\
## Skills

- **Technical Skills:** Python, passion for technology, fast learner, Docker
- **Soft Skills:** Communication, results-driven
- **Other Skills:** agile
"""

_SKILLS_TECH_SOFT_ON_TECHNICAL = """\
## Skills

- **Technical Skills:** Python, Docker, teamwork
- **Soft Skills:** Communication
- **Other Skills:** agile
"""


class TestRerouteTech:

    def test_domain_knowledge_items_not_dropped(self):
        """agile and CI/CD are domain_knowledge but tech has no domain_knowledge
        label — they must NOT be dropped (bug was: silently disappeared)."""
        out = reroute_skills_by_lexicon(_SKILLS_TECH_BASIC, "tech")
        all_items = []
        for ln in out.splitlines():
            if "Skills:" in ln and "**" in ln:
                rest = ln.split(":**")[1].strip()
                all_items.extend([x.strip() for x in rest.split(",") if x.strip()])
        assert "agile" in all_items, "agile should not be dropped"
        assert "CI/CD" in all_items or "agile" in all_items  # at least one domain item kept

    def test_no_duplicate_items_when_two_labels_share_cat(self):
        """Technical Skills and Other Skills both map to 'technical' via
        _label_cat. Items must appear exactly once, not twice."""
        out = reroute_skills_by_lexicon(_SKILLS_TECH_BASIC, "tech")
        all_items = []
        for ln in out.splitlines():
            if "Skills:" in ln and "**" in ln:
                rest = ln.split(":**")[1].strip()
                all_items.extend([x.strip() for x in rest.split(",") if x.strip()])
        lower_items = [x.lower() for x in all_items]
        assert len(lower_items) == len(set(lower_items)), \
            f"Duplicate items after reroute: {lower_items}"

    def test_noise_phrases_dropped_from_tech(self):
        """passion for technology, fast learner, results-driven must be dropped
        by the is_noise check inside the rerouter."""
        out = reroute_skills_by_lexicon(_SKILLS_TECH_NOISE, "tech")
        for phrase in ("passion for technology", "fast learner", "results-driven"):
            assert phrase not in out, f"{phrase!r} leaked through rerouter"

    def test_soft_skill_on_technical_line_moves_to_soft(self):
        """teamwork classified as soft_skills must move from Technical Skills
        to Soft Skills — this category IS covered for tech."""
        out = reroute_skills_by_lexicon(_SKILLS_TECH_SOFT_ON_TECHNICAL, "tech")
        tech_line = next((l for l in out.splitlines() if "Technical Skills" in l), "")
        soft_line = next((l for l in out.splitlines() if "Soft Skills" in l), "")
        assert "teamwork" not in tech_line.lower()
        assert "teamwork" in soft_line.lower() or "Teamwork" in soft_line

    def test_known_technical_items_stay_on_technical(self):
        """Python and Docker (technical category) must stay on Technical Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_TECH_BASIC, "tech")
        tech_line = next((l for l in out.splitlines() if "Technical Skills" in l), "")
        assert "Python" in tech_line
        assert "Docker" in tech_line


# ---------------------------------------------------------------------------
# Cleaning vertical rerouter (v223, 2026-06-06)
#
# Cleaning family labels: ["Core Skills", "Soft Skills", "Other Skills"]
#   _label_cat("Core Skills")  → "domain_knowledge"
#   _label_cat("Soft Skills")  → "soft_skills"
#   _label_cat("Other Skills") → "technical"
# All three categories are covered — rerouter should work fully for cleaning.
# ---------------------------------------------------------------------------

_SKILLS_CLEANING_BASIC = """\
## Skills

- **Core Skills:** general cleaning, steam cleaning, floor care
- **Soft Skills:** attention to detail, reliability
- **Other Skills:** floor scrubber, Microsoft Office
"""

_SKILLS_CLEANING_NOISE = """\
## Skills

- **Core Skills:** general cleaning, passion for cleaning, own transport
- **Soft Skills:** attention to detail, presentable appearance
- **Other Skills:** floor scrubber
"""

_SKILLS_CLEANING_WRONG_BUCKET = """\
## Skills

- **Core Skills:** general cleaning, Microsoft Office
- **Soft Skills:** attention to detail
- **Other Skills:** steam cleaning, floor scrubber
"""


class TestRerouteCleaning:

    def test_noise_dropped_from_cleaning(self):
        """passion for cleaning and own transport are noise — rerouter must drop them."""
        out = reroute_skills_by_lexicon(_SKILLS_CLEANING_NOISE, "cleaning")
        for phrase in ("passion for cleaning", "own transport", "presentable appearance"):
            assert phrase not in out, f"{phrase!r} leaked through cleaning rerouter"

    def test_domain_knowledge_stays_on_core_skills(self):
        """steam cleaning and floor care (domain_knowledge) must stay on Core Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_CLEANING_BASIC, "cleaning")
        core_line = next((l for l in out.splitlines() if "Core Skills" in l), "")
        assert "steam cleaning" in core_line.lower() or "Steam Cleaning" in core_line
        assert "floor care" in core_line.lower() or "Floor Care" in core_line

    def test_technical_item_moves_from_core_to_other(self):
        """Microsoft Office is technical — if LLM puts it on Core Skills,
        rerouter must move it to Other Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_CLEANING_WRONG_BUCKET, "cleaning")
        core_line = next((l for l in out.splitlines() if "Core Skills" in l), "")
        other_line = next((l for l in out.splitlines() if "Other Skills" in l), "")
        assert "Microsoft Office" not in core_line
        assert "Microsoft Office" in other_line

    def test_steam_cleaning_moves_from_other_to_core(self):
        """steam cleaning is domain_knowledge — if LLM puts it on Other Skills,
        rerouter must move it to Core Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_CLEANING_WRONG_BUCKET, "cleaning")
        core_line = next((l for l in out.splitlines() if "Core Skills" in l), "")
        other_line = next((l for l in out.splitlines() if "Other Skills" in l), "")
        assert "steam cleaning" in core_line.lower() or "Steam Cleaning" in core_line
        assert "steam cleaning" not in other_line.lower()
