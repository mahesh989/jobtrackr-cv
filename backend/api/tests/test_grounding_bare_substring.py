"""C53 (AUDIT-REPORT.md, api-eval-verticals-misc.md P2): compute_grounding
(eval/grounding.py, the "Layer-A fabrication grounding check") had an
unanchored substring clause — `norm in original_norm` — alongside the
correct word-boundary-padded check. Any candidate entity short enough to
occur inside an ordinary word in the CV was treated as grounded regardless
of context: "ai" is a substring of "maintained"/"trained"/"detail", "ml" is
a substring of "html".

This is NOT a cosmetic bug — compute_grounding feeds two LIVE production
strip gates (strip_ungrounded_bullet_parentheticals,
strip_ungrounded_skill_entities in enforce_w3.py), both reached from the
default w8_verified writer path via apply_w3_gates. A tech-family CV
listing "AI, ML" in its tailored Skills section, for a candidate whose real
CV never mentions either, shipped the fabricated claim to the delivered PDF
— because almost any CV of reasonable length contains "ai" or "ml" as a
letter sequence somewhere, the strip gate that exists specifically to catch
this class of fabrication silently failed open on exactly the entities most
likely to be fabricated by an AI writer (buzzword tech skills).

Fix: removed the bare substring clause. The word-boundary-padded check
(`f" {norm} " in original_blob`) already covers every genuine single-word
match the removed clause's own comment claimed to handle; the multi-word
all-parts check below it covers reordering/punctuation differences. Table
transcribed from the audit's own `backend/api/.venv` reproduction.
"""
from __future__ import annotations

from app.services.eval.grounding import compute_grounding


class TestBareAcronymsNoLongerFalseGroundViaSubstring:
    def test_REGRESSION_ai_ml_ungrounded_against_a_clean_cv(self):
        tailored = "## Skills\n- **Technical Skills:** AI, ML\n"
        cv = "Sales role at a shop. Sold goods to customers."
        report = compute_grounding(tailored, cv)
        assert sorted(report["ungrounded"]) == ["AI", "ML"]

    def test_REGRESSION_ai_ml_still_ungrounded_even_when_cv_contains_the_letter_sequences(self):
        # The audit's own key reproduction: "ai" hides inside "trained",
        # "ml" hides inside "html" — a CV that happens to contain these
        # ordinary words must NOT ground the fabricated "AI"/"ML" claim.
        tailored = "## Skills\n- **Technical Skills:** AI, ML\n"
        cv = "Sales role at a shop. Built HTML pages and trained staff."
        report = compute_grounding(tailored, cv)
        assert sorted(report["ungrounded"]) == ["AI", "ML"]

    def test_genuine_ai_ml_mention_still_grounds_correctly(self):
        # The fix must not make a CV that GENUINELY lists AI/ML experience
        # wrongly flag them as ungrounded.
        tailored = "## Skills\n- **Technical Skills:** AI, ML\n"
        cv = "Built AI-powered recommendation systems and ML pipelines."
        report = compute_grounding(tailored, cv)
        assert report["ungrounded"] == []

    def test_realistic_retail_cv_only_flags_the_genuinely_fabricated_entities(self):
        # Mirrors the audit's fuller reproduction: NLP/AWS/Snowflake/
        # Planisware are genuinely absent and must still be flagged; AI/ML
        # must now ALSO be flagged (were previously surviving via substring).
        tailored = (
            "## Skills\n"
            "- **Technical Skills:** AI, ML, NLP, AWS, Snowflake, Planisware\n"
        )
        cv = (
            "Retail sales associate. Trained new staff on POS systems. "
            "Maintained detailed inventory records and built HTML product pages."
        )
        report = compute_grounding(tailored, cv)
        assert sorted(report["ungrounded"]) == ["AI", "AWS", "ML", "NLP", "Planisware", "Snowflake"]


class TestWordBoundaryAndMultiWordChecksStillWork:
    """Confirm the two REMAINING grounding checks (word-boundary single
    match, multi-word all-parts match) are unaffected by removing the bare
    substring clause — these are what the removed clause's own comment
    claimed to justify, and they already cover it."""

    def test_single_word_entity_grounds_via_word_boundary(self):
        tailored = "## Skills\n- **Technical Skills:** Python\n"
        cv = "5 years of Python development experience."
        report = compute_grounding(tailored, cv)
        assert report["ungrounded"] == []

    def test_multi_word_entity_grounds_via_reordered_parts(self):
        tailored = "## Skills\n- **Technical Skills:** Project Management\n"
        cv = "Strong background in management of a complex project."
        report = compute_grounding(tailored, cv)
        assert report["ungrounded"] == []

    def test_multi_word_entity_still_flagged_when_only_one_part_present(self):
        tailored = "## Skills\n- **Technical Skills:** Adobe Photoshop\n"
        cv = "Experienced with Adobe Creative Cloud products."
        report = compute_grounding(tailored, cv)
        assert "Adobe Photoshop" in report["ungrounded"]


class TestKnownResidualCompoundFusedSkillsCanBeOverStripped:
    """Independent review's own finding, deliberately accepted rather than
    fixed here (see the source comment above the word-boundary check in
    grounding.py): a skill whose ONLY CV evidence is a fused compound token
    ("SQL" held only via "PostgreSQL", "Git" only via "GitHub") can now be
    wrongly flagged as ungrounded by compute_grounding in isolation — the
    old bare-substring clause used to (accidentally) ground it, but that
    same mechanism is exactly what let "AI"/"ML" fabricate via "trained"/
    "html". A naive fix (treat norm as grounded if it's a suffix/prefix of
    any whole CV token) does NOT work: "html" ends in "ml", so it would
    reopen the ML/html collision this chunk exists to close. Documented so
    a future reader sees the accepted trade-off directly, not just in a
    comment three files away."""

    def test_KNOWN_RESIDUAL_sql_via_postgresql_only_is_flagged_by_compute_grounding_alone(self):
        tailored = "## Skills\n- **Technical Skills:** SQL\n"
        cv = "5 years working with PostgreSQL databases."
        report = compute_grounding(tailored, cv)
        assert report["ungrounded"] == ["SQL"]  # accepted false positive, mitigated
        # elsewhere by apply_w3_gates's separate keep_skills exemption when
        # the JD's feasibility plan marks the keyword inject_directly.

    def test_but_an_explicit_sql_mention_elsewhere_still_grounds_correctly(self):
        tailored = "## Skills\n- **Technical Skills:** SQL\n"
        cv = "5 years working with PostgreSQL and writing complex SQL queries."
        report = compute_grounding(tailored, cv)
        assert report["ungrounded"] == []
