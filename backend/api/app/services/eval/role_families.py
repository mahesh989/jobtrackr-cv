"""
Role-family config + router for the composition writer (W3).

A RoleFamilyProfile is the single source of truth for how a CV should be shaped
for a family of roles. It is consumed by the prompt assembler (composition.py)
AND by the deterministic enforcement (enforce.py), so prompt and validators
never drift.

Four families to start (the ones you prioritised): tech, nursing, manual,
master (the general fallback + base the others extend conceptually).

The router picks a family from an explicit vertical hint (the beta screen's
dropdown) first, then falls back to keyword-matching the JD analysis, then to
master.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

# RoleFamilyProfile now lives in verticals/base.py to avoid circular imports.
# Re-export it so all existing callers (`from role_families import RoleFamilyProfile`)
# keep working without change.
from app.services.verticals.base import RoleFamilyProfile as RoleFamilyProfile  # noqa: F401

# Per-vertical configs now live in services/verticals/<id>/config.py.
# ROLE_FAMILIES is built by the registry and re-exported here as a backward-compat shim.
from app.services.verticals import ROLE_FAMILIES as ROLE_FAMILIES  # noqa: F401 re-export
from app.services.verticals.tech.config    import PROFILE as _TECH
from app.services.verticals.nursing.config import PROFILE as _NURSING
from app.services.verticals.manual.config  import PROFILE as _MANUAL
from app.services.verticals.general.config import PROFILE as _MASTER


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

# Nursing subtype detection now lives in verticals/nursing/hooks.py.
# Re-export as private names so existing callers in this module keep working.
from app.services.verticals.nursing.hooks import (  # noqa: F401
    nursing_subtype as _nursing_subtype,
    apply_nursing_subtype as _apply_nursing_subtype,
)


def resolve_role_family(
    vertical_hint: str | None,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    Pick a role family, then apply the nursing sub-type overlay so the headline
    skills label matches the specific role (Care / Clinical / Core).
    """
    return _apply_nursing_subtype(
        _resolve_base_family(vertical_hint, jd_analysis), jd_analysis,
    )


def _resolve_base_family(
    vertical_hint: str | None,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    Pick a role family. Priority:
      1. Explicit vertical hint that maps to a SPECIFIC family (dropdown:
         it→tech, nursing→nursing, cleaner/admin→manual). Authoritative — the
         explicit dropdown exists to avoid alias-based misclassification.
      2. Keyword match of the JD job_title + required skills against aliases.
      3. master (general fallback).

    Generic / catch-all hints ("general", "other", "master", or empty) are
    NOT a real vertical and must NOT short-circuit to master: they fall
    through to JD-based detection (step 2) so a clearly-nursing aged-care JD
    filed under a "general" profile still gets the nursing pack. (Regression
    origin: explicit-vertical routing originally mapped "general"→"master",
    which suppressed JD detection and produced a generic CV that dropped the
    candidate's real experience.)
    """
    hint = (vertical_hint or "").strip().lower()
    _GENERIC_HINTS = {"", "master", "other", "general"}
    hint_map = {
        "it": "tech", "tech": "tech", "data": "tech",
        "nursing": "nursing", "health": "nursing", "healthcare": "nursing",
        "cleaner": "manual", "manual": "manual", "admin": "manual",
    }
    if hint in hint_map:
        return ROLE_FAMILIES[hint_map[hint]]
    if hint not in _GENERIC_HINTS and hint in ROLE_FAMILIES:
        return ROLE_FAMILIES[hint]

    # Keyword match against the JD. We search the structured skill arrays AND
    # the free-text fields (job_title / summary / responsibilities) because the
    # JD analyser often returns a title like "Assistant in Nursing" whose alias
    # ("ain", "aged care") never appears verbatim in the skill arrays — the
    # signal lives in the summary/responsibilities prose instead.
    haystack_parts: List[str] = []
    if jd_analysis:
        haystack_parts.append(str(jd_analysis.get("job_title") or ""))
        haystack_parts.append(str(jd_analysis.get("summary") or ""))
        resp = jd_analysis.get("responsibilities") or []
        if isinstance(resp, list):
            haystack_parts.extend(str(x) for x in resp)
        else:
            haystack_parts.append(str(resp))
        for block in ("required_skills", "preferred_skills"):
            skills = jd_analysis.get(block) or {}
            if isinstance(skills, dict):
                for cat in ("technical", "soft_skills", "domain_knowledge"):
                    haystack_parts.extend(str(x) for x in (skills.get(cat) or []))
    haystack = " ".join(haystack_parts).lower()

    if haystack.strip():
        for fam in (_NURSING, _MANUAL, _TECH):  # specific before broad
            for alias in fam.aliases:
                if re.search(r"\b" + re.escape(alias.strip()), haystack):
                    return fam

    return _MASTER


_CATEGORY_KEYS = ("technical", "soft_skills", "domain_knowledge")


# Role-family id → curated lexicon vertical.  Single source of truth now
# lives in the verticals registry; all four former local copies point here.
from app.services.verticals import FAMILY_TO_LEXICON as _FAMILY_TO_VERTICAL


def resolve_vertical(
    vertical_hint: str | None,
    jd_analysis: Dict[str, Any] | None,
) -> str | None:
    """Resolve the curated lexicon vertical (``nursing`` / ``tech`` /
    ``cleaning``) for a JD, or ``None`` when the role maps to ``master``
    (no curated lexicon).

    Thin wrapper over :func:`resolve_role_family` that maps the resolved
    family id to its lexicon vertical. Used by the orchestrator to pick the
    JD-analysis prompt's vertical hints BEFORE the LLM call — passing a
    minimal ``{"summary": jd_text}`` is enough for the alias scan. The
    authoritative role family is still resolved from the LLM output after
    the call, so a wrong guess here only affects prompt hints, never the
    final classification.
    """
    rf = resolve_role_family(vertical_hint, jd_analysis)
    return _FAMILY_TO_VERTICAL.get(rf.id)


def category_labels(rf: RoleFamilyProfile) -> Dict[str, str]:
    """
    Map the internal skill-category keys to the family's display labels. The
    internal keys (technical / soft_skills / domain_knowledge) stay stable
    everywhere; only the user-facing label changes per family.

    The three labels in skills_categories are, by convention:
        [0] HEADLINE competencies, [1] soft skills, [2] secondary / catch-all.

    The CV/JD categoriser files software/tools/platforms under "technical" and
    industry/process/clinical knowledge under "domain_knowledge". Which of those
    two buckets is the family's HEADLINE differs by role: tech roles lead with
    "technical" (Python, SQL → Technical Skills); nursing/manual roles lead with
    "domain_knowledge" (medication administration, dementia care → Clinical
    Skills), and "technical" (e.g. BESTMed/MedMobile) becomes the secondary
    "Other Skills" bucket. rf.headline_bucket selects which.
    """
    cats = list(rf.skills_categories) + ["Technical Skills", "Soft Skills", "Other Skills"]
    headline = rf.headline_bucket if rf.headline_bucket in ("technical", "domain_knowledge") else "technical"
    secondary = "domain_knowledge" if headline == "technical" else "technical"
    # The domain_knowledge bucket keeps an explicit "Domain Knowledge" label
    # whenever it is NOT the headline (i.e. tech/master) so it stays a distinct,
    # visible category instead of collapsing into a generic "Other Skills". When
    # the secondary is the technical bucket (nursing/manual: tools/systems like
    # BESTMed), it takes the family's catch-all label (skills_categories[2]).
    secondary_label = "Domain Knowledge" if secondary == "domain_knowledge" else cats[2]
    return {
        headline:      cats[0],
        "soft_skills": cats[1],
        secondary:     secondary_label,
    }


def category_order(rf: RoleFamilyProfile) -> List[str]:
    """
    Display order of the internal skill buckets for this family:
    headline first, then soft skills, then the secondary bucket. So tech shows
    Technical → Soft → Domain Knowledge; nursing shows Clinical → Soft → Other.
    """
    headline = rf.headline_bucket if rf.headline_bucket in ("technical", "domain_knowledge") else "technical"
    secondary = "domain_knowledge" if headline == "technical" else "technical"
    return [headline, "soft_skills", secondary]


def resolve_seniority(jd_analysis: Dict[str, Any] | None) -> str:
    """Map the JD seniority to a coarse overlay bucket: grad | mid | senior."""
    level = str((jd_analysis or {}).get("seniority_level") or "unknown").lower()
    if level in ("entry", "junior", "graduate"):
        return "grad"
    if level in ("senior", "lead", "principal", "staff", "manager", "director"):
        return "senior"
    return "mid"


def apply_equivalences(
    feasibility: Dict[str, Any] | None,
    cv_text: str,
    jd_text: str,
    rf: RoleFamilyProfile,
) -> Dict[str, Any]:
    """
    W8.3 — deterministically promote JD terms to inject_directly when the role
    family's verified equivalence table says the CV honestly justifies them.

    A term is surfaced only when ALL hold:
      • the family allows injection (policy != "none"),
      • the JD actually wants the term (it appears in the JD text),
      • the CV literally contains one of the justifying terms,
      • the term isn't already in the inject list.

    The promoted entry uses the skills-section injection shape so the existing
    deterministic injector (_inject_missing_skills) lands it. Replaces the
    over-permissive AI feasibility guessing with verified, config-driven
    surfacing (no per-case tokens). Returns the (mutated) feasibility dict.
    """
    if feasibility is None:
        return feasibility
    if rf.injection_policy == "none" or not rf.equivalences:
        return feasibility

    cv_l = (cv_text or "").lower()
    jd_l = (jd_text or "").lower()
    plan = feasibility.setdefault("feasibility_plan", {})
    inject = plan.setdefault("inject_directly", [])
    if not isinstance(inject, list):
        return feasibility

    existing = {
        str(e.get("keyword", "")).lower()
        for e in inject if isinstance(e, dict)
    }
    added: List[str] = []
    for jd_term, cv_terms, category in rf.equivalences:
        key = jd_term.lower()
        if key in existing:
            continue
        if key not in jd_l:
            continue  # the JD doesn't ask for it → no ATS value in surfacing
        if not any(
            re.search(r"\b" + re.escape(t.lower()) + r"\b", cv_l) for t in cv_terms
        ):
            continue  # the CV doesn't honestly justify it
        inject.append({
            "keyword": jd_term,
            "category": category,
            "injection_target": "skills_section",
            "source": "equivalence",
        })
        existing.add(key)
        added.append(jd_term)

    if added:
        feasibility.setdefault("_equivalences_added", []).extend(added)
    return feasibility


# ---------------------------------------------------------------------------
# Match-time equivalences + qualification hierarchy
# ---------------------------------------------------------------------------

_MATCH_BUCKETS = ("required", "preferred")
_MATCH_CATS = ("technical", "soft_skills", "domain_knowledge")

# Aged-care / personal-care qualification streams treated as interchangeable for
# AIN / personal-care / aged-care roles. A higher AQF certificate level in the
# same family subsumes a lower or alternative one (Cert IV ⊇ Cert III), so the
# matcher must not flag an either/or or lower-level cert as missing when the CV
# already holds an equivalent or higher qualification.
_AGED_CARE_QUAL_TERMS = (
    "aged care", "ageing support", "ageing", "aged-care",
    "individual support", "personal care", "community care",
    "home care", "home and community care", "disability",
)
_ROMAN_LEVEL = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5}
_CERT_RE = re.compile(r"certificate\s+([ivx]+)\b(?:\s+(?:in|of)\s+([a-z ,&/+-]+))?")


def _aged_care_cert_level(text: str) -> int:
    """Highest aged-care-family certificate level present in `text` (0 if none).
    'Certificate IV in Ageing Support' → 4."""
    best = 0
    for m in _CERT_RE.finditer(text.lower()):
        lvl = _ROMAN_LEVEL.get(m.group(1))
        stream = m.group(2) or ""
        if lvl and any(t in stream for t in _AGED_CARE_QUAL_TERMS):
            best = max(best, lvl)
    return best


def _required_aged_care_cert_level(keyword: str) -> int | None:
    """AQF level of an aged-care-family certificate requirement, else None.
    'certificate iii in individual support' → 3."""
    m = _CERT_RE.search(keyword.lower())
    if not m:
        return None
    lvl = _ROMAN_LEVEL.get(m.group(1))
    stream = m.group(2) or ""
    if lvl and any(t in stream for t in _AGED_CARE_QUAL_TERMS):
        return lvl
    return None


def promote_matched_equivalents(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
    cv_text: str,
    rf: RoleFamilyProfile,
) -> List[str]:
    """
    Move JD keywords from `missed` to `matched` when the CV honestly satisfies
    them under the role family's rules — never invents a match. Two sources:

      1. rf.equivalences synonyms — the JD term and a CV term mean the same
         thing (JD 'Aged Care' ⇄ CV 'ageing support').
      2. Aged-care certificate hierarchy (nursing only) — a higher or
         alternative AQF certificate in the CV subsumes a lower/alternative one
         the JD lists (Cert IV in Ageing Support ⊇ Cert III in Individual
         Support). This is the "either/or + qualification level" rule for
         AIN / personal-care roles.

    Mutates matched/missed in place; returns the promoted keywords (lowercased).
    """
    cv_l = (cv_text or "").lower()
    promoted: List[str] = []

    def _move(bucket: str, cat: str, kw: str) -> None:
        if kw not in missed[bucket][cat]:
            return
        missed[bucket][cat] = [k for k in missed[bucket][cat] if k != kw]
        if kw not in matched[bucket][cat]:
            matched[bucket][cat].append(kw)
        promoted.append(kw)

    # 1. Verified synonyms from the family's equivalence table.
    for jd_term, cv_terms, category in rf.equivalences:
        if category not in _MATCH_CATS:
            continue
        if not any(
            re.search(r"\b" + re.escape(t.lower()) + r"\b", cv_l) for t in cv_terms
        ):
            continue
        key = jd_term.lower()
        for bucket in _MATCH_BUCKETS:
            _move(bucket, category, key)

    # 2. Aged-care certificate hierarchy (AIN / personal-care).
    if rf.id == "nursing":
        cv_level = _aged_care_cert_level(cv_l)
        if cv_level:
            for bucket in _MATCH_BUCKETS:
                for cat in _MATCH_CATS:
                    for kw in list(missed[bucket][cat]):
                        req_level = _required_aged_care_cert_level(kw)
                        if req_level is not None and req_level <= cv_level:
                            _move(bucket, cat, kw)

    return promoted
