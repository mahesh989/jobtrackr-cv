"""Lexicon-based skill classifier.

A pure, deterministic resolver: phrase → canonical taxonomy entry.

    classify("wound management", "nursing")
        → Classification(canonical="wound care", category="domain_knowledge",
                         vertical="nursing", noise_type=None, match_kind="exact")

    classify("Australian permanent residency or citizenship", "nursing")
        → Classification(canonical="...", category=None, vertical=None,
                         noise_type="eligibility", match_kind="exact")

    classify("completely made up term xyz", "nursing")
        → None   # caller treats as unknown (safe-drop + log upstream)

Design rules
------------
- The category comes from the LEXICON, never from the LLM.
- The SAME lexicon classifies CV and JD, so a phrase is bucketed
  identically on both sides — which is what makes the matching table
  trustworthy.
- Universal noise (credentials / eligibility / framework noise) is
  checked FIRST. If a phrase is noise it can never be a "skill" — it is
  routed by its noise_type (credential → Registration & Licences;
  eligibility → profile work-rights match; noise → dropped).
- Resolution order inside a vertical lexicon:
      1. Exact match (case + punctuation insensitive via `normalise()`).
      2. Fuzzy match (difflib SequenceMatcher, cutoff 0.88) — catches
         minor misspellings ("wound managment", "infectoin control").
- Unknowns return None. Callers should LOG the unknown phrase (so the
  vocabulary can grow) but NEVER guess a category.

No I/O or pipeline dependencies — this module is pure functions over
the bundled JSON lexicons. Loaded once at import time into in-memory
dicts.
"""
from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Literal, Optional, Tuple

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

VerticalT = Literal["nursing", "cleaning", "tech"]
CategoryT = Literal["technical", "soft_skills", "domain_knowledge"]
NoiseT = Literal["credential", "eligibility", "noise"]
MatchKindT = Literal["exact", "normalised", "fuzzy"]

_VERTICALS: Tuple[VerticalT, ...] = ("nursing", "cleaning", "tech")
_CATEGORIES: Tuple[CategoryT, ...] = ("technical", "soft_skills", "domain_knowledge")
_NOISE_TYPES: Tuple[NoiseT, ...] = ("credential", "eligibility", "noise")


@dataclass(frozen=True)
class Classification:
    """Result of resolving a phrase against the lexicon.

    For SKILL hits: `canonical` + `category` + `vertical` are set;
    `noise_type` is None.

    For NOISE hits: `noise_type` is set ("credential" / "eligibility" /
    "noise"); `category` and `vertical` are None — noise is universal.
    """
    canonical: str
    category: Optional[CategoryT]
    vertical: Optional[VerticalT]
    noise_type: Optional[NoiseT]
    match_kind: MatchKindT

    @property
    def is_skill(self) -> bool:
        return self.noise_type is None and self.category is not None

    @property
    def is_noise(self) -> bool:
        return self.noise_type is not None


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

# Stripped from the START of a phrase before matching. JDs commonly
# decorate credentials/skills with these qualifiers; they don't change
# the underlying entity. ("current First Aid" → "first aid".)
_QUALIFIER_PREFIXES: Tuple[str, ...] = (
    "current ", "valid ", "accredited ", "latest ", "up-to-date ", "up to date ",
    "active ", "renewed ", "in-date ", "in date ", "ongoing ",
    "strong ", "excellent ", "good ", "demonstrated ",
    "proven ", "extensive ", "solid ", "deep ",
    "advanced ", "intermediate ", "basic ", "fundamental ",
    "working knowledge of ", "knowledge of ", "understanding of ",
    "experience in ", "experience with ", "experience of ",
    "ability to ", "able to ", "skilled in ", "skilled at ",
    "familiarity with ", "familiar with ", "proficient in ", "proficient with ",
)

# Match dashes / slashes / plus / ampersand etc. but KEEP internal hyphens
# inside multi-word skills (person-centred care, end-of-life).
_PUNCT_RE = re.compile(r"[^\w\s\-+#./]")
_WS_RE = re.compile(r"\s+")


_LEADING_YEAR_RE = re.compile(r"^(?:19|20)\d{2}\s+")


def normalise(phrase: str) -> str:
    """Canonicalise a phrase to its lookup key.

    Lowercases, strips qualifier prefixes, collapses punctuation/whitespace.
    Internal hyphens are preserved (so 'person-centred care' stays one token).
    Keeps `+`, `#`, `.`, `/` so "C++", "C#", ".NET", "CI/CD" survive lookup.

    Also normalises Unicode dash-like characters (non-breaking hyphen U+2011,
    figure dash U+2012, en-dash U+2013) to a standard ASCII hyphen so JD text
    that uses smart punctuation matches the plain-ASCII noise/lexicon entries.

    Also strips a leading 4-digit year (1900-2099) so AI hallucinations like
    "2016 influenza vaccination" normalise to "influenza vaccination" and hit
    the existing credential-noise entry. Years anchored elsewhere (e.g. "ISO
    27001", "section 2024") are NOT stripped — only the LEADING prefix.
    """
    if not phrase:
        return ""
    s = phrase.strip().lower()
    # Normalise Unicode dash variants → standard ASCII hyphen before any lookup.
    # U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
    # U+2013 en dash, U+2014 em dash, U+2212 minus sign.
    for ch in "‐‑‒–—−":
        s = s.replace(ch, "-")
    # Strip leading year prefix (e.g. "2016 influenza vaccination" → "influenza
    # vaccination"). Safe — no real skill name starts with a 4-digit year.
    s = _LEADING_YEAR_RE.sub("", s)
    # iterate: strip ALL leading qualifier prefixes (some may compose)
    changed = True
    while changed:
        changed = False
        for q in _QUALIFIER_PREFIXES:
            if s.startswith(q):
                s = s[len(q):]
                changed = True
                break
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


# ---------------------------------------------------------------------------
# Lexicon loading (once at import)
# ---------------------------------------------------------------------------

_LEXICON_DIR = Path(__file__).parent / "lexicons"


def _resolve_vertical_lexicon_path(vertical: VerticalT) -> Path:
    """Return the Path to a vertical's lexicon.json.

    Prefers the co-located copy inside the verticals package (Phase E),
    falls back to the legacy skills/lexicons/<vertical>.json so a missing
    vertical folder never hard-crashes the classifier.
    """
    from app.services.verticals import lexicon_path as _reg_lexicon_path
    reg = _reg_lexicon_path(vertical)
    if reg is not None:
        return reg
    return _LEXICON_DIR / f"{vertical}.json"


def _load_noise() -> Dict[str, NoiseT]:
    """Build {normalised_phrase: noise_type} from _universal_noise.json.

    _universal_noise.json is cross-vertical and stays in skills/lexicons/.
    """
    path = _LEXICON_DIR / "_universal_noise.json"
    data = json.loads(path.read_text())
    out: Dict[str, NoiseT] = {}
    for typ in _NOISE_TYPES:
        for term in data.get(typ, []):
            key = normalise(term)
            if key:
                out[key] = typ  # type: ignore[assignment]
    return out


def _load_vertical(vertical: VerticalT) -> Dict[str, Tuple[str, CategoryT]]:
    """Build {normalised_phrase: (canonical, category)} for one vertical."""
    path = _resolve_vertical_lexicon_path(vertical)
    data = json.loads(path.read_text())
    out: Dict[str, Tuple[str, CategoryT]] = {}
    for cat in _CATEGORIES:
        for entry in data.get(cat, []):
            canon = entry["canonical"]
            # canonical itself is a valid lookup key
            key = normalise(canon)
            if key:
                out[key] = (canon, cat)  # type: ignore[assignment]
            for variant in entry.get("variants", []) or []:
                vkey = normalise(variant)
                if vkey and vkey not in out:
                    out[vkey] = (canon, cat)  # type: ignore[assignment]
    return out


def _load_subsumes(vertical: VerticalT) -> Dict[str, set]:
    """Build {parent_canonical_lower: {child_canonical_lower, ...}} from the
    optional ``subsumes`` field on each lexicon entry.

    A parent that lists ``subsumes: ["a", "b"]`` is saying: when ANY of those
    children appears in the same bucket as the parent, the parent is the
    generic catch-all and should be dropped in favour of the more specific
    children. The deterministic dedup pass in post_process consumes this map.
    """
    path = _resolve_vertical_lexicon_path(vertical)
    data = json.loads(path.read_text())
    out: Dict[str, set] = {}
    for cat in _CATEGORIES:
        for entry in data.get(cat, []):
            children = entry.get("subsumes") or []
            if not children:
                continue
            parent = entry["canonical"].lower()
            out[parent] = {str(c).lower() for c in children if c}
    return out


_NOISE_LOOKUP: Dict[str, NoiseT] = _load_noise()
_VERTICAL_LOOKUPS: Dict[VerticalT, Dict[str, Tuple[str, CategoryT]]] = {
    v: _load_vertical(v) for v in _VERTICALS
}
_SUBSUMES: Dict[VerticalT, Dict[str, set]] = {
    v: _load_subsumes(v) for v in _VERTICALS
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def is_noise(phrase: str) -> Optional[NoiseT]:
    """Return the noise_type if `phrase` resolves to the universal noise
    list, else None. Used to short-circuit anything that should never
    be treated as a skill (credentials, eligibility statements,
    framework/value/availability noise).
    """
    if not phrase:
        return None
    return _NOISE_LOOKUP.get(normalise(phrase))


# Minimum string length for fuzzy matching to apply. Below this, difflib's
# ratio is unreliable (a single-char edit on a short word clears the cutoff),
# so short tokens require an exact/normalised match. See the fuzzy guard below.
_MIN_FUZZY_LEN = 5


def classify(
    phrase: str,
    vertical: VerticalT,
    *,
    fuzzy_cutoff: float = 0.88,
    allow_fuzzy: bool = True,
) -> Optional[Classification]:
    """Resolve `phrase` to a canonical taxonomy entry.

    Order:
      1. Universal noise → Classification with noise_type set.
      2. Vertical lexicon exact (normalised) match.
      3. Vertical lexicon fuzzy match (difflib ratio ≥ fuzzy_cutoff).
      4. None — caller logs as unknown.

    fuzzy_cutoff defaults to 0.88: catches minor typos (`infectoin
    control` → `infection control`) without bleeding semantically
    distinct phrases into one bucket.
    """
    if not phrase or not phrase.strip():
        return None

    # 1. Universal noise first — never a skill regardless of vertical.
    norm = normalise(phrase)
    if not norm:
        return None
    nt = _NOISE_LOOKUP.get(norm)
    if nt is not None:
        return Classification(
            canonical=phrase.strip(),
            category=None,
            vertical=None,
            noise_type=nt,
            match_kind="exact",
        )

    lookup = _VERTICAL_LOOKUPS.get(vertical)
    if lookup is None:
        return None

    # 2. Exact / normalised match.
    hit = lookup.get(norm)
    if hit is not None:
        canon, cat = hit
        match_kind: MatchKindT = "exact" if norm == phrase.strip().lower() else "normalised"
        return Classification(
            canonical=canon,
            category=cat,
            vertical=vertical,
            noise_type=None,
            match_kind=match_kind,
        )

    # 3. Fuzzy fallback.
    #
    # Length guard: difflib's ratio over-scores short strings — a single-char
    # insertion turns a common word into a product name ("care" → "vcare" scores
    # 0.889, over the 0.88 cutoff), which would wrongly snap every "care" in a JD
    # to the VCare software canonical. Require both the input and the matched key
    # to be at least _MIN_FUZZY_LEN characters so short tokens fall through to
    # "unknown" instead of fuzzy-matching. Real typos (e.g. "wound managment")
    # are comfortably longer than this floor.
    if allow_fuzzy and len(norm) >= _MIN_FUZZY_LEN:
        matches = difflib.get_close_matches(norm, lookup.keys(), n=1, cutoff=fuzzy_cutoff)
        if matches and len(matches[0]) >= _MIN_FUZZY_LEN:
            canon, cat = lookup[matches[0]]
            return Classification(
                canonical=canon,
                category=cat,
                vertical=vertical,
                noise_type=None,
                match_kind="fuzzy",
            )

    # 4. Unknown.
    return None


def classify_many(
    phrases: List[str],
    vertical: VerticalT,
    *,
    fuzzy_cutoff: float = 0.88,
) -> Dict[str, Optional[Classification]]:
    """Batch helper. Returns {phrase: Classification | None}, preserving
    the input phrase strings as keys."""
    return {
        p: classify(p, vertical, fuzzy_cutoff=fuzzy_cutoff)
        for p in phrases
    }


def variants_for_canonical(canonical: str, vertical: VerticalT) -> set:
    """Return all normalised lookup keys (the canonical plus every variant)
    that resolve to ``canonical`` in the given vertical lexicon.

    Used by the soft-skill grounding gate to test whether any surface form of
    a canonical appears verbatim in the JD text. Returns ``{normalise(canonical)}``
    for canonicals that aren't in the lexicon (e.g. LLM-only soft skills), so
    the caller can still test the bare phrase.
    """
    lookup = _VERTICAL_LOOKUPS.get(vertical) or {}
    target = canonical.strip().lower()
    keys = {k for k, (c, _cat) in lookup.items() if c.strip().lower() == target}
    cn = normalise(canonical)
    if cn:
        keys.add(cn)
    return keys


def lexicon_stats() -> Dict[str, int]:
    """Diagnostic — counts of loaded lookup keys per source. Useful
    for confirming the bundled JSON was loaded successfully."""
    return {
        "noise_keys": len(_NOISE_LOOKUP),
        **{f"{v}_keys": len(_VERTICAL_LOOKUPS[v]) for v in _VERTICALS},
    }
