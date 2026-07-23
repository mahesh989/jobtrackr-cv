"""Single source of truth for skill/non-skill classification primitives.

Phase B — behaviour-preserving consolidation (jd-analysis-fix-plan.md).
The data still lives in the original modules; this file re-exports everything
so call sites can import from one place.

Phase C — reconciled divergences: sector phrases now strip everywhere
(aged care, domestic assistance added to post_process's sector set), credential
AU unit prefixes re-exported here so cv_jd_matching builds its regex from the
same list as post_process, and filler pattern extended with "across"/"supporting".
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Re-exports from existing modules (no data copied — single-source import)
# ---------------------------------------------------------------------------

# skills_section.py is the most comprehensive non-skill recogniser.
from app.services.eval.writers.skills_section import (
    _NON_SKILL_EXACT as NON_SKILL_EXACT,
    _NON_SKILL_PREFIXES as NON_SKILL_PREFIXES,
    _NON_SKILL_PATTERN as NON_SKILL_PATTERN,
    _is_non_skill_phrase as _is_non_skill_phrase_base,
)

# Role-category labels (sector/setting descriptors that suppress a skill from
# the Skills section even when lexicon-classified as domain_knowledge).
from app.services.eval.enforce import (
    _ROLE_CATEGORY_LABELS as ROLE_CATEGORY_LABELS,
    DEFAULT_SKILL_CAPS,
)

# AU vocational-training unit code prefixes — canonical list used by
# post_process._AU_UNIT_PREFIXES and cv_jd_matching._CREDENTIAL_PHRASE_RE.
from app.services.skills.post_process import _AU_UNIT_PREFIXES as AU_UNIT_PREFIXES

# Canonical category tuple — re-exported from app.enums (the single source).
from app.enums import CATEGORY_KEYS as CATEGORIES  # noqa: E402

# ---------------------------------------------------------------------------
# Unified non-skill predicate
# ---------------------------------------------------------------------------


def is_non_skill_phrase(phrase: str) -> bool:
    """Return True if phrase is a sector name, qualification, eligibility
    statement, or JD-phrasing filler — not a genuine candidate skill.

    Combines skills_section._is_non_skill_phrase (exact / prefix / pattern)
    with enforce._ROLE_CATEGORY_LABELS (sector/setting descriptors).

    This is the single authoritative "is-this-junk" predicate. All call sites
    that previously reimplemented this check should route through here.
    """
    t = (phrase or "").strip().lower()
    if not t:
        return True
    if t in ROLE_CATEGORY_LABELS:
        return True
    return _is_non_skill_phrase_base(t)
