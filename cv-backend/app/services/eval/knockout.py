"""
W8.2 — knockout pass (Stage 3 of the target architecture).

Real ATS knockouts are the hard, binary filters recruiters actually screen on:
mandatory licence/registration, minimum years, citizenship/work-rights. A CV
edit cannot fix a missing licence — so detecting these is an HONESTY feature
(tell the user plainly "this role needs X you don't have") and, in production, a
cost saver (short-circuit before the expensive tailoring calls).

Fully deterministic — regex over the raw JD + CV plus the JD analysis's
experience_years_required. No AI call, no per-case tokens. The curated credential
list is per-domain config (anti-overfit), not per-CV. In the eval harness it is
informational (surfaced in WriterResult.extras); production may later use it to
short-circuit.
"""
from __future__ import annotations

import datetime
import re
from typing import Any, Dict, List

# Credential / licence patterns that are common HARD requirements across the
# target verticals. (label, compiled_pattern, always_hard) — always_hard=True
# means the credential is inherently mandatory when the JD mentions it at all
# (e.g. you cannot do the job unregistered); otherwise we require a
# "must/required/essential/mandatory" context near the mention.
_CREDENTIALS: List[tuple[str, "re.Pattern[str]", bool]] = [
    ("AHPRA registration",        re.compile(r"\bahpra\b|registered nurse|enrolled nurse\b"), True),
    ("Police check",              re.compile(r"police check|national police (?:check|clearance)|criminal (?:history|record) check"), True),
    ("NDIS worker screening",     re.compile(r"ndis worker (?:screening|check)"), True),
    ("Working with Children Check", re.compile(r"working with children|\bwwcc\b|blue card"), True),
    ("First aid / CPR",           re.compile(r"first aid certificate|\bcpr\b certificate|provide first aid"), False),
    ("Manual handling",           re.compile(r"manual handling (?:certificate|training)"), False),
    ("White Card",                re.compile(r"white card|construction induction"), True),
    ("Forklift licence",          re.compile(r"forklift (?:licen[sc]e|ticket)|\blf\b licence"), True),
    ("Driver's licence",          re.compile(r"driver'?s? licen[sc]e|current licen[sc]e|\bc class\b"), False),
    ("RSA",                       re.compile(r"\brsa\b|responsible service of alcohol"), True),
    ("Food safety",               re.compile(r"food (?:safety|handling) certificate"), False),
    ("Security clearance",        re.compile(r"security clearance|baseline clearance|nv1|nv2"), True),
]

_REQUIRED_CTX = re.compile(
    r"\b(must|required|essential|mandatory|need to (?:have|hold)|"
    r"you (?:will )?(?:must|need)|current)\b",
    re.IGNORECASE,
)

_WORK_RIGHTS_JD = re.compile(
    r"australian citizen|permanent resident|full working rights|"
    r"right to work|work rights|unrestricted work",
    re.IGNORECASE,
)
_WORK_RIGHTS_CV = re.compile(
    r"citizen|permanent resident|work rights|right to work|"
    r"\bvisa\b|residency", re.IGNORECASE,
)

_DATE_RANGE = re.compile(
    r"(19|20)\d{2}\s*[-–—to]+\s*((?:19|20)\d{2}|present|current|now)",
    re.IGNORECASE,
)


def _estimate_cv_years(cv_text: str) -> float:
    """Rough career length = span between earliest and latest employment years."""
    now = datetime.date.today().year
    years: List[int] = []
    for m in _DATE_RANGE.finditer(cv_text):
        start = int(m.group(0)[:4])
        tail = m.group(2).lower()
        end = now if tail in ("present", "current", "now") else int(tail)
        years.extend([start, end])
    if len(years) < 2:
        return 0.0
    return float(max(years) - min(years))


def _required_context(jd_lower: str, pat: "re.Pattern[str]") -> bool:
    """True if a 'must/required/essential' word sits within ~80 chars of a match."""
    for m in pat.finditer(jd_lower):
        s = max(0, m.start() - 80)
        e = min(len(jd_lower), m.end() + 80)
        if _REQUIRED_CTX.search(jd_lower[s:e]):
            return True
    return False


def detect_knockouts(
    jd_text: str,
    jd_analysis: Dict[str, Any] | None,
    cv_text: str,
) -> Dict[str, Any]:
    """
    Return {"knockouts": [{type, requirement, status, ...}], "summary": {...}}.
    status ∈ {"fail", "verify", "pass"}. Never raises.
    """
    jd_l = (jd_text or "").lower()
    cv_l = (cv_text or "").lower()
    out: List[Dict[str, Any]] = []

    # 1. Minimum years (from the JD analysis, which already extracts it).
    req_years = (jd_analysis or {}).get("experience_years_required")
    try:
        req_years = float(req_years) if req_years is not None else None
    except (TypeError, ValueError):
        req_years = None
    if req_years and req_years >= 1:
        cand = _estimate_cv_years(cv_text)
        status = "pass" if cand + 1.0 >= req_years else ("verify" if cand == 0.0 else "fail")
        out.append({
            "type": "experience_years",
            "requirement": f"{int(req_years)}+ years",
            "candidate_estimate": round(cand, 1),
            "status": status,
        })

    # 2. Credentials / licences.
    for label, pat, always_hard in _CREDENTIALS:
        if not pat.search(jd_l):
            continue
        if not (always_hard or _required_context(jd_l, pat)):
            continue  # mentioned but only "desirable" → not a knockout
        has = bool(pat.search(cv_l))
        out.append({
            "type": "credential",
            "requirement": label,
            "status": "pass" if has else "fail",
        })

    # 3. Work rights / citizenship (can't positively confirm from a CV → verify).
    if _WORK_RIGHTS_JD.search(jd_l):
        has = bool(_WORK_RIGHTS_CV.search(cv_l))
        out.append({
            "type": "work_rights",
            "requirement": "work rights / citizenship",
            "status": "pass" if has else "verify",
        })

    summary = {
        "fail":   sum(1 for k in out if k["status"] == "fail"),
        "verify": sum(1 for k in out if k["status"] == "verify"),
        "pass":   sum(1 for k in out if k["status"] == "pass"),
    }
    return {"knockouts": out, "summary": summary}
