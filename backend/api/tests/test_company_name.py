"""
Regression tests for cover-letter company-name shortening.

The deterministic shortener guarantees: keep the full company name on its
first mention in the letter body, replace every later mention with a
confidently-derived short form. The shortener is intentionally conservative —
it only peels recognised LEGAL SUFFIXES, REGION TAGS, and generic BUSINESS-TYPE
DESCRIPTORS (Services, Solutions, Systems, etc.). Domain-meaningful words
(Bank, Hospital, Care, Health, Centre, Support) are deliberately NOT peeled
because they carry brand identity (NAB, Nepean Hospital, Bolton Clarke).
"""
from app.services.cover_letter.company_name import (
    short_company_name,
    normalise_company_in_body,
)


# ---------------------------------------------------------------------------
# short_company_name — happy paths
# ---------------------------------------------------------------------------

def test_peels_region_tail_and_connector():
    # "Uniting NSW & ACT" → drop "ACT", drop dangling "&", drop "NSW" → "Uniting"
    assert short_company_name("Uniting NSW & ACT") == "Uniting"


def test_peels_legal_suffix():
    assert short_company_name("Acme Corp") == "Acme"
    assert short_company_name("Acme Pty Ltd") == "Acme"
    assert short_company_name("Acme Holdings International") == "Acme"


def test_peels_business_type_descriptor():
    # The Sanctuary regression: "Services" must be peelable so the cover
    # letter doesn't keep repeating "Sanctuary Care and Support Services".
    assert short_company_name("Sanctuary Care and Support Services") \
        == "Sanctuary Care and Support"
    assert short_company_name("Acme Solutions") == "Acme"
    assert short_company_name("Acme Tech Solutions") == "Acme Tech"
    assert short_company_name("DataFlow Systems") == "DataFlow"
    assert short_company_name("BrightPath Consulting Group") == "BrightPath"


# ---------------------------------------------------------------------------
# short_company_name — conservative refusals
# ---------------------------------------------------------------------------

def test_does_not_peel_domain_meaningful_words():
    # These are real brand words, not descriptors — peeling them would lose
    # the brand identity recruiters recognise.
    assert short_company_name("Bolton Clarke") is None
    assert short_company_name("National Australia Bank") is None
    assert short_company_name("Bank of America") is None
    assert short_company_name("Johnson & Johnson") is None
    # "Hospital" and "Care" must NOT be peelable
    assert short_company_name("Nepean Private Hospital") is None
    assert short_company_name("Hardi Aged Care") is None


def test_single_word_returns_none():
    assert short_company_name("Uniting") is None
    assert short_company_name("Sanctuary") is None


def test_empty_returns_none():
    assert short_company_name("") is None
    assert short_company_name(None) is None


# ---------------------------------------------------------------------------
# normalise_company_in_body — end-to-end body replacement
# ---------------------------------------------------------------------------

def test_keeps_first_mention_replaces_subsequent():
    body = (
        "I'm applying for the Care Worker role with Sanctuary Care and Support Services. "
        "Sanctuary Care and Support Services' focus on community resonates with me. "
        "Joining Sanctuary Care and Support Services would let me apply my skills."
    )
    out = normalise_company_in_body(body, "Sanctuary Care and Support Services")
    assert out.count("Sanctuary Care and Support Services") == 1
    assert "Sanctuary Care and Support" in out
    # First sentence still has full name; later sentences shortened.
    assert out.split(". ")[0].endswith("Sanctuary Care and Support Services")


def test_uniting_first_mention_kept():
    body = (
        "Applying to Uniting NSW & ACT was an easy decision. "
        "Working at Uniting NSW & ACT has shaped my care philosophy."
    )
    out = normalise_company_in_body(body, "Uniting NSW & ACT")
    assert out.count("Uniting NSW & ACT") == 1
    assert "Working at Uniting has" in out


def test_no_op_when_name_cannot_be_shortened():
    # "Bolton Clarke" has no peelable tail — body is returned unchanged.
    body = "I admire Bolton Clarke. Bolton Clarke's residents deserve great care."
    assert normalise_company_in_body(body, "Bolton Clarke") == body


def test_no_op_when_name_appears_only_once():
    # Nothing to replace — shortening only kicks in on the 2nd+ mention.
    body = "I am applying to Uniting NSW & ACT for the Care Worker role."
    assert normalise_company_in_body(body, "Uniting NSW & ACT") == body


def test_case_insensitive_match():
    body = (
        "Acme Corp is my target. "
        "What draws me to acme corp is its mission. "
        "Joining ACME CORP would be ideal."
    )
    out = normalise_company_in_body(body, "Acme Corp")
    # First match preserved as-is; 2nd and 3rd replaced with short form.
    assert out.count("Acme") == 3  # 1 full + 2 short
    assert "Corp" not in out.replace("Acme Corp", "", 1)
