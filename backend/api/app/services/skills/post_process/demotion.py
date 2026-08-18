"""Off-setting keyword demotion (boilerplate suppression — deterministic).

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ._common import logger

# ---------------------------------------------------------------------------
# Off-setting keyword demotion (boilerplate suppression — deterministic)
# ---------------------------------------------------------------------------
#
# Australian Unity's residential aged-care JDs include "we support people
# across aged care, disability, and mental health services" in their
# About-Us / brand prose. The AI extracts "disability support" / "mental
# health support" from that prose as REQUIRED skills even though the role
# is purely residential aged care. Result: the matcher fails on these
# false-positive requirements and the candidate's score drops for a gap
# that isn't real.
#
# The prompt-level "About Us suppression" rule helps but doesn't fully
# stop this on JDs that weave brand prose into the role description. This
# deterministic post-process catches the rest: when the JD's setting is
# clearly RESIDENTIAL or HOME_COMMUNITY, demote that setting's off-setting
# domain keywords from required to preferred. We don't drop them entirely
# — they may still be present
# as a real nice-to-have — but they no longer drive required-bucket
# match-rate scoring.

# Off-setting keywords by target setting. Each list names domain keywords
# that, if present in REQUIRED on a JD classified as the target setting,
# should be demoted to PREFERRED. Empty list = no demotion for that setting.
_OFF_SETTING_DOMAIN_KEYWORDS: Dict[str, frozenset] = {
    "residential": frozenset({
        "disability support", "disability services", "ndis",
        "supported independent living", "individual support plans",
        "mental health support", "mental health care",
        "home care", "community care", "in-home care", "domiciliary care",
    }),
    "home_community": frozenset({
        # Home-care JDs often quote the provider's portfolio: "we support
        # people across aged care, disability and mental health services."
        # On a home-care role these are NOT the day-to-day work.
        "mental health support", "mental health care", "social work support",
        "social work", "disability support", "disability services",
        "supported independent living",
        # Hospital / acute is also off-setting for home care.
        "acute care", "hospital setting", "acute clinical care",
    }),
}


def demote_off_setting_keywords(
    jd_analysis: Dict[str, Any], jd_setting: Optional[str],
) -> Dict[str, Any]:
    """Demote off-setting REQUIRED domain keywords to PREFERRED.

    Caller resolves jd_setting via writers._classify_jd_setting (or a
    similar deterministic classifier). Pass None to no-op.

    Mutates a shallow copy. Records demotions in
    ``lexicon_meta.off_setting_demoted`` for diagnostics. Idempotent on
    repeat calls.
    """
    if not jd_setting:
        return jd_analysis
    off_set = _OFF_SETTING_DOMAIN_KEYWORDS.get(jd_setting)
    if not off_set:
        return jd_analysis

    req = (jd_analysis.get("required_skills") or {})
    pref = (jd_analysis.get("preferred_skills") or {})
    req_dk = list(req.get("domain_knowledge") or [])
    pref_dk = list(pref.get("domain_knowledge") or [])

    keep: List[str] = []
    demoted: List[str] = []
    for kw in req_dk:
        if (kw or "").strip().lower() in off_set:
            demoted.append(kw)
            if kw not in pref_dk:
                pref_dk.append(kw)
        else:
            keep.append(kw)

    if not demoted:
        return jd_analysis

    out = dict(jd_analysis)
    new_req = dict(req)
    new_req["domain_knowledge"] = keep
    out["required_skills"] = new_req
    new_pref = dict(pref)
    new_pref["domain_knowledge"] = pref_dk
    out["preferred_skills"] = new_pref

    meta = dict(out.get("lexicon_meta") or {})
    meta["off_setting_demoted"] = {
        "setting": jd_setting,
        "demoted": demoted,
    }
    out["lexicon_meta"] = meta

    logger.info(
        "off-setting demotion (setting=%s): %d keyword(s) moved required→preferred: %s",
        jd_setting, len(demoted), demoted,
    )
    return out
