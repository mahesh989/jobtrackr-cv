"""Phase 2 — Sprint C: body spelling + heading title-case + date format.

Three small deterministic post-passes:
  • canonicalise_body_spelling   — extend British/Australian spelling to
                                    everything outside Skills (body, summary,
                                    education, awards). Case-preserving.
  • normalise_heading_title_case — italic role lines + H3 headings get
                                    proper title case. "Assistant In Nursing"
                                    → "Assistant in Nursing". Preserves
                                    ALL-CAPS (IV/NSW/CPR) and brands (BESTMed).
  • normalise_date_formats       — strip day-of-month. "Sept 20, 2024" →
                                    "Sept 2024".

Source bugs from the GPT-5.1 Anglicare run (post-Sprint-B):
  - "Assistant In Nursing (Casual)" — capital "In"
  - "Sept 20, 2024" — day-of-month sticks out
  - Mixed US/UK ("individualized" + "specialised") drift
"""
from __future__ import annotations

from app.services.eval.writers import (
    canonicalise_body_spelling,
    normalise_heading_title_case,
    normalise_date_formats,
    _title_case_phrase,
    _apply_body_spelling_subs,
)


# ---------------------------------------------------------------------------
# Module 4 — body spelling (case-preserving)
# ---------------------------------------------------------------------------


class TestBodySpellingCaseStyles:

    def test_lowercase_individualized_to_individualised(self):
        assert _apply_body_spelling_subs("individualized care plans") == "individualised care plans"

    def test_capitalised_individualized_to_individualised(self):
        assert _apply_body_spelling_subs("Individualized care plans") == "Individualised care plans"

    def test_all_caps_individualized_to_individualised(self):
        # Likely never occurs but should still preserve.
        assert _apply_body_spelling_subs("INDIVIDUALIZED CARE") == "INDIVIDUALISED CARE"

    def test_specialized_in_mid_sentence(self):
        out = _apply_body_spelling_subs("Delivered specialized dementia care across placements.")
        assert "specialised" in out
        assert "specialized" not in out

    def test_recognized_at_sentence_start(self):
        out = _apply_body_spelling_subs("Recognized for outstanding service.")
        assert out == "Recognised for outstanding service."

    def test_color_to_colour(self):
        assert _apply_body_spelling_subs("color theory") == "colour theory"

    def test_behavioral_to_behavioural(self):
        assert _apply_body_spelling_subs("behavioral management techniques") == "behavioural management techniques"

    def test_unrelated_words_unchanged(self):
        text = "size matters; the prize was won; she seized the moment"
        assert _apply_body_spelling_subs(text) == text

    def test_brand_inside_word_untouched(self):
        # We only have curated patterns; doesn't accidentally touch brand
        # spellings.
        text = "BESTMed and MedMobile use authoritative dosing"
        out = _apply_body_spelling_subs(text)
        # 'authoritative' has 'authoriz' nowhere, so it survives.
        assert "BESTMed" in out and "MedMobile" in out

    def test_skips_inline_code_span(self):
        md = "Use `analyze_data()` to analyze records."
        out = canonicalise_body_spelling(md)
        # Inside backticks: untouched. Outside: analyze → analyse.
        assert "`analyze_data()`" in out
        assert "to analyse records" in out

    def test_skips_fenced_code_block(self):
        md = "Outside specialized\n```\ninside specialized stays\n```\nafter specialized"
        out = canonicalise_body_spelling(md)
        assert out.startswith("Outside specialised")
        assert "inside specialized stays" in out  # untouched in code block
        assert "after specialised" in out


# ---------------------------------------------------------------------------
# Module 5 — title-case normaliser
# ---------------------------------------------------------------------------


class TestTitleCasePhrase:

    def test_assistant_in_nursing(self):
        assert _title_case_phrase("Assistant In Nursing") == "Assistant in Nursing"

    def test_bachelor_of_science(self):
        assert _title_case_phrase("Bachelor Of Science") == "Bachelor of Science"

    def test_certificate_iv_in_ageing_support(self):
        # IV must stay ALL-CAPS, "in" lowercase.
        assert _title_case_phrase("Certificate IV In Ageing Support") == "Certificate IV in Ageing Support"

    def test_first_word_capitalised_even_if_stopword(self):
        # "A Career Path" — first "A" stays capital.
        assert _title_case_phrase("A Career Path") == "A Career Path"

    def test_last_word_capitalised_even_if_stopword(self):
        # "Where We Live On" — trailing "On" stays capital (last position).
        assert _title_case_phrase("Where We Live On") == "Where We Live On"

    def test_brand_preserved_mixed_case(self):
        assert _title_case_phrase("Using BESTMed Daily") == "Using BESTMed Daily"

    def test_hyphenated_compound(self):
        assert _title_case_phrase("person-centred care") == "Person-Centred Care"

    def test_state_abbreviation_preserved(self):
        assert _title_case_phrase("Miranda NSW Office") == "Miranda NSW Office"


class TestTitleCaseInMarkdown:

    def test_italic_role_line_fixed(self):
        md = "*Assistant In Nursing (Casual) | May 2025 – Present*"
        out = normalise_heading_title_case(md)
        assert "Assistant in Nursing" in out
        assert "Assistant In Nursing" not in out

    def test_h3_employer_line_untouched_when_proper_noun(self):
        # All-word-Capitalised proper nouns stay the same — the pass produces
        # the same output for already-correct H3s.
        md = "### Jesmond Miranda Nursing Home | Miranda, NSW"
        assert normalise_heading_title_case(md) == md

    def test_education_qualification_line(self):
        md = "*Certificate IV In Ageing Support | May 2025*"
        out = normalise_heading_title_case(md)
        assert out == "*Certificate IV in Ageing Support | May 2025*"

    def test_idempotent(self):
        md = "*Bachelor Of Science | Sept 2019 – June 2022*"
        once = normalise_heading_title_case(md)
        twice = normalise_heading_title_case(once)
        assert once == twice


# ---------------------------------------------------------------------------
# Module 6 — date format
# ---------------------------------------------------------------------------


class TestDateFormat:

    def test_sept_20_2024_stripped(self):
        out = normalise_date_formats("*Aged Care Placement | Sept 20, 2024*")
        assert out == "*Aged Care Placement | Sept 2024*"

    def test_may_2025_unchanged(self):
        md = "*Worker | May 2025 – Present*"
        assert normalise_date_formats(md) == md

    def test_range_unchanged(self):
        md = "*Bachelor | Sept 2019 – June 2022*"
        assert normalise_date_formats(md) == md

    def test_multiple_dates_with_day_all_stripped(self):
        md = "Started Jan 15, 2023 and ended Dec 31, 2024."
        out = normalise_date_formats(md)
        assert "Jan 2023" in out
        assert "Dec 2024" in out
        assert "15" not in out
        assert "31" not in out

    def test_unknown_month_word_untouched(self):
        # "Whatever 20, 2024" — "Whatever" isn't a month name → leave alone.
        md = "Whatever 20, 2024"
        assert normalise_date_formats(md) == md

    def test_idempotent(self):
        md = "Sept 20, 2024 and also Jan 5, 2023"
        once = normalise_date_formats(md)
        twice = normalise_date_formats(once)
        assert once == twice
