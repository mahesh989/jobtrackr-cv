"""Nursing-specific pipeline hooks — fully self-contained.

These callables implement nursing-only logic that would otherwise
pollute shared modules.  The registry wires them in via VerticalPack.hooks
so shared code can call ``pack.hooks.nursing_subtype(jd_analysis)`` without
an ``if rf.id == "nursing"`` guard in multiple places.

Imports only from verticals.base (and stdlib) — zero project imports — so
the registry can safely wire this module without any circular-import risk.
"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, Dict, List

from app.services.verticals.base import RoleFamilyProfile

# Australian nursing / care taxonomy.  Unregulated assistant/care roles lead
# with hands-on "Care Skills"; registered/licensed clinicians lead with
# "Clinical Skills".  Anything we can't confidently classify falls back to a
# neutral "Core Skills".  Signals are matched on word boundaries (so "ain"
# matches the acronym AIN, not "again").  AIN and Care Worker are the same
# family.
_NURSING_CARE_SIGNALS = (
    "assistant in nursing", "ain", "personal care worker", "personal care assistant",
    "personal care", "care worker", "care assistant", "aged care worker",
    "home care", "community care", "individual support", "disability support",
    "support worker", "carer", "nursing assistant", "patient care assistant",
    "care companion", "aged care",
)
_NURSING_CLINICAL_SIGNALS = (
    "registered nurse", "enrolled nurse", "clinical nurse", "nurse practitioner",
    "midwife", "mental health nurse", "intensive care", "icu", "theatre nurse",
    "emergency nurse", "perioperative", "graduate nurse", "division 1",
    "division 2", "rn", "en", "cns", "cnc",
)
_NURSING_SUBTYPE_LABEL = {"care": "Care Skills", "clinical": "Clinical Skills"}


def nursing_subtype(jd_analysis: Dict[str, Any] | None) -> str:
    """
    Classify a nursing JD as 'care' (unregulated assistant/care roles),
    'clinical' (registered/licensed clinicians), or 'unknown'. The job title
    is the strongest signal and decides outright when it carries one; otherwise
    we count signal hits across the summary + responsibilities prose.
    """
    def _hit(text: str, signals: tuple) -> int:
        return sum(
            1 for s in signals
            if re.search(r"\b" + re.escape(s) + r"\b", text)
        )

    # Registration is the defining identity: a "Registered/Enrolled Nurse"
    # title is clinical even when it also names a care SETTING ("aged care"),
    # so the clinical check runs before the care check on the title.
    title = str((jd_analysis or {}).get("job_title") or "").lower()
    if _hit(title, _NURSING_CLINICAL_SIGNALS):
        return "clinical"
    if _hit(title, _NURSING_CARE_SIGNALS):
        return "care"

    parts: List[str] = [str((jd_analysis or {}).get("summary") or "")]
    resp = (jd_analysis or {}).get("responsibilities") or []
    if isinstance(resp, list):
        parts.extend(str(x) for x in resp)
    else:
        parts.append(str(resp))
    blob = " ".join(parts).lower()
    care, clinical = _hit(blob, _NURSING_CARE_SIGNALS), _hit(blob, _NURSING_CLINICAL_SIGNALS)
    if care > clinical:
        return "care"
    if clinical > care:
        return "clinical"
    return "unknown"


def apply_nursing_subtype(
    rf: RoleFamilyProfile,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    For the nursing family, overwrite the headline skills label
    (skills_categories[0]) with the sub-type-appropriate one — "Care Skills"
    for care roles, "Clinical Skills" for clinicians, "Core Skills" when
    unclassified — keeping id="nursing" so the W8 canonical sandwich
    (_TO_CANONICAL["nursing"]) still applies.  No-op for every other family.
    """
    if rf.id != "nursing":
        return rf
    subtype = nursing_subtype(jd_analysis)
    headline = _NURSING_SUBTYPE_LABEL.get(subtype, "Core Skills")
    cats = list(rf.skills_categories)
    cats[0] = headline
    return replace(
        rf,
        skills_categories=cats,
        metadata={**rf.metadata, "nursing_subtype": subtype},
    )
