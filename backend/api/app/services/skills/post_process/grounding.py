"""Groundedness gate — verify each LLM-extracted skill against JD evidence.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.skills.classifier import (
    classify,
    variants_for_canonical,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
# role_family.id → lexicon vertical.  Single source of truth lives in the
# verticals registry; imported here to eliminate the drift risk.
from app.services.verticals import FAMILY_TO_LEXICON as _ROLE_FAMILY_TO_VERTICAL
from ._common import logger

# ---------------------------------------------------------------------------
# Groundedness gate — verify each LLM-extracted skill against JD evidence
# ---------------------------------------------------------------------------
#
# The JD-analysis prompt asks the LLM to return each skill alongside a
# verbatim JD quote that supports it. The runner stores those quotes in
# ``jd_analysis["skill_evidence"]``: lowercased skill → evidence string.
#
# This gate enforces two contracts:
#
#   1. The evidence MUST appear (literally, after normalisation) in the JD
#      body. If not, the LLM fabricated the quote — almost always means it
#      also fabricated the skill ("person-centred care" cited as evidence
#      "AIN" is the classic shape).
#
#   2. The skill MUST be derivable from the evidence. Either by direct
#      token overlap ("verbal communication" ← "verbal and written
#      communication") OR by a known lexicon synonym mapping
#      ("compassion" ← "compassionate", looked up in the vertical lexicon).
#
# Dropped skills are recorded under ``lexicon_meta.ungrounded`` for audit
# rather than silently discarded — so a real recall regression is
# diagnosable from one log line.

_GROUND_FUZZY_TOKEN_HEAD: int = 5


# Soft-skill grounding guard — when a soft-skill candidate's only support in
# the evidence is an adjective qualifying an INANIMATE NOUN, reject. Classic
# case: JD says "reliable vehicle" (about the car) and the LLM emits
# "reliability" as a candidate soft skill. The candidate's reliability as a
# person is unsupported; the noun phrase is about the equipment.
#
# Map: skill_canonical → (adjective root, inanimate-noun set).
# Conservative — only the recurring real-world misextractions.
_SOFT_SKILL_INANIMATE_GUARD: Dict[str, Tuple[str, frozenset]] = {
    "reliability": ("reliab", frozenset({
        "vehicle", "car", "transport", "transportation", "insurance",
        "equipment", "internet", "broadband", "connection", "wifi",
        "service", "supply", "supplies",
    })),
    "flexibility": ("flexib", frozenset({
        "hours", "schedule", "scheduling", "roster", "rostering", "shifts",
        "arrangement", "arrangements", "availability", "working hours",
    })),
}


def _evidence_only_modifies_inanimate(skill: str, evidence_norm: str) -> bool:
    """True when the only support for ``skill`` in ``evidence_norm`` is an
    adjective qualifying an inanimate noun (e.g. "reliable vehicle"). Caller
    treats True as "not actually grounded as a soft skill". Returns False
    when the skill isn't in the guard map, or when the evidence ALSO mentions
    a person-anchored use of the same adjective family."""
    guard = _SOFT_SKILL_INANIMATE_GUARD.get(skill.strip().lower())
    if not guard:
        return False
    root, inanimate_nouns = guard
    # Find all "{root}* {noun}" pairs in the evidence.
    pattern = re.compile(rf"\b{root}[a-z]*\b\s+(\w+)")
    matches = pattern.findall(evidence_norm)
    if not matches:
        return False
    # If EVERY occurrence is followed by an inanimate noun, the evidence
    # doesn't ground the soft skill. If ANY occurrence is followed by a
    # person/role noun (or no noun match at all from a bare adjective use),
    # we keep the skill — too risky to reject.
    return all(noun in inanimate_nouns for noun in matches)


def _normalise_for_match(text: str) -> str:
    """Lowercase, collapse whitespace, normalise unicode dashes + quotes."""
    if not text:
        return ""
    t = text.lower()
    for ch in "‐‑‒–—−":
        t = t.replace(ch, "-")
    for ch in "‘’":
        t = t.replace(ch, "'")
    for ch in "“”":
        t = t.replace(ch, '"')
    return re.sub(r"\s+", " ", t).strip()


def _evidence_in_jd(evidence_norm: str, jd_norm: str) -> bool:
    """True if ``evidence_norm`` is (a) a substring of jd_norm, or (b) its
    first ``_GROUND_FUZZY_TOKEN_HEAD`` tokens appear in jd_norm. The fuzzy
    fallback tolerates trailing punctuation drift without letting the LLM
    smuggle in invented suffixes."""
    if not evidence_norm or not jd_norm:
        return False
    if evidence_norm in jd_norm:
        return True
    tokens = evidence_norm.split()
    if len(tokens) < 3:
        return False
    head = " ".join(tokens[:_GROUND_FUZZY_TOKEN_HEAD])
    return head in jd_norm


def _skill_derivable_from_evidence(
    skill: str, evidence_norm: str, vertical: Optional[str],
    *,
    is_soft_skill: bool = False,
) -> bool:
    """True if the skill is supported by the evidence.

    Two acceptance paths:
      a) direct token overlap — any content token of the skill (>3 chars)
         appears in evidence_norm. Catches "verbal communication" ←
         "verbal and written communication".
      b) lexicon synonym mapping — when ``vertical`` is set, the evidence
         text contains a phrase that the per-vertical classifier maps to
         the same canonical as the skill. Catches "empathy" ← evidence
         containing "compassionate" (lexicon synonym).
    """
    skill_norm = skill.strip().lower()
    if not skill_norm:
        return False

    # Inanimate-anchor guard — if the evidence's ONLY support for this
    # soft-skill candidate is an adjective qualifying equipment (vehicle,
    # internet, etc.), reject before any other path can accept it.
    if _evidence_only_modifies_inanimate(skill_norm, evidence_norm):
        return False

    # (a) direct token overlap, OR 4-char prefix match for compound tokens.
    # The prefix path catches single-word compounds where the JD uses one
    # half: "teamwork" ← evidence "works well as part of a team"
    # ("team" is a 4-char prefix of "teamwork" with a word boundary in
    # evidence). Width-4 is a deliberate floor: anything shorter (e.g. 3-char
    # prefix "tea") would over-accept.
    # NOTE: Finding M8 (E3 in fix-plan) identified over-broad single-token
    # matches for multi-word skills. A tighter fix requires multi-token
    # coverage logic and is deferred pending concrete false-positive cases.
    #
    # Direct overlap is WORD-BOUNDARY, not bare substring (chunk C19c, same
    # bug class as finding #24, opposite direction of harm): a bare
    # `tok in evidence_norm` check let a 4-char token like "care" match
    # inside an unrelated word ("career"), so a fabricated "personal care"
    # skill was wrongly ACCEPTED as grounded by evidence that only mentioned
    # career development — letting a fabrication survive the honesty gate.
    # Tokens >4 chars still fall through to the prefix path below
    # (deliberately looser, left-boundary-only) if the exact word isn't
    # present, so this doesn't narrow the documented "teamwork"/"team" case.
    skill_tokens = [t for t in re.findall(r"[a-z][a-z\-]*", skill_norm) if len(t) > 3]
    if not skill_tokens:
        # very short skill (e.g. "sql") — fall back to ANY token
        skill_tokens = re.findall(r"[a-z][a-z\-]*", skill_norm)
    for tok in skill_tokens:
        if not tok:
            continue
        if re.search(r"\b" + re.escape(tok) + r"\b", evidence_norm):
            return True
        if len(tok) > 4 and re.search(r"\b" + re.escape(tok[:4]), evidence_norm):
            return True

    # (b) lexicon synonym mapping (vertical-aware) — DISABLED for soft skills.
    # The lexicon crosses word families on soft-skill canonicals (e.g.
    # "compassionate" → canonical "empathy", "flexible" → "adaptability"),
    # which contradicts the JD-analysis prompt's verbatim rule. For soft
    # skills we accept only direct token / 4-char-prefix overlap (path (a)).
    if is_soft_skill:
        return False
    if vertical:
        try:
            skill_class = classify(skill_norm, vertical)
        except Exception:  # noqa: BLE001 — classifier failure must not abort
            skill_class = None
        skill_canonical = (
            skill_class.canonical.lower() if (skill_class and skill_class.is_skill)
            else skill_norm
        )
        # Walk unigrams and bigrams of evidence; try to classify each.
        ev_tokens = re.findall(r"[a-z][a-z\-]+", evidence_norm)
        candidates: List[str] = list(ev_tokens)
        candidates.extend(
            f"{a} {b}" for a, b in zip(ev_tokens, ev_tokens[1:])
        )
        for phrase in candidates:
            try:
                c = classify(phrase, vertical)
            except Exception:  # noqa: BLE001
                continue
            if c and c.is_skill and c.canonical.lower() == skill_canonical:
                return True

    return False


def verify_skill_evidence(
    jd_analysis: Dict[str, Any],
    jd_text: str,
    *,
    role_family_id: str,
    require_evidence: bool = False,
) -> Dict[str, Any]:
    """Drop skills whose evidence quote is not in the JD body or whose
    skill cannot be derived from the quote.

    When ``require_evidence=False`` (default): no-op if
    ``jd_analysis["skill_evidence"]`` is missing or empty — back-compat
    with AI runs that didn't emit evidence.

    When ``require_evidence=True``: treats missing evidence as
    "ungrounded" and drops all skills not covered by the evidence map.
    Use this once the prompt has been updated to always emit evidence.

    Mutates a shallow copy. Drops are recorded under
    ``lexicon_meta.ungrounded`` as a list of
    ``{"skill", "bucket", "evidence", "reason"}`` dicts.
    """
    evidence_map = jd_analysis.get("skill_evidence") or {}
    if not isinstance(evidence_map, dict):
        evidence_map = {}
    if not evidence_map and not require_evidence:
        return jd_analysis

    jd_norm = _normalise_for_match(jd_text)
    if not jd_norm:
        return jd_analysis

    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    out = dict(jd_analysis)
    ungrounded: List[Dict[str, str]] = []

    for block_key in ("required_skills", "preferred_skills"):
        block = dict(out.get(block_key) or {})
        for cat in _CATEGORIES:
            kept: List[str] = []
            for skill in (block.get(cat) or []):
                if not isinstance(skill, str):
                    continue
                evidence = evidence_map.get(skill.strip().lower(), "")
                evidence_norm = _normalise_for_match(evidence)

                if not evidence_norm:
                    ungrounded.append({
                        "skill": skill, "bucket": f"{block_key}.{cat}",
                        "evidence": evidence, "reason": "no_evidence",
                    })
                    continue
                if not _evidence_in_jd(evidence_norm, jd_norm):
                    ungrounded.append({
                        "skill": skill, "bucket": f"{block_key}.{cat}",
                        "evidence": evidence, "reason": "evidence_not_in_jd",
                    })
                    continue
                if not _skill_derivable_from_evidence(
                    skill, evidence_norm, vertical,
                    is_soft_skill=(cat == "soft_skills"),
                ):
                    ungrounded.append({
                        "skill": skill, "bucket": f"{block_key}.{cat}",
                        "evidence": evidence, "reason": "skill_not_derivable",
                    })
                    continue
                kept.append(skill)
            block[cat] = kept
        out[block_key] = block

    if ungrounded:
        logger.info(
            "groundedness gate (family=%s): dropped %d ungrounded skill(s) — %s",
            role_family_id, len(ungrounded),
            [(u["skill"], u["reason"]) for u in ungrounded],
        )
        meta = dict(out.get("lexicon_meta") or {})
        meta["ungrounded"] = ungrounded
        out["lexicon_meta"] = meta

    return out


_GROUND_TOKEN_RE = re.compile(r"[^a-z0-9\- ]+")


def _ground_norm(s: str) -> str:
    """Lowercase, convert unicode dashes, drop all punctuation except internal
    hyphens, collapse whitespace. Applied IDENTICALLY to the JD blob and to each
    lexicon variant key so word-boundary substring tests are consistent."""
    s = (s or "").lower()
    for ch in "‐‑‒–—−":
        s = s.replace(ch, "-")
    s = _GROUND_TOKEN_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _ground_blob(jd_text: str) -> str:
    """Space-padded normalised JD blob for word-boundary substring tests."""
    return f" {_ground_norm(jd_text)} "


# Single-word lexicon variants too generic to ground a soft-skill *requirement*
# on their own. "leading"/"lead" appear constantly in company boilerplate
# ("leading aged care provider") and would otherwise ground the canonical
# "leadership" as a phantom requirement. Multi-word variants ("team leadership",
# "providing leadership") still ground normally.
_WEAK_GROUNDING_TOKENS: frozenset = frozenset({"lead", "leading"})


def drop_ungrounded_soft_skills(
    jd_analysis: Dict[str, Any],
    jd_text: str,
    *,
    role_family_id: str,
    skill_text: Optional[str] = None,
) -> Dict[str, Any]:
    """Drop LLM-emitted soft skills with no verbatim support in the JD.

    A soft skill is GROUNDED when its canonical — or any of its lexicon
    variants — appears verbatim (word-boundary) in the JD text. Ungrounded
    soft skills are LLM inferences from employer-preference / scheduling prose
    (e.g. "reliability", "flexibility" with no matching word in the JD) and are
    removed. Mirrors the recall floor's verbatim rule, applied as a filter.

    Runs BEFORE the recall floor, which re-adds any genuinely grounded soft
    skill, so this can only remove fabrications. Drops are recorded under
    ``lexicon_meta.ungrounded`` with reason ``soft_skill_not_in_jd``.

    No-op for the ``master`` family (no vertical lexicon to ground against).
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    if vertical is None:
        return jd_analysis

    # Ground against the boilerplate-STRIPPED text when the caller supplies it
    # (jd_text_for_llm). A soft skill whose only support was a perks/benefits
    # line ("leadership" in "Senior Leadership Pathways") is then correctly
    # ungrounded and dropped, while genuine duty-bullet soft skills survive.
    # Falls back to raw jd_text for back-compat with callers that pass neither.
    ground_text = skill_text if (skill_text and skill_text.strip()) else jd_text
    blob = _ground_blob(ground_text)
    if not blob.strip():
        return jd_analysis

    out = dict(jd_analysis)
    dropped: List[Dict[str, str]] = []

    for block_key in ("required_skills", "preferred_skills"):
        block = dict(out.get(block_key) or {})
        kept: List[str] = []
        for skill in (block.get("soft_skills") or []):
            if not isinstance(skill, str) or not skill.strip():
                continue
            keys = variants_for_canonical(skill, vertical)
            grounded = any(
                nk and nk not in _WEAK_GROUNDING_TOKENS and f" {nk} " in blob
                for nk in (_ground_norm(k) for k in keys)
            )
            if grounded:
                kept.append(skill)
            else:
                dropped.append({
                    "skill": skill,
                    "bucket": f"{block_key}.soft_skills",
                    "evidence": "",
                    "reason": "soft_skill_not_in_jd",
                })
        block["soft_skills"] = kept
        out[block_key] = block

    if dropped:
        logger.info(
            "soft-skill grounding gate (family=%s): dropped %d ungrounded — %s",
            role_family_id, len(dropped), [d["skill"] for d in dropped],
        )
        meta = dict(out.get("lexicon_meta") or {})
        meta["ungrounded"] = list(meta.get("ungrounded") or []) + dropped
        out["lexicon_meta"] = meta

    return out
