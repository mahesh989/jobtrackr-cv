"""Grounding gate on matcher-surfaced Skills terms.

_surface_matched_skills used to document itself as "honest by construction:
only terms in matching['matched'] are added — the matcher verified each
against the original CV — so this never fabricates."

That guarantee does not hold. The matcher is an AI step and can conflate
related-but-different concepts. Observed in production on an aged-care JD:
the JD asked for "housekeeping"; the matcher marked it MATCHED citing the
evidence quote "hygiene support" — personal hygiene care, not domestic
cleaning — and this pass surfaced "Housekeeping" into the Skills of a CV
that never contains the word anywhere.
"""
from __future__ import annotations

from app.services.eval.writers.injection import (
    _is_term_grounded,
    _surface_matched_skills,
)

# Mirrors the shape of the real source CV this was found on: plain text,
# names "hygiene support" but never "housekeeping"; says "Collaborate with
# multidisciplinary teams" but never "collaboration" or "teamwork".
_CV = (
    "Experience\n"
    "Jesmond Miranda Nursing Home Miranda, NSW, Australia\n"
    "Assistant in Nursing (CERT IV) May. 2025 - Present\n"
    "- Deliver comprehensive personal care including hygiene support, "
    "mobility support, and feeding assistance.\n"
    "- Collaborate with multidisciplinary teams to implement individualized "
    "care plans.\n"
    "- Respond to emergencies using de-escalation techniques and safety "
    "protocols. Workplace Safety, Fire Safety.\n"
    "Anglicare Mildred Symons House Jannali, NSW, Australia\n"
)


class TestIsTermGrounded:
    def test_drops_the_fabricated_term(self):
        assert _is_term_grounded("housekeeping", _CV.lower()) is False

    def test_drops_terms_with_no_footprint_at_all(self):
        for term in ("cannulation", "haematology", "chemotherapy knowledge",
                     "meal preparation"):
            assert _is_term_grounded(term, _CV.lower()) is False, term

    def test_keeps_terms_present_verbatim(self):
        for term in ("personal care", "hygiene support", "mobility support"):
            assert _is_term_grounded(term, _CV.lower()) is True, term

    def test_keeps_morphological_variants(self):
        # "Collaboration" vs the CV's "Collaborate" — a whole-token check
        # would call this ungrounded. An earlier attempt at this gate did
        # exactly that and cut Soft Skills from 7 entries to 4.
        assert _is_term_grounded("collaboration", _CV.lower()) is True

    def test_prefix_match_does_not_leak_through_an_employer_name(self):
        # The CV contains "Anglicare Mildred Symons House". A substring test
        # on a 4-char stem ("hous") matches it, which would keep the very
        # fabrication this gate exists to remove. Matching is per-word on a
        # 6-char shared prefix, and housekeeping/house share only 5.
        assert "house" in _CV.lower()
        assert _is_term_grounded("housekeeping", _CV.lower()) is False

    def test_keeps_reworded_terms_sharing_one_word(self):
        # Deliberately permissive: one shared content word is enough.
        assert _is_term_grounded("care planning adherence", _CV.lower()) is True

    def test_no_cv_text_means_no_judgement(self):
        # Empty haystack must not drop everything.
        assert _is_term_grounded("housekeeping", "") is False


def _matching(*terms: str) -> dict:
    return {"matched": {"required": {"domain_knowledge": list(terms)}}}


_MD = (
    "## Skills\n"
    "- **Care Skills:** Personal Care\n"
    "- **Soft Skills:** Safety Awareness\n"
    "- **Other Skills:** BESTMed\n"
)


class TestSurfaceMatchedSkills:
    def test_ungrounded_matched_term_is_not_surfaced(self):
        out = _surface_matched_skills(
            _MD, _matching("housekeeping"), original_cv_text=_CV
        )
        assert "Housekeeping" not in out
        assert "housekeeping" not in out

    def test_grounded_matched_term_is_still_surfaced(self):
        out = _surface_matched_skills(
            _MD, _matching("mobility support"), original_cv_text=_CV
        )
        assert "mobility support" in out.lower()

    def test_gate_is_skipped_without_cv_text(self):
        # Back-compat: callers that cannot supply the CV keep the old
        # behaviour rather than silently losing every surfaced term.
        out = _surface_matched_skills(_MD, _matching("housekeeping"))
        assert "housekeeping" in out.lower()
