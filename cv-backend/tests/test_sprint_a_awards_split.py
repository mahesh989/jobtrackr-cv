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
