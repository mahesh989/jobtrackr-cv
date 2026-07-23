"""Shared types for the verticals package.

Putting RoleFamilyProfile here (rather than in eval/role_families.py) lets
the per-vertical config modules import the dataclass without creating a
circular dependency.

Import chain (no cycles):
  verticals/base.py          ← imports only app.enums (a leaf module)
  verticals/<id>/config.py   ← imports RoleFamilyProfile from verticals.base
  verticals/__init__.py      ← imports from verticals.base + verticals/<id>/config.py
  eval/role_families.py      ← imports RoleFamilyProfile + ROLE_FAMILIES from verticals
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace  # noqa: F401  (replace re-exported for callers)
from typing import Any, Dict, List, Tuple

from app.enums import CertPolicy, HeadlineBucket, InjectionPolicy


@dataclass(frozen=True)
class RoleFamilyProfile:
    id: str
    label: str
    aliases: List[str]                 # router keyword match (substrings, lowercased)
    section_order: List[str]           # exact ## section order
    skills_categories: List[str]       # the 3 skills-line labels for this family
    cert_policy: CertPolicy            # StrEnum — values are plain strings at runtime
    injection_policy: InjectionPolicy
    metric_vocab: List[str]            # domain metric words (for relevance/coverage)
    identity_guidance: str             # short prompt block: how to frame identity
    extra_rules: str = ""              # any family-specific rule text
    # Which internal bucket carries this family's HEADLINE competencies.
    headline_bucket: HeadlineBucket = HeadlineBucket.TECHNICAL
    # Verified equivalences: (jd_facing_term, [cv_terms_that_justify_it], category).
    equivalences: List[Tuple[str, List[str], str]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Per-family ATS keyword weights — sum to 50 (the Keyword Match half of the
    # 100-point ATS score).
    keyword_weights: Dict[str, int] = field(default_factory=lambda: {
        "technical_required":        25,
        "soft_skills_required":      10,
        "domain_knowledge_required":  5,
        "preferred_overall":         10,
    })


@dataclass(frozen=True)
class VerticalPack:
    """All per-vertical artefacts in one place.

    profile          – the RoleFamilyProfile config (section order, weights, …).
    prompt_hints     – the vertical-specific JD-analysis system-prompt appendix, or None.
    lexicon_vertical – the lexicon key passed to skills/classifier.py (e.g. "tech",
                       "nursing", "cleaning"), or None when the vertical has no curated
                       lexicon (general/master).
    lexicon_filename – filename inside this pack's folder, e.g. "lexicon.json",
                       or None when there is no lexicon.
    hooks            – a module-like object whose callables implement vertical-specific
                       logic (e.g. nursing subtype detection). None when not needed.
                       Wired in Phase D; None during Phase A.
    """
    profile:          RoleFamilyProfile
    prompt_hints:     str | None = None
    lexicon_vertical: str | None = None
    lexicon_filename: str | None = None
    hooks:            Any        = field(default=None, compare=False, hash=False)
