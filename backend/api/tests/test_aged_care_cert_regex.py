"""C63 (AUDIT-REPORT.md B6-F2): _CERT_RE (role_families.py) only recognised
the literal word "certificate" spelled in full, with a Roman-numeral level
("certificate iv"). Real CVs and JDs commonly abbreviate to "Cert"/"Cert."
and/or use Arabic numerals ("Cert IV", "Cert. IV", "Certificate 3", "Cert 4")
— every one of those defeats the regex entirely, so
_aged_care_cert_level()/_required_aged_care_cert_level() silently return 0/
None for them. That breaks promote_matched_equivalents' own subsumption
rule (a higher/alternative AQF cert in the CV should subsume a lower/
alternative one the JD lists) for any CV or JD phrased with the common
abbreviated form — the JD requirement stays in `missed` even though the
CV genuinely holds an equal-or-higher qualification, understating the
candidate's true fit. Fabrication-adjacent severity class (same family as
C17): a matching failure here is a false "missing", not a fabricated
match, so the direction is safe, but it's still a real correctness bug in
qualification-level reasoning, not a cosmetic one.
"""
from __future__ import annotations

from app.services.eval.role_families import (
    _aged_care_cert_level,
    _required_aged_care_cert_level,
)


class TestAgedCareCertLevelRecognisesAbbreviatedForms:
    """_aged_care_cert_level — scans CV text for the highest aged-care-family
    certificate level present."""

    def test_full_word_roman_numeral_still_works(self):
        assert _aged_care_cert_level("Certificate IV in Ageing Support") == 4

    def test_REGRESSION_abbreviated_cert_no_period(self):
        assert _aged_care_cert_level("Cert IV in Ageing Support") == 4

    def test_REGRESSION_abbreviated_cert_with_period(self):
        assert _aged_care_cert_level("Cert. IV in Ageing Support") == 4

    def test_REGRESSION_full_word_arabic_numeral(self):
        assert _aged_care_cert_level("Certificate 3 in Individual Support") == 3

    def test_REGRESSION_abbreviated_cert_arabic_numeral(self):
        assert _aged_care_cert_level("Cert 4 in Individual Support") == 4

    def test_REGRESSION_abbreviated_cert_period_arabic_numeral(self):
        assert _aged_care_cert_level("Cert. 3 in Individual Support") == 3

    def test_still_zero_for_no_cert_mention(self):
        assert _aged_care_cert_level("Experienced support worker, no formal qualification") == 0

    def test_still_zero_for_non_aged_care_stream(self):
        # A Certificate IV that isn't in an aged-care/personal-care stream
        # must not count — this is the existing stream-matching guard,
        # confirm it survives the regex widening.
        assert _aged_care_cert_level("Certificate IV in Building and Construction") == 0

    def test_takes_the_highest_level_when_multiple_are_present_abbreviated(self):
        text = "- Cert III in Individual Support\n- Cert IV in Ageing Support"
        assert _aged_care_cert_level(text) == 4

    def test_takes_the_highest_level_when_two_mentions_share_one_clause(self):
        # Independent review of an earlier draft: the stream-descriptor
        # character class originally included a comma, which let the first
        # match's greedy stream capture swallow straight through a SECOND
        # "cert ..." mention appearing after a comma in the same sentence —
        # finditer never saw the second (higher-level) mention as a
        # separate match at all. Confirmed pre-existing (identical with the
        # original full-word/Roman-only regex on the equivalent full-word
        # input) but WIDENED into a live false positive by this chunk's own
        # abbreviated-form fix (see the next test) — fixed by dropping the
        # comma from the stream character class, which correctly bounds
        # each match at the clause boundary.
        text = "Cert III in Individual Support, later completed Cert IV in Ageing Support"
        assert _aged_care_cert_level(text) == 4

    def test_REGRESSION_does_not_count_an_unrelated_cert_whose_trailing_clause_happens_to_mention_aged_care(self):
        # Independent review's key finding: with the comma-inclusive stream
        # capture, "Cert IV in Business, Aged Care Assistant at Sunrise
        # Lodge" swept the UNRELATED "Aged Care Assistant" text (describing
        # a job title, not this cert's own stream) into the first match's
        # capture group, so an unrelated Business certificate wrongly
        # counted as aged-care-family. This was 0 (safe) under the
        # ORIGINAL full-word-only regex simply because "Cert IV" (abbrev-
        # iated) didn't match at all — C63's own abbreviation fix would
        # have turned this into a live false positive (0 -> 4) without the
        # comma-bounding fix landing in the same chunk.
        text = "Cert IV in Business, Aged Care Assistant at Sunrise Lodge"
        assert _aged_care_cert_level(text) == 0

    def test_does_not_false_positive_on_unrelated_word_containing_cert(self):
        # "certain"/"certify" must not be mistaken for "cert"/"certificate".
        assert _aged_care_cert_level("I am certain I can certify my own timesheets IV") == 0

    def test_KNOWN_RESIDUAL_a_stream_whose_only_qualifying_term_sits_after_the_comma_now_misses(self):
        # Round-2 review's own residual, accepted deliberately: same safe
        # false-MISSING direction as the original C63 bug (never the
        # false-match direction the comma bound exists to close). A real
        # fix needs a stream allowlist, not re-admitting the comma.
        assert _aged_care_cert_level("Cert IV in Community Services, Aged Care") == 0

    def test_ampersand_and_slash_before_a_comma_still_work(self):
        assert _aged_care_cert_level("Certificate III in Ageing & Disability, Melbourne Polytechnic") == 3
        assert _aged_care_cert_level("Cert IV in Aged Care/Disability, 2019") == 4

    def test_a_cert_mention_immediately_followed_by_a_comma_with_no_stream_is_not_grounded(self):
        assert _aged_care_cert_level("Cert IV, plus a National Police Check") == 0


class TestRequiredAgedCareCertLevelRecognisesAbbreviatedForms:
    """_required_aged_care_cert_level — parses a single JD keyword string."""

    def test_full_word_roman_numeral_still_works(self):
        assert _required_aged_care_cert_level("certificate iii in individual support") == 3

    def test_REGRESSION_abbreviated_cert_no_period(self):
        assert _required_aged_care_cert_level("cert iii in individual support") == 3

    def test_REGRESSION_abbreviated_cert_with_period(self):
        assert _required_aged_care_cert_level("cert. iii in individual support") == 3

    def test_REGRESSION_arabic_numeral(self):
        assert _required_aged_care_cert_level("cert 3 in individual support") == 3

    def test_returns_none_for_a_non_cert_keyword(self):
        assert _required_aged_care_cert_level("manual handling") is None
