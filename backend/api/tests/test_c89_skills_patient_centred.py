"""C89 — regression test for skills_section.py's patient-centred ->
person-centred rewrite (finding #23 from the C79 writers/* read-through,
documented in ~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

_canonicalise_skill_spelling silently changed "patient-centred" to
"Person-Centred" despite being scoped/documented as spelling normalisation
only. These are different concepts in healthcare, not a spelling variant:
"patient-centred care" centres decisions on the individual patient's needs
and preferences; "person-centred care" is the broader aged-care/disability
framing of the whole person, not just their clinical needs. Rewriting one
into the other changes what the tailored CV actually claims, and can
reduce exact keyword alignment when a JD specifically says
"patient-centered care".

User confirmed (2026-08-18): fix as a bug. _canonicalise_skill_spelling
should still normalise the AMERICAN spelling ("patient-centered") to the
BRITISH one ("Patient-Centred") -- that IS a genuine spelling variant --
but must never substitute a different underlying term.
"""
from __future__ import annotations

from app.services.eval.writers.skills_section import _canonicalise_skill_spelling


def test_c23_patient_centred_is_not_rewritten_to_person_centred():
    assert _canonicalise_skill_spelling("Patient-Centred Care") == "Patient-Centred Care"


def test_c23_patient_centered_american_spelling_normalises_to_british_but_keeps_patient():
    """The spelling (centered -> centred) IS a genuine normalisation
    target; the underlying term (patient, not person) must survive it."""
    out = _canonicalise_skill_spelling("Patient-Centered Care")
    assert "Patient" in out
    assert "Centred" in out
    assert "Person" not in out


def test_c23_person_centred_still_normalises_unaffected():
    """Sanity: the genuine person-centred spelling normalisation (a
    different, legitimate case) must be untouched by this fix."""
    assert _canonicalise_skill_spelling("Person-Centered Care") == "Person-Centred Care"
    assert _canonicalise_skill_spelling("person-centred care") == "Person-Centred care"
