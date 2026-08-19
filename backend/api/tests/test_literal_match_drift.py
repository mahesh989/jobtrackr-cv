"""C49 (AUDIT-REPORT.md #11 / api-pipeline.md P2): cv_jd_matching.py's and
tailored_rescoring.py's "does this keyword literally appear" predicates had
drifted. cv_jd_matching._literal_match_in_text (promotes a missed JD
keyword to matched on the ORIGINAL CV) always wrapped the keyword in
\\b...\\b — which can never match "C#", "C++", ".NET", or "Excel
(advanced)", since \\b requires a boundary the keyword's own trailing
non-word character can't provide. tailored_rescoring._literal_match (used
to credit a keyword in the TAILORED CV) already had the correct guard:
word-boundary regex for pure word/space/hyphen keywords, plain substring
for the rest.

The drift was asymmetric and output-affecting: a JD keyword like "C#" the
CV genuinely holds stayed stuck in `missed` on the ORIGINAL score
(understating it) while the SAME keyword, carried through unchanged into
the tailored CV, got correctly credited on the TAILORED side — reported to
the user as something tailoring "injected" and inflating `ats_lift` with a
gain tailoring never produced.

Fixed by moving the correct (tailored_rescoring) implementation to a
shared leaf module (_keyword_match.py) both delegate to. Table transcribed
from the audit's own verified reproduction.
"""
from __future__ import annotations

from app.services.pipeline.steps._keyword_match import literal_match
from app.services.pipeline.steps.cv_jd_matching import _literal_match_in_text
from app.services.pipeline.steps.tailored_rescoring import _literal_match

_CV = "Skills: C#, C++, .NET, node.js, Excel (advanced)"
_CV_LOWER = _CV.lower()


class TestBothMatchersNowAgree:
    """The exact table from the audit's own node -e / python -c
    reproduction — every keyword must now agree between the two matchers,
    where before "c#"/"c++"/".net"/"excel (advanced)" diverged."""

    def test_REGRESSION_hash_symbol_keyword(self):
        assert _literal_match_in_text("c#", _CV) is True
        assert _literal_match("c#", _CV_LOWER) is True

    def test_REGRESSION_plus_plus_keyword(self):
        assert _literal_match_in_text("c++", _CV) is True
        assert _literal_match("c++", _CV_LOWER) is True

    def test_REGRESSION_dot_prefixed_keyword(self):
        assert _literal_match_in_text(".net", _CV) is True
        assert _literal_match(".net", _CV_LOWER) is True

    def test_REGRESSION_parenthetical_keyword(self):
        assert _literal_match_in_text("excel (advanced)", _CV) is True
        assert _literal_match("excel (advanced)", _CV_LOWER) is True

    def test_word_only_keyword_already_agreed_and_still_does(self):
        assert _literal_match_in_text("node.js", _CV) is True
        assert _literal_match("node.js", _CV_LOWER) is True

    def test_a_keyword_genuinely_absent_from_the_cv_is_still_false_on_both(self):
        assert _literal_match_in_text("java", _CV) is False
        assert _literal_match("java", _CV_LOWER) is False

    def test_word_boundary_still_prevents_false_positives_like_ai_matching_fair(self):
        cv = "Worked in a fair and transparent environment."
        assert _literal_match_in_text("ai", cv) is False
        assert _literal_match("ai", cv.lower()) is False


class TestSharedHelperDirectly:
    def test_empty_keyword_is_false(self):
        assert literal_match("", "some text") is False

    def test_pure_word_keyword_uses_word_boundary(self):
        assert literal_match("communication", "excellent communication skills") is True
        assert literal_match("communication", "telecommunications") is False

    def test_punctuated_keyword_uses_substring(self):
        assert literal_match("c#", "skills: c#, java") is True

    def test_cv_jd_matching_wrapper_accepts_mixed_case(self):
        # _literal_match_in_text's own established contract: accepts raw
        # (mixed-case) OR pre-lowered text, lowercasing both internally.
        assert _literal_match_in_text("C#", "Skills: c#, java") is True
        assert _literal_match_in_text("c#", "Skills: C#, Java") is True
