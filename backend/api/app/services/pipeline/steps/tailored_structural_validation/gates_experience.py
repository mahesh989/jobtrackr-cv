"""Experience gates — role/bullet counts, length, periods, metrics.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
import re
from .parsing import (
    _EXPERIENCE_ALIASES,
    _PROJECTS_ALIASES,
    _parse_entries,
    _resolve_section,
    _word_count,
)
from .results import (
    _result,
    _short,
)

# Heuristic for "this bullet contains a metric". Catches:
#   - "10%"  "12.5%"  "$2M"  "300+"  "5x"
#   - "3-5 reports"  "10M records"  "12 months"  "$500k"
#   - "8 dashboards", "two e-commerce retailers" (number words excluded —
#     too many false positives; we use digits as the signal).
_METRIC_PATTERN = re.compile(
    r"""
    \$\s*\d                                         # currency e.g. $2, $500k
    | \b\d+(?:\.\d+)?\s*%                           # percentage
    | \b\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?        # ranges 3-5, 10–12
    | \b\d+(?:\.\d+)?\s*\+                          # 300+
    | \b\d+(?:\.\d+)?\s*[kKmMbB]\b                  # 10k, 2M, 1B
    | \b\d+\s*x\b                                   # 5x
    | \b\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?|months?|years?
                          |seconds?|minutes?
                          |users?|customers?|records?|rows?
                          |stores?|countries?|teams?|reports?
                          |dashboards?|stakeholders?|clients?
                          |websites?|projects?)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _gate_experience_role_count(sections: Dict[str, str]) -> Dict[str, Any]:
    body = _resolve_section(sections, _EXPERIENCE_ALIASES)
    entries = _parse_entries(body)
    n = len(entries)
    if n == 0:
        return _result(
            "experience_role_count", "fail",
            "No experience entries detected.",
        )
    if n > 3:
        return _result(
            "experience_role_count", "warn",
            f"{n} experience roles (target 1-3).",
        )
    return _result(
        "experience_role_count", "pass",
        f"{n} experience role(s).",
    )


def _gate_bullets_per_entry(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every Experience role and every Project entry must have 2-3 bullets.
    """
    issues: List[str] = []
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            total += 1
            n = len(entry["bullets"])
            if n < 2 or n > 3:
                issues.append(
                    f"{_short(entry['title_line'])}: {n} bullet(s)"
                )
    if total == 0:
        return _result(
            "bullets_per_entry", "warn",
            "No experience or project entries found.",
        )
    if issues:
        return _result(
            "bullets_per_entry", "fail",
            "Entries outside 2-3 bullet target: "
            + "; ".join(issues[:3])
            + (f" (+{len(issues) - 3} more)" if len(issues) > 3 else ""),
        )
    return _result(
        "bullets_per_entry", "pass",
        f"All {total} entry/entries have 2-3 bullets.",
    )


def _gate_experience_bullet_length(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Experience and Project bullets target 18-30 words. Anything beyond 30
    words is a soft warn — the bullet has gone run-on and should be split
    or trimmed. Hard fails reserved for >40 words (truly unreadable).
    """
    issues_warn: List[str] = []
    issues_fail: List[str] = []
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            for bullet in entry["bullets"]:
                total += 1
                w = _word_count(bullet)
                if w > 40:
                    issues_fail.append(f"{w}w: '{bullet[:50]}…'")
                elif w > 30:
                    issues_warn.append(f"{w}w: '{bullet[:50]}…'")

    if total == 0:
        return _result(
            "experience_bullet_length", "warn",
            "No Experience/Project bullets to check.",
        )
    if issues_fail:
        return _result(
            "experience_bullet_length", "fail",
            "Run-on bullets (>40w): "
            + "; ".join(issues_fail[:3])
            + (f" (+{len(issues_fail) - 3} more)" if len(issues_fail) > 3 else ""),
        )
    if issues_warn:
        return _result(
            "experience_bullet_length", "warn",
            f"{len(issues_warn)} of {total} bullets over 30 words: "
            + "; ".join(issues_warn[:3])
            + (f" (+{len(issues_warn) - 3} more)" if len(issues_warn) > 3 else ""),
        )
    return _result(
        "experience_bullet_length", "pass",
        f"All {total} Experience/Project bullets within 18-30 word target.",
    )


def _gate_period_terminator(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every bullet must end with terminal punctuation (. ! ?).
    """
    missing = 0
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            for bullet in entry["bullets"]:
                total += 1
                # Strip trailing markdown formatting characters before
                # checking the terminator.
                tail = bullet.rstrip().rstrip("*_`)\"'")
                if not tail.endswith((".", "!", "?")):
                    missing += 1
    if total == 0:
        return _result(
            "period_terminator", "warn",
            "No bullets to check.",
        )
    if missing == 0:
        return _result(
            "period_terminator", "pass",
            f"All {total} bullets end with terminal punctuation.",
        )
    if missing / total > 0.2:
        return _result(
            "period_terminator", "fail",
            f"{missing} of {total} bullets lack terminal punctuation.",
        )
    return _result(
        "period_terminator", "warn",
        f"{missing} of {total} bullets lack terminal punctuation.",
    )


def _gate_metric_coverage(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Soft target: 60% of bullets across Experience + Projects carry a metric.

    NEVER returns "fail". The whole point of the soft target is to avoid
    pressuring the writer to fabricate numbers; we only warn if coverage
    is conspicuously low (< 40%).
    """
    bullets: List[str] = []
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            bullets.extend(entry["bullets"])
    if not bullets:
        return _result(
            "metric_coverage", "warn",
            "No bullets to check.",
        )
    with_metric = sum(1 for b in bullets if _METRIC_PATTERN.search(b))
    pct = with_metric / len(bullets)
    detail = (
        f"{with_metric}/{len(bullets)} bullets carry a metric "
        f"({pct:.0%}; soft target 60%)."
    )
    if pct < 0.4:
        return _result("metric_coverage", "warn", detail)
    return _result("metric_coverage", "pass", detail)
