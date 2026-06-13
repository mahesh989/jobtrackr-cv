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
        "nsw", "vic", "qld", "wa", "tas", "act", "nt",
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
