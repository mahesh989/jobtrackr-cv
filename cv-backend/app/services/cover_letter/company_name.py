"""
Deterministic company-name normalisation for the cover-letter body.

A JD often gives a company's full/extended name ("Uniting NSW & ACT", "Acme
Corp Pty Ltd"). Used verbatim in every paragraph it reads stiff and
machine-generated. The composition prompt already asks the model to use the
full name once and a short form thereafter, but that is best-effort — this
module GUARANTEES it: keep the full name on its first mention, then replace
every later mention with the short form.

The short form is derived generally (no per-company list): peel recognised
LEGAL SUFFIXES (Pty, Ltd, Inc, Corp…) and REGION / JURISDICTION tags (NSW,
QLD, ACT, Australia…) off the END of the name, plus any connector ("&", "of",
"the") left dangling by that peel. It is deliberately CONSERVATIVE — it only
shortens when it can confidently peel a suffix/region tail, so names like
"Johnson & Johnson", "Bank of America" or "National Australia Bank" are left
untouched (no regression, the later mentions simply stay full as they do
today).
"""
from __future__ import annotations

import re
from typing import Optional

# Trailing tokens that mark a company's legal form — never part of the name a
# person says aloud.
_LEGAL_SUFFIX_TOKENS = {
    "pty", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc",
    "corp", "corporation", "co", "gmbh", "ag", "nv", "bv", "srl", "spa",
    "group", "holdings", "international", "global", "worldwide",
}
# Trailing region / jurisdiction tags (AU states & territories, common country/
# region codes). Kept tight on purpose: a word must be unambiguously a place
# tag, never a real name word (so "National", "America", "Bank" are excluded).
_REGION_TOKENS = {
    "nsw", "qld", "vic", "wa", "tas", "act", "nt", "sa",
    "australia", "aus", "anz", "apac", "emea", "usa", "uk", "nz",
}
# Connectors that can be left dangling once a suffix/region tail is peeled.
_CONNECTOR_TOKENS = {"&", "and", "of", "the", "/", "-", "–", "—", ","}


def short_company_name(name: str) -> Optional[str]:
    """
    Return a confidently-shortened form of `name`, or None when no safe
    shortening exists (caller should then leave the name unchanged).
    """
    raw = (name or "").strip()
    tokens = raw.split()
    if len(tokens) < 2:
        return None

    peeled = False
    while len(tokens) > 1:
        last = tokens[-1].strip(",.").lower()
        if last in _LEGAL_SUFFIX_TOKENS or last in _REGION_TOKENS:
            tokens.pop()
            peeled = True
            continue
        if last in _CONNECTOR_TOKENS:
            # Only ever reached as a dangling connector after a suffix/region
            # peel (e.g. the "&" in "Uniting NSW & ACT" once "ACT" is gone).
            tokens.pop()
            peeled = True
            continue
        break

    if not peeled:
        return None
    short = " ".join(tokens).strip(" ,&/-–—")
    if len(short) < 2 or short.lower() == raw.lower():
        return None
    return short


def normalise_company_in_body(body: str, full_name: str) -> str:
    """
    Keep the first occurrence of `full_name` in `body` as-is and replace every
    LATER occurrence with its short form. No-op when the name cannot be safely
    shortened or appears fewer than twice. Case-insensitive match; a trailing
    possessive ("…'s") is preserved because only the name span is replaced.
    """
    short = short_company_name(full_name)
    if not short:
        return body
    pattern = re.compile(re.escape(full_name.strip()), re.IGNORECASE)
    matches = list(pattern.finditer(body))
    if len(matches) < 2:
        return body

    out: list[str] = []
    last_end = 0
    for i, m in enumerate(matches):
        out.append(body[last_end:m.start()])
        out.append(m.group(0) if i == 0 else short)
        last_end = m.end()
    out.append(body[last_end:])
    return "".join(out)
