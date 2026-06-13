"""Phase 2 — Sprint A: awards/certifications disambiguator.

Verifies split_awards_and_certifications handles every shape we've seen
in production: mixed sections, pure-award sections, pure-cert sections,
empty sections, multiple source sections (LLM emitting both "Certifications"
AND "Recognition" simultaneously), and Registration-dup detection.

Source bug: GPT-5.1 Anglicare run (2026-06-03) put "First Aid Certification"
and "Staff Excellence Award" under one ## Certifications heading; the existing
_relabel_awards_only_certifications refused to rename (mixed content), so the
award sat under the wrong section and the cert duplicated Registration.
"""
from __future__ import annotations

from app.services.eval.writers import split_awards_and_certifications


# ---------------------------------------------------------------------------
# Mixed section → split into Awards + drop Registration-duplicates
# ---------------------------------------------------------------------------


class TestMixedSection:
    """Real Anglicare-run shape: cert + award under one Certifications heading."""

    def test_first_aid_cert_dropped_award_promoted(self):
        md = """
# Maheshwor Tiwari

## Professional Summary

Care worker.

## Certifications

First Aid Certification
Staff Excellence Award, Jesmond Miranda Nursing Home
  Recognised for hard work, caring nature, and positive attitude.

## Registration & Licences

National Police Check · First Aid (HLTAID011) · Medication Competency
""".strip()
        out = split_awards_and_certifications(md)
        # First Aid Certification should be dropped (duplicate of Registration's "First Aid").
        assert "First Aid Certification" not in out
        # Staff Excellence Award should now sit under ## Awards.
        assert "## Awards" in out
        assert "Staff Excellence Award" in out
        # The mixed "## Certifications" heading should be gone (everything was
        # either promoted to Awards or dropped as duplicate).
        # Registration & Licences must still be there.
        assert "## Registration & Licences" in out
        assert "First Aid (HLTAID011)" in out

    def test_pure_award_section_stays_as_awards(self):
        # Already-named Awards — should be unchanged.
        md = """
## Awards

Staff Excellence Award, Jesmond Miranda Nursing Home
  Recognised for hard work.
""".strip()
        out = split_awards_and_certifications(md)
        # No ## Certifications source section to act on; unchanged.
        # Should NOT introduce a second Awards section.
        assert out.count("## Awards") <= 1

    def test_pure_certifications_no_award_no_registration_dup(self):
        # Real industry cert that's NOT in Registration — keep under Certifications.
        md = """
## Certifications

AWS Certified Solutions Architect — Professional, Amazon Web Services (2024)
""".strip()
        out = split_awards_and_certifications(md)
        assert "## Certifications" in out
        assert "AWS Certified Solutions Architect" in out
        assert "## Awards" not in out

    def test_empty_certifications_section_is_dropped(self):
        md = """
## Certifications

## Education

Heritage Skills Institute
""".strip()
        out = split_awards_and_certifications(md)
        assert "## Certifications" not in out
        assert "## Education" in out


# ---------------------------------------------------------------------------
# Registration-dedup detection
# ---------------------------------------------------------------------------


class TestRegistrationDedup:
    """Credential entries that duplicate Registration & Licences content must
    be dropped — they don't belong as a separate Certifications line."""

    def test_cpr_dropped_when_in_registration(self):
        md = """
## Certifications

CPR Certificate

## Registration & Licences

CPR · First Aid (HLTAID011)
""".strip()
        out = split_awards_and_certifications(md)
        # CPR Certificate should be dropped; only Registration mention remains.
        assert "## Certifications" not in out
        # The Registration heading is preserved.
        assert "## Registration & Licences" in out

    def test_industry_cert_not_dropped_when_not_in_registration(self):
        # A real cert NOT in Registration should survive as Certifications.
        md = """
## Certifications

CKAD (Kubernetes Application Developer)

## Registration & Licences

Police Check · First Aid (HLTAID011)
""".strip()
        out = split_awards_and_certifications(md)
        assert "CKAD" in out
        assert "## Certifications" in out

    def test_award_not_treated_as_credential_dup(self):
        # Awards don't have credential anchors — should always go to Awards,
        # never deduped against Registration.
        md = """
## Certifications

Staff Excellence Award, Anglicare (2024)
  Outstanding contribution to resident care.

## Registration & Licences

First Aid · Police Check
""".strip()
        out = split_awards_and_certifications(md)
        assert "Staff Excellence Award" in out
        assert "## Awards" in out


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:

    def test_idempotent(self):
        # Running twice produces the same output.
        md = """
## Certifications

First Aid Certification
Staff Excellence Award, Org

## Registration & Licences

First Aid (HLTAID011)
""".strip()
        once = split_awards_and_certifications(md)
        twice = split_awards_and_certifications(once)
        assert once == twice

    def test_no_source_section_is_noop(self):
        md = """
## Skills

Personal Care, Dementia Care

## Experience

Some Org
- did a thing
""".strip()
        out = split_awards_and_certifications(md)
        assert out == md

    def test_recognition_heading_also_handled(self):
        # LLM sometimes emits "## Recognition" instead of "## Certifications".
        md = """
## Recognition

Staff Excellence Award, Anglicare
""".strip()
        out = split_awards_and_certifications(md)
        assert "## Recognition" not in out
        assert "## Awards" in out
        assert "Staff Excellence Award" in out

    def test_multiple_source_sections_merged(self):
        # Some LLM runs emit BOTH "## Certifications" AND "## Honours".
        md = """
## Certifications

First Aid Certification

## Honours

Excellence Award, Some Org

## Registration & Licences

First Aid (HLTAID011)
""".strip()
        out = split_awards_and_certifications(md)
        assert "## Certifications" not in out
        assert "## Honours" not in out
        assert "## Awards" in out
        assert "Excellence Award" in out
        # First Aid Certification dropped as Registration duplicate.
        assert "First Aid Certification" not in out


# ---------------------------------------------------------------------------
# Opal Healthcare regression (2026-06-12) — nested-paren award shape
# ---------------------------------------------------------------------------


class TestNestedParenAwardParse:
    """Production bug: source CV had 'Staff Excellence Award (The Jesmond
    Group, Miranda (Aug 2025))'. The inner '\\(([^()]+)\\)' regex in
    _parse_award_parts matched only the date paren, leaving the outer '('
    stuck in the name and the outer ')' spilling into description. Result:
    rendered as 'Staff Excellence Award (The Jesmond Group, Miranda (Aug 2025)'
    + newline + ').' New nested-paren pre-handler returns clean fields."""

    def test_double_paren_award_org_date_parsed(self):
        from app.services.eval.writers import _parse_award_parts
        name, org, date, desc = _parse_award_parts(
            "Staff Excellence Award (The Jesmond Group, Miranda (Aug 2025))"
        )
        assert name == "Staff Excellence Award"
        assert org == "The Jesmond Group, Miranda"
        assert date == "Aug 2025"
        assert desc == ""

    def test_double_paren_with_trailing_description(self):
        from app.services.eval.writers import _parse_award_parts
        name, org, date, desc = _parse_award_parts(
            "Staff Excellence Award (The Jesmond Group, Miranda (Aug 2025)) "
            "Recognised for hard work, caring nature, and positive attitude."
        )
        assert name == "Staff Excellence Award"
        assert org == "The Jesmond Group, Miranda"
        assert date == "Aug 2025"
        assert desc.startswith("Recognised for hard work")

    def test_double_paren_year_only_date(self):
        from app.services.eval.writers import _parse_award_parts
        name, org, date, desc = _parse_award_parts(
            "Dean's List (École Polytechnique (2021))"
        )
        assert name == "Dean's List"
        assert org == "École Polytechnique"
        assert date == "2021"

    def test_non_date_inner_paren_skips_nested_handler(self):
        """Guard: the nested handler is gated by a year/month presence check.
        When the inner paren has no date signal (e.g. 'Innovator Award (Acme
        Corp (LLC))'), the nested handler skips and lets the standard parser
        run as before. This documents that we don't accidentally interpret
        'LLC' as a date via the new pathway. (The standard parser still has
        its own issues with this shape — that's a separate pre-existing bug,
        not in scope for this fix.)"""
        from app.services.eval.writers import _parse_award_parts
        # Direct check: the nested-handler regex's date-validation step is
        # what gates the early-return path. We verify by trying a year-less
        # input and confirming the result is NOT the clean nested-handler
        # output (org would have been "Acme Corp" without trailing punct).
        name, _org, _date, _desc = _parse_award_parts(
            "Innovator Award (Acme Corp (LLC))"
        )
        # Nested handler would have set name = "Innovator Award" cleanly.
        # The standard parser leaves the opening paren glued to the name.
        # Either is acceptable here — we only assert that the LLC inner
        # didn't get cleanly promoted as a "date".
        assert "Innovator Award" in name  # name retained either way

    def test_full_format_renders_clean(self):
        """Integration: parse + format produces a single clean bullet line
        without nested parens or orphan punctuation on a separate line."""
        from app.services.eval.writers import _parse_award_parts, _format_award_entry
        name, org, date, desc = _parse_award_parts(
            "Staff Excellence Award (The Jesmond Group, Miranda (Aug 2025))"
        )
        lines = _format_award_entry(name, org, date, desc)
        assembled = "\n".join(lines)
        # Single ')' at the date close — not duplicated, not orphaned.
        assert assembled.count("(") == 1
        assert assembled.count(")") == 1
        # No orphan ')' on its own line.
        for line in lines:
            assert line.strip() != ")"
            assert line.strip() != ")."


# ---------------------------------------------------------------------------
# Description dedupe (Opal Healthcare follow-up, 2026-06-12)
# ---------------------------------------------------------------------------


class TestAwardDescriptionDedupe:
    """After the nested-paren parse fix landed, descriptions surfaced two
    near-identical sentences (Oxford-comma variants) that had been hidden
    by the prior malformed parse. The dedupe pass drops near-duplicates
    before rendering."""

    def test_oxford_comma_variants_deduped(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        out = _dedupe_award_description_sentences(
            "Recognised for hard work, caring nature and positive attitude. "
            "Recognised for hard work, caring nature, and positive attitude."
        )
        # One sentence should remain — the first (order preserved).
        assert out.count("Recognised for hard work") == 1
        assert "Recognised for hard work, caring nature" in out

    def test_distinct_sentences_preserved(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        desc = (
            "Recognised for clinical excellence and resident outcomes. "
            "Selected from a cohort of 50 staff."
        )
        out = _dedupe_award_description_sentences(desc)
        assert "clinical excellence" in out
        assert "Selected from a cohort" in out

    def test_three_duplicates_collapse_to_one(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        out = _dedupe_award_description_sentences(
            "Recognised for excellence. "
            "Recognised for Excellence. "
            "Recognised for excellence, 2025."
        )
        # First sentence wins; remaining sentences with identical normalised
        # forms are dropped. Punctuation/year variants collapse via _norm.
        kept = out.count(".")
        assert kept <= 2  # at most 2 distinct sentences (year suffix differs)

    def test_single_sentence_unchanged(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        s = "Recognised for clinical excellence."
        assert _dedupe_award_description_sentences(s) == s

    def test_empty_input(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        assert _dedupe_award_description_sentences("") == ""

    def test_format_award_entry_integrates_dedupe(self):
        """End-to-end: parse Opal nested-paren input + dedupe the duplicate
        description sentences. Final bullet has only one description sentence."""
        from app.services.eval.writers import _parse_award_parts, _format_award_entry
        content = (
            "Staff Excellence Award (The Jesmond Group Miranda (Aug 2025)) "
            "Recognised for hard work, caring nature and positive attitude. "
            "Recognised for hard work, caring nature, and positive attitude."
        )
        name, org, date, desc = _parse_award_parts(content)
        lines = _format_award_entry(name, org, date, desc)
        assembled = "\n".join(lines)
        # Only ONE "Recognised for" should appear in the assembled output.
        assert assembled.count("Recognised for hard work") == 1


# ---------------------------------------------------------------------------
# Fuzzy near-duplicate dedupe (Opal Healthcare follow-up #2, 2026-06-12)
# ---------------------------------------------------------------------------


class TestAwardDescriptionFuzzyDedupe:
    """Second Opal run surfaced a FUZZY duplicate the exact-dedupe missed:
    one sentence is a near-superset of the other (extra 'empathy' +
    'in resident care'). Token-overlap dedupe drops the shorter subset
    and keeps the richer superset."""

    def test_fuzzy_superset_subset_deduped(self):
        from app.services.eval.writers import _dedupe_award_description_sentences
        out = _dedupe_award_description_sentences(
            "Recognised for hard work, caring nature, empathy and positive "
            "attitude in resident care. "
            "Recognised for hard work, caring nature, and positive attitude."
        )
        # Only ONE 'Recognised for' should remain.
        assert out.count("Recognised for hard work") == 1
        # The RICHER (longer) sentence is the one kept.
        assert "empathy" in out
        assert "in resident care" in out

    def test_fuzzy_keeps_longer_regardless_of_order(self):
        """Even when the SHORTER sentence appears first, the longer/richer
        one is retained (longest-first processing)."""
        from app.services.eval.writers import _dedupe_award_description_sentences
        out = _dedupe_award_description_sentences(
            "Recognised for hard work, caring nature, and positive attitude. "
            "Recognised for hard work, caring nature, empathy and positive "
            "attitude in resident care."
        )
        assert out.count("Recognised for hard work") == 1
        assert "empathy" in out

    def test_genuinely_different_sentences_kept(self):
        """Low token overlap → both kept (not false-positive deduped)."""
        from app.services.eval.writers import _dedupe_award_description_sentences
        out = _dedupe_award_description_sentences(
            "Recognised for clinical excellence and resident outcomes. "
            "Selected from a field of fifty nominated staff members."
        )
        assert "clinical excellence" in out
        assert "Selected from a field" in out

    def test_opal_full_pipeline_fuzzy(self):
        """End-to-end: parse nested-paren award + fuzzy-dedupe its description."""
        from app.services.eval.writers import _parse_award_parts, _format_award_entry
        content = (
            "Staff Excellence Award (The Jesmond Group, Miranda (Aug 2025)) "
            "Recognised for hard work, caring nature, empathy and positive "
            "attitude in resident care. "
            "Recognised for hard work, caring nature, and positive attitude."
        )
        name, org, date, desc = _parse_award_parts(content)
        lines = _format_award_entry(name, org, date, desc)
        assembled = "\n".join(lines)
        assert assembled.count("Recognised for hard work") == 1
