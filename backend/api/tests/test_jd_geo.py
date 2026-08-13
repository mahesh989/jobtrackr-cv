"""
Regression tests for the JD-geography helper used by company research
disambiguation. This is the layer that prevents UK Sanctuary Group facts
from being applied to an Australian Sanctuary Care JD.
"""
from app.services.company.jd_geo import (
    country_full_name,
    detect_country,
    fact_text_country_mismatch,
    normalise_location,
)


# ---------------------------------------------------------------------------
# detect_country
# ---------------------------------------------------------------------------

def test_detect_country_au_state_suffix():
    assert detect_country("Rouse Hill, Sydney NSW") == "AU"
    assert detect_country("Melbourne VIC, Australia") == "AU"
    assert detect_country("Brisbane QLD") == "AU"
    assert detect_country("Perth WA") == "AU"


def test_detect_country_au_city_only():
    assert detect_country("Sydney") == "AU"
    assert detect_country("Melbourne") == "AU"


def test_detect_country_uk():
    assert detect_country("London, United Kingdom") == "UK"
    assert detect_country("Manchester, England") == "UK"
    assert detect_country("Edinburgh, Scotland") == "UK"


def test_detect_country_us():
    assert detect_country("San Francisco, CA") == "US"
    assert detect_country("New York, NY") == "US"
    assert detect_country("Austin, Texas") == "US"


def test_detect_country_ca_and_nz():
    assert detect_country("Toronto, Ontario") == "CA"
    assert detect_country("Auckland, New Zealand") == "NZ"


def test_detect_country_au_regional_town_with_full_state_name():
    """C26 / finding #56 — the AU marker list only had state ABBREVIATIONS
    (nsw/vic/qld/wa/tas/act/nt), not full state names. A regional AU town
    not already in the AU city list (Dubbo, Geelong) paired with a JD that
    spells the state out in full had nothing in the AU list to match,
    so the search fell through to other countries' markers instead —
    "wales" (UK), "hamilton" (NZ) — or matched nothing at all. Reproduced
    verbatim from the audit."""
    assert detect_country("Dubbo, New South Wales") == "AU"
    assert detect_country("Hamilton, Victoria") == "AU"
    assert detect_country("Geelong, Victoria") == "AU"


def test_detect_country_au_every_full_state_and_territory_name():
    assert detect_country("Some Town, New South Wales") == "AU"
    assert detect_country("Some Town, Victoria") == "AU"
    assert detect_country("Some Town, Queensland") == "AU"
    assert detect_country("Some Town, Western Australia") == "AU"
    assert detect_country("Some Town, Tasmania") == "AU"
    assert detect_country("Some Town, Australian Capital Territory") == "AU"
    assert detect_country("Some Town, Northern Territory") == "AU"


def test_detect_country_genuine_uk_wales_still_resolves_uk():
    """Guard against overcorrection: adding "new south wales" as an AU
    marker must not stop a genuinely UK "Wales" JD from resolving UK."""
    assert detect_country("Cardiff, Wales") == "UK"
    assert detect_country("Wales, United Kingdom") == "UK"


def test_detect_country_victoria_bc_canada_is_not_misclassified_au():
    """Regression guard, found during this chunk's own self-review before
    any PR was opened: bare "victoria" is genuinely ambiguous with the real
    Canadian city Victoria, BC — an earlier draft of this fix added it as an
    unqualified AU marker, which (since AU is checked first) wrongly
    reclassified "Victoria, BC, Canada" as AU instead of the correct CA,
    and "Victoria, British Columbia, Canada" as AU instead of its
    pre-existing (separately-tracked, out of scope) UK misclassification.
    The genuine AU usage is always "<Town>, Victoria" — the state name
    TRAILING a comma, never leading the string — so the fix matches that
    specific shape instead of the bare word. These three assertions pin the
    exact pre-fix behaviour: unaffected by this chunk either way."""
    assert detect_country("Victoria, British Columbia, Canada") == "UK"
    assert detect_country("Victoria, BC") is None
    assert detect_country("Victoria, BC, Canada") == "CA"


def test_detect_country_unknown_returns_none():
    """Conservative — return None rather than guess for locations we don't
    confidently match. Downstream code treats None as 'skip geo gates'."""
    assert detect_country("") is None
    assert detect_country(None) is None
    assert detect_country("Some Tiny Village") is None
    assert detect_country("Remote") is None


# ---------------------------------------------------------------------------
# normalise_location
# ---------------------------------------------------------------------------

def test_normalise_location_drops_leading_suburb_when_three_parts():
    # 3+ parts: drop everything before the last two (suburb noise).
    assert normalise_location("Rouse Hill, Sydney NSW, Australia") == "Sydney NSW Australia"


def test_normalise_location_keeps_short_locations():
    # 2 or fewer parts: keep as-is. The suburb may add useful search
    # specificity ("Rouse Hill" + "Sydney NSW" → unique enough to find the
    # right Sanctuary). Conservative join preserves all the user supplied.
    assert normalise_location("Sydney NSW") == "Sydney NSW"
    assert normalise_location("Rouse Hill, Sydney NSW") == "Rouse Hill Sydney NSW"
    assert normalise_location("London") == "London"


def test_normalise_location_handles_empty():
    assert normalise_location("") is None
    assert normalise_location(None) is None


# ---------------------------------------------------------------------------
# country_full_name
# ---------------------------------------------------------------------------

def test_country_full_name():
    assert country_full_name("AU") == "Australia"
    assert country_full_name("UK") == "United Kingdom"
    assert country_full_name("US") == "United States"
    assert country_full_name(None) is None
    assert country_full_name("ZZ") is None


# ---------------------------------------------------------------------------
# fact_text_country_mismatch — the core defence
# ---------------------------------------------------------------------------

def test_uk_fact_on_au_jd_is_mismatch():
    """The Sanctuary regression: a fact about UK care homes must be flagged
    as a mismatch when the JD is for an Australian organisation."""
    fact = "Operates 110 care homes across England and Scotland."
    assert fact_text_country_mismatch(fact, "AU") is True


def test_au_fact_on_au_jd_is_not_mismatch():
    fact = "Operates aged care facilities across Sydney NSW and Melbourne."
    assert fact_text_country_mismatch(fact, "AU") is False


def test_fact_with_no_country_marker_is_not_mismatch():
    """Conservative — a fact that mentions no country at all is never
    flagged as a mismatch. We only drop facts that clearly belong to a
    different country."""
    fact = "Founded in 1856 to support community care."
    assert fact_text_country_mismatch(fact, "AU") is False


def test_no_jd_country_means_no_mismatch():
    """When the JD country is unknown, fall back to keeping all facts."""
    fact = "Operates 110 care homes across England and Scotland."
    assert fact_text_country_mismatch(fact, None) is False
    assert fact_text_country_mismatch(fact, "") is False


def test_empty_fact_text_is_not_mismatch():
    assert fact_text_country_mismatch("", "AU") is False
    assert fact_text_country_mismatch(None, "AU") is False
