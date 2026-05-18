"""
Company name → canonical slug for use as company_research.company_id.

Deterministic, no external dependencies. Examples:
  'JLL Australia'       → 'jll_australia'
  'Jones Lang LaSalle'  → 'jones_lang_lasalle'
  'Atlassian'           → 'atlassian'
  '  !!Weird Name!!  '  → 'weird_name'
  ''                    → 'unknown_company'   (safe fallback)
"""
from __future__ import annotations

import re


_MAX_SLUG_LEN = 80


def make_company_slug(company_name: str) -> str:
    """
    Normalise a company name into a stable, URL-safe slug.

    Steps:
      1. Strip leading/trailing whitespace.
      2. Lowercase.
      3. Replace any run of non-alphanumeric characters (except spaces) with a space.
      4. Replace runs of whitespace with a single underscore.
      5. Strip leading/trailing underscores.
      6. Truncate to _MAX_SLUG_LEN characters.
      7. If empty after normalisation, return 'unknown_company'.
    """
    if not company_name or not company_name.strip():
        return "unknown_company"

    slug = company_name.strip().lower()
    # Replace non-alphanumeric, non-space chars with space
    slug = re.sub(r"[^a-z0-9 ]", " ", slug)
    # Collapse whitespace to underscores
    slug = re.sub(r"\s+", "_", slug)
    slug = slug.strip("_")
    slug = slug[:_MAX_SLUG_LEN].rstrip("_")

    return slug or "unknown_company"
