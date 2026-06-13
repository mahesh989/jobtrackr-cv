"""
Cheap, deterministic detector for "this job is no longer open".

Runs before any AI step in the analysis pipeline. If it fires, the
pipeline is short-circuited to "failed" with a clear user-visible
reason — saving tokens and showing the user a useful error rather than
a tailored CV for a job they can't apply to.

We deliberately keep this conservative: only literal, unambiguous
phrases trigger the check. Date arithmetic ("closes 2024-01-15") is
intentionally NOT done here — too easy to misread relative dates and
abort a legitimate analysis. If we add date parsing later it goes here.
"""
from __future__ import annotations

import logging
import re
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Phrases that almost always mean "you can't apply to this job".
# Matched case-insensitively against the full JD text.
_EXPIRY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bthis (?:job|role|position|posting|vacancy) (?:has|is) (?:now\s+)?(?:closed|expired|filled)\b",
     "The job posting is marked closed/expired/filled."),
    (r"\bapplications? (?:are )?(?:no longer|not) (?:being )?accepted\b",
     "Applications are no longer accepted."),
    (r"\bwe are no longer accepting applications\b",
     "Applications are no longer accepted."),
    (r"\bjob (?:posting )?(?:has )?expired\b",
     "The job posting has expired."),
    (r"\bposition (?:has been )?filled\b",
     "The position has been filled."),
    (r"\brecruitment (?:is|has) closed\b",
     "Recruitment for this role has closed."),
    (r"\bvacancy closed\b",
     "The vacancy is closed."),
    (r"\bno longer (?:available|open|active)\b",
     "The role is no longer available."),
    (r"\bapplications closed\b",
     "Applications closed."),
)


def detect_jd_expiry(jd_text: str) -> Optional[str]:
    """
    Return a human-readable reason if the JD looks expired, else None.

    The reason string is short and user-facing — it's what the frontend
    will show in the failed-run message.
    """
    if not jd_text:
        return None
    text = jd_text.lower()
    for pattern, reason in _EXPIRY_PATTERNS:
        if re.search(pattern, text, flags=re.IGNORECASE):
            logger.info("JD expiry detected via pattern: %s", pattern)
            return reason
    return None


def assert_jd_open(jd_text: str) -> Tuple[bool, Optional[str]]:
    """Convenience: returns (is_open, reason_if_closed)."""
    reason = detect_jd_expiry(jd_text)
    return (reason is None, reason)
