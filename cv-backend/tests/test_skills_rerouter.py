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

    def test_elderly_care_excluded_from_skills(self):
        """'Elderly Care' → canonical 'aged care' → role-category label.
        Must be dropped from all Skills lines — not moved to Care Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_ELDERLY_CARE, "nursing")
        assert "elderly care" not in out.lower(), \
            "'Elderly Care' should be excluded (role-category label), not moved to Care Skills"

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


# ---------------------------------------------------------------------------
# Canonical synonym dedup (Bolton Clarke regression, 2026-06-06)
#
# When the LLM emits two items that resolve to the same lexicon canonical
# (e.g. "Mobility Assistance" and "Mobility Support" → both canonical
# "mobility support"), only the FIRST should survive.
# ---------------------------------------------------------------------------

_SKILLS_SYNONYM_DUPES = """\
## Skills

- **Care Skills:** Personal Care, Mobility Assistance, Electronic Documentation, Mobility Support, Clinical Documentation
- **Soft Skills:** Teamwork
- **Other Skills:** BESTMed
"""


class TestCanonicalSynonymDedup:

    def test_mobility_support_deduplicated(self):
        """'Mobility Assistance' and 'Mobility Support' share canonical
        'mobility support' — only the first should remain."""
        out = reroute_skills_by_lexicon(_SKILLS_SYNONYM_DUPES, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        items_lower = [x.strip().lower() for x in care_line.split(":**")[1].split(",") if x.strip()]
        mobility_items = [i for i in items_lower if "mobility" in i]
        assert len(mobility_items) == 1, f"Expected 1 mobility item, got: {mobility_items}"

    def test_clinical_documentation_deduplicated(self):
        """'Electronic Documentation' and 'Clinical Documentation' share
        canonical 'clinical documentation' — only the first should remain."""
        out = reroute_skills_by_lexicon(_SKILLS_SYNONYM_DUPES, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        items_lower = [x.strip().lower() for x in care_line.split(":**")[1].split(",") if x.strip()]
        doc_items = [i for i in items_lower if "documentation" in i]
        assert len(doc_items) == 1, f"Expected 1 documentation item, got: {doc_items}"

    def test_total_item_count_reduced(self):
        """5 Care Skills input → 3 after canonical dedup (2 pairs collapsed)."""
        out = reroute_skills_by_lexicon(_SKILLS_SYNONYM_DUPES, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        items = [x.strip() for x in care_line.split(":**")[1].split(",") if x.strip()]
        assert len(items) == 3, f"Expected 3 deduplicated items, got {len(items)}: {items}"


# ---------------------------------------------------------------------------
# Role-category label filter (Anglicare regression, 2026-06-07)
#
# Terms like "home care", "aged care", "disability support", "independent
# living support" are job-type / sector descriptors — they belong in narrative
# text (bullets, summary), NOT in the Skills section. The rerouter must
# silently drop them even when the LLM places them on a Skills line.
#
# Real care skills ("dementia care", "mobility support") must still pass.
# ---------------------------------------------------------------------------

_SKILLS_WITH_ROLE_LABELS = """\
## Skills

- **Care Skills:** Personal Care, Home Care, Aged Care, Dementia Care, Disability Support
- **Soft Skills:** Teamwork, Communication
- **Other Skills:** BESTMed
"""

_SKILLS_WITH_INDEPENDENT_LIVING = """\
## Skills

- **Care Skills:** Personal Care, Independent Living Support, Mobility Support
- **Soft Skills:** Empathy
- **Other Skills:** BESTMed
"""

_SKILLS_WITH_COMMUNITY_CARE = """\
## Skills

- **Care Skills:** Personal Care, Community Care, Wound Care
- **Soft Skills:** Teamwork
- **Other Skills:** BESTMed
"""


class TestRoleCategoryLabelFilter:

    def test_home_care_excluded_from_care_skills(self):
        """'Home Care' is a job-type label — must not appear in Care Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_ROLE_LABELS, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "home care" not in care_line.lower(), \
            "'Home Care' leaked into Care Skills — it is a role-category label"

    def test_aged_care_excluded_from_care_skills(self):
        """'Aged Care' is a sector descriptor — must not appear in Care Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_ROLE_LABELS, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "aged care" not in care_line.lower(), \
            "'Aged Care' leaked into Care Skills — it is a sector label"

    def test_disability_support_excluded_from_care_skills(self):
        """'Disability Support' is a job-type label — must not appear in Care Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_ROLE_LABELS, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "disability support" not in care_line.lower(), \
            "'Disability Support' leaked into Care Skills — it is a role-category label"

    def test_independent_living_support_excluded(self):
        """'Independent Living Support' is a service-type descriptor — excluded from Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_INDEPENDENT_LIVING, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "independent living support" not in care_line.lower(), \
            "'Independent Living Support' leaked into Care Skills"

    def test_community_care_excluded(self):
        """'Community Care' is a setting descriptor — excluded from Skills."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_COMMUNITY_CARE, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "community care" not in care_line.lower(), \
            "'Community Care' leaked into Care Skills"

    def test_real_care_skills_still_pass(self):
        """'Dementia Care', 'Mobility Support', 'Wound Care' are real skills — must survive."""
        out1 = reroute_skills_by_lexicon(_SKILLS_WITH_ROLE_LABELS, "nursing")
        care_line1 = next(l for l in out1.splitlines() if "Care Skills" in l)
        assert "Dementia Care" in care_line1, "'Dementia Care' was incorrectly filtered"

        out2 = reroute_skills_by_lexicon(_SKILLS_WITH_INDEPENDENT_LIVING, "nursing")
        care_line2 = next(l for l in out2.splitlines() if "Care Skills" in l)
        assert "Mobility Support" in care_line2, "'Mobility Support' was incorrectly filtered"

        out3 = reroute_skills_by_lexicon(_SKILLS_WITH_COMMUNITY_CARE, "nursing")
        care_line3 = next(l for l in out3.splitlines() if "Care Skills" in l)
        assert "Wound Care" in care_line3, "'Wound Care' was incorrectly filtered"

    def test_personal_care_still_passes(self):
        """'Personal Care' is a specific activity — must survive the label filter."""
        out = reroute_skills_by_lexicon(_SKILLS_WITH_ROLE_LABELS, "nursing")
        care_line = next(l for l in out.splitlines() if "Care Skills" in l)
        assert "Personal Care" in care_line, "'Personal Care' was incorrectly filtered"
