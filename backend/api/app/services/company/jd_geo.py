"""
Lightweight geographic inference from a job's `location` string.

Used by the company research pipeline to bias Tavily queries and filter out
facts about same-named organisations in different countries (the "Sanctuary"
problem — JD's Australian NDIS provider vs. UK Sanctuary Group).

Deterministic, no external dependencies. Examples:
  "Rouse Hill, Sydney NSW"           → ("Sydney NSW", "AU")
  "Melbourne VIC, Australia"         → ("Melbourne VIC", "AU")
  "London, United Kingdom"           → ("London", "UK")
  "San Francisco, CA"                → ("San Francisco CA", "US")
  ""                                 → (None, None)

The country code is a 2-letter ISO-ish tag the rest of the pipeline uses to
match against fact text. Currently covers AU / UK / US / CA / NZ — the
families that appear in production. Add more by extending _COUNTRY_MARKERS.
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

# Token → country code mapping. Matched on word boundaries (case-insensitive)
# against the raw JD location string. First match wins (so a JD that contains
# both "Sydney" and "USA" — possible in re-export postings — resolves by
# whichever marker appears first). Keep markers TIGHT — only unambiguous
# place tokens, never normal English words. e.g. "Sydney" is safe; "Western"
# is not (could be "Western Australia" or "Western Sydney" or just an
# adjective).
_COUNTRY_MARKERS: dict[str, tuple[str, ...]] = {
    "AU": (
        "australia", "australian",
        "nsw", "vic", "qld", "wa", "tas", "act", "nt", "sa",  # C28b: "sa" was
        # the only AU state abbreviation missing (same collision-risk class
        # as the pre-existing "wa" — a bare 2-letter marker can coincide with
        # a state/country abbreviation elsewhere: "wa" vs. US Washington
        # state, "sa" vs. South Africa — accepted here for consistency with
        # every other bare abbreviation already in this tuple, not a new
        # risk this addition introduces).
        "new south wales", "western australia",
        "tasmania", "australian capital territory", "northern territory",
        # C28b: "south australia" was ALREADY incidentally covered before
        # this addition (it contains the "australia" marker above as a
        # word-bounded substring) — listed explicitly anyway for the same
        # self-documenting reason the other 6 full state names are, not
        # because it was a functional gap like the "sa" abbreviation above.
        "south australia",
        "sydney", "melbourne", "brisbane", "perth", "adelaide", "hobart",
        "canberra", "darwin", "gold coast", "newcastle", "wollongong",
    ),
    "UK": (
        "united kingdom", "uk", "u.k.", "england", "scotland", "wales",
        "british", "london", "manchester", "birmingham", "leeds",
        "liverpool", "edinburgh", "glasgow", "bristol", "cardiff",
    ),
    "US": (
        "united states", "u.s.a.", "u.s.",
        "new york", "nyc", "los angeles", "san francisco", "chicago",
        "boston", "seattle", "austin", "atlanta", "miami", "denver",
        "california", "texas", "florida",
    ),
    "CA": (
        "canada", "canadian",
        "toronto", "vancouver", "montreal", "ottawa", "calgary",
        "ontario", "quebec", "alberta", "british columbia",
    ),
    "NZ": (
        "new zealand",
        "auckland", "wellington", "christchurch", "hamilton",
    ),
}

# "Victoria" and "Queensland" are NOT in _COUNTRY_MARKERS["AU"] above — both
# collide with real places elsewhere ("Victoria, British Columbia, Canada";
# "Queensland Road, London"), which would wrongly resolve AU since AU is
# checked first. Genuine AU usage of either is always "<Town>, <State>" —
# the state name TRAILING a comma, never leading the string ("Queensland
# Road" has no comma before "Queensland") — so match that specific shape,
# not the bare word.
#
# Even in the correct trailing-comma position, both are still ambiguous
# enough to collide with an explicit OTHER country ("Esquimalt, Victoria,
# Canada" — comma-preceded "Victoria", but "Canada" makes the true answer
# CA). So this suffix match is suppressed whenever an unambiguous non-AU
# signal (a country name/nationality, or another country's own
# state/province) is ALSO present in the string — but NOT suppressed by an
# ordinary city name alone (e.g. NZ's "hamilton" in "Hamilton, Victoria"),
# since that city-name-level ambiguity is exactly what caused the original
# bug (finding #56) and what this whole fix exists to resolve.
#
# Residual, deliberately accepted gap: a colliding city/street name from
# another country with NO explicit country qualifier at all ("Vancouver
# Island, Victoria"; bare "London, Victoria") is indistinguishable from the
# genuine "Hamilton, Victoria" case by marker presence alone — both are
# "<foreign city>, Victoria" with no stronger signal either way. Resolving
# this would need a real gazetteer of AU vs. non-AU place names, well
# beyond this finding's scope; this platform's own stated design
# philosophy (AU checked first, "highest signal density in production
# right now") already biases toward AU in exactly this kind of genuine
# ambiguity, so this residual is a documented, reasoned trade-off, not an
# oversight.
_AU_STATE_SUFFIX_RE = re.compile(r",\s*(?:victoria|queensland)\b", re.IGNORECASE)

_STRONG_NON_AU_MARKERS: dict[str, tuple[str, ...]] = {
    "UK": ("united kingdom", "uk", "u.k.", "england", "scotland", "wales", "british"),
    "US": ("united states", "u.s.a.", "u.s.", "california", "texas", "florida"),
    "CA": ("canada", "canadian", "ontario", "quebec", "alberta", "british columbia"),
    "NZ": ("new zealand",),
}


def _has_strong_non_au_signal(text: str) -> bool:
    for markers in _STRONG_NON_AU_MARKERS.values():
        for marker in markers:
            if re.search(r"\b" + re.escape(marker) + r"\b", text):
                return True
    return False

_COUNTRY_FULL_NAME: dict[str, str] = {
    "AU": "Australia",
    "UK": "United Kingdom",
    "US": "United States",
    "CA": "Canada",
    "NZ": "New Zealand",
}


def country_full_name(country_code: Optional[str]) -> Optional[str]:
    """Return the human-readable country name for a 2-letter code, or None."""
    if not country_code:
        return None
    return _COUNTRY_FULL_NAME.get(country_code.upper())


def detect_country(location: Optional[str]) -> Optional[str]:
    """Return a 2-letter country code (AU/UK/US/CA/NZ) inferred from the
    location string, or None when nothing matches confidently.

    Conservative — returns None rather than guessing. The rest of the
    pipeline treats None as "skip geographic gates" and falls back to the
    pre-existing behaviour, so an unknown country never makes things worse.
    """
    if not location or not location.strip():
        return None
    text = " " + location.lower() + " "
    if not _has_strong_non_au_signal(text) and _AU_STATE_SUFFIX_RE.search(text):
        return "AU"
    # First-match-wins by order of preference. AU has highest signal density
    # in production right now; the rest are listed below it in rough order
    # of how often each appears.
    for cc in ("AU", "UK", "US", "CA", "NZ"):
        for marker in _COUNTRY_MARKERS[cc]:
            if re.search(r"\b" + re.escape(marker) + r"\b", text):
                return cc
    return None


def normalise_location(location: Optional[str]) -> Optional[str]:
    """Light cleanup of a JD location string for use in search queries.

    Strips leading suburbs ("Rouse Hill, Sydney NSW" → "Sydney NSW") since
    suburbs add little to disambiguation against same-named entities in
    other countries. Returns None for empty input.
    """
    if not location or not location.strip():
        return None
    parts = [p.strip() for p in location.split(",") if p.strip()]
    if not parts:
        return None
    # Keep the LAST 2 comma-separated parts when there are 3+ (drop the
    # leading suburb). For 1-2 parts, return as-is.
    if len(parts) >= 3:
        return " ".join(parts[-2:])
    return " ".join(parts)


def fact_text_country_mismatch(
    fact_text: str, jd_country: Optional[str]
) -> bool:
    """Return True iff `fact_text` mentions a country other than `jd_country`.

    Used as a filter to drop facts about same-named organisations in other
    countries (e.g. UK Sanctuary Group facts on an AU Sanctuary Care JD).

    No-op when jd_country is None or empty — caller falls back to keeping
    all facts. Conservative: a fact that mentions NO country at all is NOT
    flagged as a mismatch (it stays).
    """
    if not jd_country:
        return False
    if not fact_text:
        return False
    text = " " + fact_text.lower() + " "
    jd_country = jd_country.upper()
    for cc, markers in _COUNTRY_MARKERS.items():
        if cc == jd_country:
            continue
        for marker in markers:
            if re.search(r"\b" + re.escape(marker) + r"\b", text):
                return True
    return False
