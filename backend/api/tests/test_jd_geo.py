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
    assert detect_country("Some Town, South Australia") == "AU"


def test_REGRESSION_detect_country_south_australia_abbreviation_C28b():
    """C28b — from C28's own review: "sa" was the only AU state/territory
    ABBREVIATION missing from the marker set. ("South Australia" the full
    name was, on investigation, already incidentally covered — it contains
    the generic "australia" marker as a word-bounded substring — so the
    real, genuine gap was narrower than originally described: only the bare
    "SA" abbreviation, for a regional SA town not already on the AU city
    shortlist and a JD that abbreviates the state.)"""
    assert detect_country("Mount Gambier, SA") == "AU"
    assert detect_country("Whyalla, SA") == "AU"


def test_detect_country_south_australia_full_name_already_worked_before_C28b():
    # Confirmed via a temporary revert: this passed even pre-fix, because
    # "south australia" contains the pre-existing generic "australia"
    # marker as a word-bounded substring. C28b adds "south australia" to
    # the marker list explicitly anyway (self-documenting, matches the
    # other 6 full state names' own explicit listing), but it was never
    # the functional gap the original finding described.
    assert detect_country("Mount Gambier, South Australia") == "AU"


def test_detect_country_adelaide_already_worked_before_C28b():
    # Adelaide (a listed AU city marker) already resolved AU before this
    # chunk — confirms C28b's addition doesn't change already-correct cases.
    assert detect_country("Adelaide, South Australia") == "AU"


def test_detect_country_genuine_uk_wales_still_resolves_uk():
    """Guard against overcorrection: adding "new south wales" as an AU
    marker must not stop a genuinely UK "Wales" JD from resolving UK."""
    assert detect_country("Cardiff, Wales") == "UK"
    assert detect_country("Wales, United Kingdom") == "UK"


def test_detect_country_victoria_bc_canada_is_not_misclassified_au():
    """Regression guard, found during this chunk's own review process (after
    PR #157 was opened, via independent self-verification — NOT before any
    PR existed): bare "victoria" is genuinely ambiguous with the real
    Canadian city Victoria, BC — an earlier commit added it as an
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


def test_detect_country_explicit_non_au_signal_overrides_a_comma_preceded_state_name():
    """Independent review round found the comma-anchor guard above wasn't
    enough on its own: it fires whenever "victoria"/"queensland" appears
    in the correct trailing-comma position, with NO regard for other
    evidence in the string — so a comma-preceded "Victoria" or "Queensland"
    alongside an EXPLICIT competing country name still wrongly won as AU.
    An unambiguous non-AU signal (a country name/nationality, or another
    country's own state/province) must override the AU state-suffix match."""
    assert detect_country("Esquimalt, Victoria, Canada") == "CA"
    assert detect_country("Sidney, Victoria, BC, Canada") == "CA"
    assert detect_country("London, Victoria, United Kingdom") == "UK"
    assert detect_country("Pimlico, Victoria, London, UK") == "UK"
    assert detect_country("Houston, Victoria, Texas") == "US"


def test_detect_country_queensland_road_is_not_misclassified_au():
    """Same collision class as "victoria", found in the same review round:
    "Queensland Road" is a real London street. Fixed the same way — AU's
    "queensland" marker only fires in the trailing-comma state-name shape
    ("<Town>, Queensland"), which "Queensland Road, ..." never has (the
    word leads the string, immediately followed by "Road", not preceded by
    a comma)."""
    assert detect_country("Queensland Road, London") == "UK"
    assert detect_country("Queensland Road, Islington, London, UK") == "UK"


def test_detect_country_ambiguous_colliding_city_defaults_au_by_design():
    """Documented, deliberately accepted residual gap (see the comment above
    _AU_STATE_SUFFIX_RE in jd_geo.py): a colliding city/street name from
    another country with NO explicit country qualifier at all is
    indistinguishable, by marker presence alone, from the genuine
    "Hamilton, Victoria" audit case — both are "<foreign city>, Victoria"
    with no stronger signal on either side. Resolving this perfectly would
    need a real gazetteer of AU vs. non-AU place names; this platform's own
    documented design philosophy (AU checked first, "highest signal density
    in production right now") already biases toward AU in exactly this kind
    of genuine ambiguity, so these pin the current, intentional, non-gazetteer
    behaviour rather than silently drifting if it ever changes."""
    assert detect_country("Vancouver Island, Victoria") == "AU"
    assert detect_country("London, Victoria") == "AU"
    assert detect_country("Langford, Victoria, BC") == "AU"


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


def test_au_fact_on_non_au_jd_is_mismatch():
    """Independent review noted every existing test above used jd_country
    == "AU" — this exercises the reverse direction, the other value that
    matters given fact_text_country_mismatch skips its own jd_country's
    markers (jd_geo.py's `if cc == jd_country: continue`)."""
    fact = "Operates aged care facilities across Sydney NSW and Melbourne."
    assert fact_text_country_mismatch(fact, "CA") is True


def test_fact_mentioning_victoria_or_queensland_alone_is_not_flagged_as_au_mismatch():
    """Documents a deliberate, conservative scope boundary (see the C26 fix
    commit message): fact_text_country_mismatch iterates _COUNTRY_MARKERS
    directly, not detect_country, so it never gets the comma-anchored
    "victoria"/"queensland" AU signal — a fact mentioning bare "Victoria" or
    "Queensland" is never flagged as AU-relevant. This is the SAFE
    direction (may keep a fact it could arguably drop), the opposite of the
    original bug's over-filtering direction, and not one of finding #56's
    proven failure cases — left as an explicit, documented boundary."""
    fact = "Operates aged care facilities across regional Victoria and Queensland."
    assert fact_text_country_mismatch(fact, "CA") is False
