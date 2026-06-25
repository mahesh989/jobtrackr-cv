"""Vertical registry — single source of truth for per-vertical config.

Usage::

    from app.services.verticals import ROLE_FAMILIES, FAMILY_TO_LEXICON, get_vertical

    pack = get_vertical("tech")       # → VerticalPack
    profile = pack.profile            # → RoleFamilyProfile
    lexicon_v = pack.lexicon_vertical # → "tech"
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from app.services.verticals.base import RoleFamilyProfile, VerticalPack  # noqa: F401

from app.services.verticals.tech.config    import PROFILE as _TECH_PROFILE
from app.services.verticals.nursing.config import PROFILE as _NURSING_PROFILE
from app.services.verticals.manual.config  import PROFILE as _MANUAL_PROFILE
from app.services.verticals.general.config import PROFILE as _GENERAL_PROFILE

from app.services.verticals.tech.prompts    import JD_ANALYSIS_HINTS as _TECH_HINTS
from app.services.verticals.nursing.prompts import JD_ANALYSIS_HINTS as _NURSING_HINTS
from app.services.verticals.manual.prompts  import JD_ANALYSIS_HINTS as _CLEANING_HINTS

# nursing.hooks is self-contained (imports only verticals.base + stdlib),
# so importing it here is safe — no circular import.
import app.services.verticals.nursing.hooks as _nursing_hooks


VERTICALS: Dict[str, VerticalPack] = {
    "tech": VerticalPack(
        profile=_TECH_PROFILE,
        prompt_hints=_TECH_HINTS,
        lexicon_vertical="tech",
        lexicon_filename="lexicon.json",
        hooks=None,
    ),
    "nursing": VerticalPack(
        profile=_NURSING_PROFILE,
        prompt_hints=_NURSING_HINTS,
        lexicon_vertical="nursing",
        lexicon_filename="lexicon.json",
        hooks=_nursing_hooks,
    ),
    "manual": VerticalPack(
        profile=_MANUAL_PROFILE,
        prompt_hints=_CLEANING_HINTS,
        lexicon_vertical="cleaning",
        lexicon_filename="lexicon.json",
        hooks=None,
    ),
    "general": VerticalPack(
        profile=_GENERAL_PROFILE,
        prompt_hints=None,
        lexicon_vertical=None,
        lexicon_filename=None,
        hooks=None,
    ),
}

# Alias "master" → "general" so old callers using the id="master" still find
# a pack.  The profile itself still carries id="master" for backward compat.
VERTICALS["master"] = VERTICALS["general"]

# Convenience maps derived from the registry — these are the single source
# of truth that replace the four duplicated local literals.
ROLE_FAMILIES = {pack.profile.id: pack.profile for pack in VERTICALS.values()}

# family_id → lexicon vertical string (or None).  Replace all four local
# _FAMILY_TO_VERTICAL / _ROLE_FAMILY_TO_VERTICAL dicts with this.
FAMILY_TO_LEXICON: Dict[str, Optional[str]] = {
    pack.profile.id: pack.lexicon_vertical
    for pack in VERTICALS.values()
}


def get_vertical(vertical_id: str) -> Optional[VerticalPack]:
    """Return the VerticalPack for *vertical_id*, or None if not found."""
    return VERTICALS.get(vertical_id)


def all_verticals() -> List[VerticalPack]:
    """Return all unique VerticalPack objects (deduped; master==general omitted)."""
    seen: set[str] = set()
    result: List[VerticalPack] = []
    for pack in VERTICALS.values():
        if pack.profile.id not in seen:
            seen.add(pack.profile.id)
            result.append(pack)
    return result


def lexicon_path(vertical: str) -> Optional[Path]:
    """Absolute Path to this vertical's lexicon.json, or None if it has none."""
    pack = get_vertical(vertical)
    if pack is None or not pack.lexicon_filename:
        return None
    folder_map = {
        "tech":    "tech",
        "nursing": "nursing",
        "manual":  "manual",
        "cleaning": "manual",  # manual's pack uses the "cleaning" lexicon key
        "master":  "general",
        "general": "general",
    }
    folder = folder_map.get(vertical) or folder_map.get(pack.profile.id)
    if not folder:
        return None
    p = Path(__file__).parent / folder / pack.lexicon_filename
    return p if p.exists() else None
