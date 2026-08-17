"""JD setting classification + summary setting-bridges — extracted from writers._impl.

Deterministic: classifies the JD's care setting and (only when the CV evidences it,
per the _cv_has_* gates) bridges the Professional Summary's setting line.
Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JD setting classifier — deterministic, injected at top of user message so
# the model cannot ignore the setting constraint in favour of the CV's prior.
# ---------------------------------------------------------------------------

_SETTING_HOME       = "home_community"
_SETTING_HOSPITAL   = "hospital_acute"
_SETTING_NDIS       = "ndis_disability"
_SETTING_LIFESTYLE  = "lifestyle_coordinator"
_SETTING_THEATRE    = "theatre_cssd"
_SETTING_RESIDENTIAL = "residential"


def _classify_jd_setting(jd_text: str, jd_analysis: Dict[str, Any]) -> str:
    """Return one of the _SETTING_* constants based on keyword matching.

    Precedence (highest → lowest):
      Theatre/CSSD → Lifestyle → Home/Community → NDIS/Disability → Hospital → Residential

    HOME before NDIS: many home-care JDs mention 'disability' or 'individuals
    living with disability' as client types without being NDIS-specific. resp0
    and the job title are the most reliable signals; the JD body text can
    contain 'disability' incidentally in a home-care context.
    """
    responsibilities = jd_analysis.get("responsibilities") or []
    resp0 = (responsibilities[0] if responsibilities else "").lower()
    job_title = (jd_analysis.get("job_title") or "").lower()
    # Use resp0 + job_title as primary signals; full JD text as tiebreaker only.
    primary   = resp0 + " " + job_title
    full_text = primary + " " + (jd_text or "")[:2000].lower()

    # 1. Theatre / CSSD (most specific — check first)
    if any(kw in full_text for kw in [
        "theatre cases", "instrument tray", "cssd", "sterile stock",
        "set up consumables", "sterile stock room",
    ]):
        return _SETTING_THEATRE

    # 2. Lifestyle / Activities coordinator
    if any(kw in full_text for kw in [
        "activities program", "group activities", "lifestyle program",
        "recreational activities", "organise and schedule",
    ]) or any(kw in job_title for kw in [
        "lifestyle coordinator", "leisure coordinator", "activities coordinator",
    ]):
        return _SETTING_LIFESTYLE

    # 3. Home / community care — BEFORE NDIS so home-care JDs that incidentally
    #    mention 'disability' as a client type are not mis-labelled as NDIS.
    #    Check PRIMARY (resp0 + job_title) first for highest confidence.
    _home_kws = [
        "in their home", "in the home", "clients' home", "clients in their home",
        "domestic assistance", "domestic help",
        "meal preparation",
        "transport to appointments", "transportation to appointments",
        "social outings",
        "retirement living residents in their homes",
        "home visit", "visit clients",
        "home care support worker", "home care worker",
    ]
    if any(kw in primary for kw in _home_kws):
        return _SETTING_HOME
    # Also check full text, but only if the job title doesn't signal NDIS.
    _ndis_title_kws = ["ndis", "disability support worker"]
    if (not any(kw in job_title for kw in _ndis_title_kws)
            and any(kw in full_text for kw in _home_kws)):
        return _SETTING_HOME

    # 4. NDIS / disability
    # Strip credential-only "ndis" mentions (e.g. "NDIS Workers Check", "NDIS
    # worker screening", and the NDISWC abbreviation) before testing — these
    # appear in residential aged care JDs as background-check requirements
    # and must not trigger the NDIS bridge.
    import re as _re
    _ndis_cred_re = _re.compile(
        r"ndis\s+worker[s]?\s+(?:check|screening|clearance|induction|orientation|module)"
        r"|ndis\s+(?:worker\s+)?screening\s+(?:check|clearance|requirements?)"
        # NDISWC / NDISWCs — the abbreviation. Word-boundary anchored so we
        # don't strip an unrelated token.
        r"|\bndiswc[s]?\b"
    )
    full_text_ndis = _ndis_cred_re.sub("", full_text)
    primary_ndis = _ndis_cred_re.sub("", primary)
    # Word-boundary regex so 'ndis' doesn't accidentally match unrelated
    # tokens (e.g. an unstripped 'ndiswc' or any future credential variant).
    # The bare 'ndis' keyword still hits when it stands alone as a sector
    # mention.
    _ndis_strong = _re.compile(
        r"\bndis\b|\bdisability\s+support\s+worker\b"
        r"|\bsupported\s+independent\s+living\b|\bsil\b"
        r"|\bdisability\s+services\s+(?:worker|officer)\b"
    )
    if _ndis_strong.search(primary_ndis):
        return _SETTING_NDIS

    _ndis_weak = _re.compile(
        r"\b(?:disability\s+support|non-verbal\s+participant"
        r"|acquired\s+brain\s+injury|high\s+intensity\s+support"
        r"|disability\s+worker)\b"
    )
    _residential_strong = _re.compile(
        r"\bresidential\s+aged\s+care\b"
        r"|\baged\s+care\s+(?:facility|home|community)\b"
        r"|\bnursing\s+home\b"
        r"|\bcare\s+community\b"
    )
    if (_ndis_weak.search(primary_ndis)
            and not _residential_strong.search(primary_ndis)):
        return _SETTING_NDIS

    # 5. Hospital / acute
    # Two signal tiers:
    #   STRONG = role-specific markers that mean "this IS a hospital role"
    #            (a ward type, a hospital staff phrasing). Single hit anywhere
    #            in full_text is enough.
    #   WEAK   = generic phrases ("acute care", "hospital setting") that
    #            appear in many residential aged-care JDs' corporate
    #            boilerplate (Australian Unity et al. operate both aged care
    #            AND acute services; their JD intros mention both). Require
    #            the WEAK signal in PRIMARY (resp0 + job_title) so an
    #            incidental boilerplate mention can't promote a residential
    #            AIN JD to HOSPITAL.
    _hospital_strong = [
        "surgical ward", "orthopaedic", "medical department",
        "hospital staff", "hospital ward",
    ]
    _hospital_weak = [
        "acute care", "hospital setting", "hospital settings",
        "acute clinical",
    ]
    if any(kw in full_text for kw in _hospital_strong):
        return _SETTING_HOSPITAL
    if any(kw in primary for kw in _hospital_weak):
        return _SETTING_HOSPITAL

    return _SETTING_RESIDENTIAL


def _build_jd_setting_block(setting: str) -> str:
    """Return a hard-constraint block to prepend to the user message.
    Empty string for residential (no constraint needed)."""
    if setting == _SETTING_RESIDENTIAL:
        return ""
    blocks = {
        _SETTING_HOME: (
            "⚠ SYSTEM-COMPUTED JD SETTING: HOME / COMMUNITY CARE\n"
            "This JD is for care delivered in clients' homes or the community — NOT a residential facility.\n"
            "HARD RULES for Career Highlights (cannot be overridden by any other instruction):\n"
            "• S1 MUST NOT say 'residential aged care settings' as the main setting noun.\n"
            "• Use a BRIDGE phrase instead — e.g.:\n"
            "  'residential aged care background, now delivering in-home support'\n"
            "  'aged care and in-home community care experience'\n"
            "  'aged care experience applied to home-based support'\n"
            "• S2 must evidence personal care, daily living, or community support — NOT medication admin as the lead."
        ),
        _SETTING_HOSPITAL: (
            "⚠ SYSTEM-COMPUTED JD SETTING: HOSPITAL / ACUTE CARE\n"
            "This JD is for a hospital ward or acute clinical environment — NOT a residential aged care facility.\n"
            "HARD RULES for Career Highlights (C82: no cross-setting bridge — five independent\n"
            "reviews each found a realistic aged-care CV phrasing that made a deterministic bridge\n"
            "fabricate hospital experience the candidate never had; this JD setting gets no bridge\n"
            "at all, only honest framing):\n"
            "• Do NOT claim hospital, acute-ward, or clinical-team experience in S1 unless the CV's\n"
            "  Experience section explicitly names a hospital employer or a specific ward/unit\n"
            "  (e.g. ICU, ED, a named surgical/medical ward). A candidate escalating a resident TO\n"
            "  hospital, or coordinating WITH hospital staff, is aged-care experience — not hospital\n"
            "  experience — do not blur the two.\n"
            "• When there is no such evidence, keep S1 residential-aged-care-framed and honest.\n"
            "• S2 should highlight transferable clinical-adjacent skills the CV genuinely supports —\n"
            "  medication administration accuracy, working within scope of practice, escalation and\n"
            "  documentation protocols, supporting a clinical team — without claiming a hospital setting."
        ),
        _SETTING_NDIS: (
            "⚠ SYSTEM-COMPUTED JD SETTING: NDIS / DISABILITY SUPPORT\n"
            "This JD is for disability or NDIS support — NOT residential aged care.\n"
            "HARD RULES for Career Highlights:\n"
            "• S1 MUST NOT say just 'residential aged care settings'.\n"
            "• Use a BRIDGE: e.g. 'aged care and disability support contexts'\n"
            "  or 'applying aged care skills to NDIS-funded support'.\n"
            "• S2 must evidence personal care, behavioural support, or complex care — not medication as lead."
        ),
        _SETTING_LIFESTYLE: (
            "⚠ SYSTEM-COMPUTED JD SETTING: LIFESTYLE / ACTIVITIES COORDINATOR\n"
            "This JD is for planning and coordinating resident activities — NOT direct personal care.\n"
            "HARD RULES for Career Highlights:\n"
            "• S1 specialisations MUST reference activities, engagement, wellbeing, or lifestyle programming.\n"
            "• S1 MUST NOT mention medication assistance, medication administration, or dementia care\n"
            "  as the lead specialisations.\n"
            "• S2 must evidence resident engagement, social participation, or activities support from the CV.\n"
            "• If the CV has no direct activities coordination, use the closest transferable skill\n"
            "  (e.g. person-centred care that supported resident wellbeing and social engagement)."
        ),
        _SETTING_THEATRE: (
            "⚠ SYSTEM-COMPUTED JD SETTING: THEATRE / CSSD CLINICAL SUPPORT\n"
            "This JD is for instrument/theatre/CSSD support — NOT personal care.\n"
            "HARD RULES for Career Highlights:\n"
            "• Do NOT write a care-worker summary.\n"
            "• Frame the candidate as bringing healthcare exposure, attention to clinical protocols,\n"
            "  and accuracy from their aged care background.\n"
            "• S2 should draw on documentation, clinical protocol compliance, and structured\n"
            "  healthcare environment experience."
        ),
    }
    return blocks.get(setting, "")


_HIGHLIGHT_HEADINGS_SET = frozenset([
    "career highlights", "professional summary", "summary", "profile",
])


# Patterns that match common ways the model writes the residential setting
# phrase in Career Highlights S1.
_S1_RESIDENTIAL_RE = re.compile(
    # Standard word order: "experience in/across (multiple) residential aged care (settings)"
    r"(?:experience (?:in|across)(?: multiple)? )"
    r"(?:residential aged care|aged care)(?: and (?:dementia|community) care)?"
    r"(?: (?:settings?|facilities?|environments?|contexts?|backgrounds?))?"
    # Reversed word order: "aged care experience in residential settings"
    r"|(?:aged care experience (?:in|across)(?: \w+)? (?:residential )?(?:settings?|facilities?|environments?))",
    re.IGNORECASE,
)

# Bridge replacements by setting type — honest framing that acknowledges the
# CV background while orienting toward the JD's target setting.
# HOSPITAL has no bridge phrase — deliberately, as of C82's independent
# review. Five review rounds each found a new, realistic way for a
# pure-residential-aged-care CV to satisfy a vocabulary-based hospital-
# evidence gate: bare RN/EN, same-line-only aged-care exclusions, bare
# "hospital"/"acute care"/"clinical placement" in bullet bodies, employer-
# heading-name matching (defeated by both a non-clinical job AT a hospital
# and a hospital-NAMED aged-care facility), and finally even ward/unit-
# specific vocabulary (ICU, ED, coronary care) mentioned as something an
# aged-care worker escalates a RESIDENT to or references about the
# resident's condition, not evidence of the CANDIDATE's own workplace. No
# heuristic survived adversarial review. Per this module's own honesty-
# over-score principle: under-triggering (never adding the bridge) is an
# acceptable failure mode; over-triggering (fabricating clinical experience
# in a real person's CV) is not — so, like LIFESTYLE, HOSPITAL is
# intentionally absent here and _apply_setting_bridge is a no-op for it.
_SETTING_BRIDGES = {
    _SETTING_HOME:     "experience in residential aged care, delivering care in home and community settings",
    _SETTING_NDIS:     "experience in aged care and disability support settings",
    _SETTING_THEATRE:  "experience in aged care and healthcare settings",
}


# CV-side markers that evidence acute / hospital / clinical-ward experience.
# Used to GATE the HOSPITAL bridge — without this, a candidate whose entire
# CV is residential aged care gets a fabricated "experience across residential
# aged care AND acute clinical settings" summary, which is dishonest.
# Hospital markers deliberately keep ONLY ward/unit-specific vocabulary,
# checked anywhere in the Experience section (heading or body) via the same
# plain scan every other bridge gate uses. Four independent review rounds
# (see C82 in ~/.claude/plans, not in this repo) each found a NEW way for a
# name/heading-based signal to false-positive on a pure-residential-aged-care
# CV: bare "hospital" ("coordinated hospital transfers"), "acute care"
# (resident acuity, not facility type), "clinical placement" (a nursing
# student's placement AT an aged-care employer), a heading-only check
# (defeated by a non-clinical job AT a hospital, or a hospital-NAMED
# aged-care facility, e.g. "St Vincent's Hospital Residential Aged Care"),
# and RN/EN (a registration, not a setting — aged care employs both
# routinely). None of those signals survived scrutiny. What DOES survive:
# markers specific enough that incidental mention in aged-care prose is
# implausible regardless of position — a ward/unit name, ED, ICU. Per this
# module's own honesty-over-score principle, under-triggering the bridge
# (a missed optimisation) is the acceptable failure mode; over-triggering it
# (a fabricated claim in a real person's CV) is not, so the marker set stays
# deliberately narrow rather than attempting yet another heuristic to widen it.
_CV_HOSPITAL_MARKERS_RE = re.compile(
    r"\b(?:"
    r"hospital\s+(?:settings?|wards?|departments?|environments?)"
    r"|acute\s+(?:hospital|wards?|settings?)"
    r"|surgical\s+wards?|medical\s+wards?|orthopaedic\s+wards?"
    r"|emergency\s+department|ed\s+nurse|icu|coronary\s+care"
    r")\b",
    re.IGNORECASE,
)


def _find_experience_section_start(src: str) -> int:
    """Return the index of the earliest Experience-like heading in src, or
    -1 if none is found."""
    lower = src.lower()
    idx = -1
    for h in ("## experience", "## work experience",
              "## professional experience", "## clinical experience"):
        i = lower.find(h)
        if i != -1 and (idx == -1 or i < idx):
            idx = i
    return idx


def _scan_experience_section(
    cv_text: str, tailored_md: str, marker_re: "re.Pattern[str]"
) -> bool:
    """Search marker_re inside the Experience/Education portion of cv_text or
    tailored_md. The Summary is excluded so a JD-paraphrased setting in S1
    cannot self-confirm the gate.

    Fails CLOSED (no match) for a source with no recognisable Experience
    heading, rather than falling back to a whole-document scan — otherwise
    a Summary/Objective line paraphrasing the JD setting ("seeking a role
    in a hospital setting") would self-confirm the gate on any CV whose
    Experience section isn't cleanly headed."""
    for src in (cv_text or "", tailored_md or ""):
        idx = _find_experience_section_start(src)
        if idx == -1:
            continue
        if marker_re.search(src[idx:]):
            return True
    return False


def _cv_has_hospital_experience(cv_text: str, tailored_md: str) -> bool:
    """True when the candidate's CV evidences hospital / acute / clinical-ward
    experience. False for a pure aged-care / home-care / disability CV.

    Conservative: requires a hospital/acute MARKER in the Experience or
    Education section. Markers in the Summary alone don't count (the writer
    could be paraphrasing the JD)."""
    return _scan_experience_section(cv_text, tailored_md, _CV_HOSPITAL_MARKERS_RE)


# --- CV-side markers for the other bridges (HOME, NDIS, LIFESTYLE, THEATRE) ---
# These mirror _CV_HOSPITAL_MARKERS_RE / _cv_has_hospital_experience and gate
# each setting bridge the same way: if the CV has no evidence of the target
# setting, the bridge phrase would fabricate experience, so we skip it.

_CV_HOME_MARKERS_RE = re.compile(
    r"\b(?:"
    r"home\s+care|in[-\s]home\s+care|community\s+care"
    r"|client(?:'s)?\s+home|in\s+the\s+home"
    r"|domiciliary|home\s+visits?|home[-\s]based\s+care"
    r"|community\s+(?:nursing|aged\s+care|support)"
    r"|home\s+and\s+community"
    r")\b",
    re.IGNORECASE,
)

_CV_NDIS_MARKERS_RE = re.compile(
    r"\b(?:"
    r"ndis|disability\s+support|disability\s+(?:services|care|sector)"
    r"|supported\s+independent\s+living|sil\b"
    r"|individual\s+support\s+plans?|participant(?:s)?\b"
    r"|behaviour\s+support|positive\s+behaviour\s+support"
    r")\b",
    re.IGNORECASE,
)

_CV_LIFESTYLE_MARKERS_RE = re.compile(
    r"\b(?:"
    r"lifestyle(?:\s+(?:coordinator|officer|assistant|program))?"
    r"|recreational\s+(?:activities|therapy|program)"
    r"|activities\s+coordinator|diversional\s+therapy"
    r"|leisure\s+(?:program|activities)"
    r")\b",
    re.IGNORECASE,
)

_CV_THEATRE_MARKERS_RE = re.compile(
    r"\b(?:"
    r"theatres?|operating\s+theatres?|operating\s+rooms?"
    r"|perioperative|peri[-\s]?op"
    r"|scrub\s+(?:nurse|tech)|circulating\s+nurse|anaesthet\w*"
    r"|cssd|central\s+sterilisation"
    r"|surgical\s+(?:assistant|nurse)|recovery\s+(?:nurse|room|bay)"
    r")\b",
    re.IGNORECASE,
)


def _cv_has_home_care_experience(cv_text: str, tailored_md: str) -> bool:
    """True when CV evidences home / community care work."""
    return _scan_experience_section(cv_text, tailored_md, _CV_HOME_MARKERS_RE)


def _cv_has_ndis_experience(cv_text: str, tailored_md: str) -> bool:
    """True when CV evidences NDIS / disability support work."""
    return _scan_experience_section(cv_text, tailored_md, _CV_NDIS_MARKERS_RE)


def _cv_has_lifestyle_experience(cv_text: str, tailored_md: str) -> bool:
    """True when CV evidences lifestyle / activities / recreation work."""
    return _scan_experience_section(cv_text, tailored_md, _CV_LIFESTYLE_MARKERS_RE)


def _cv_has_theatre_experience(cv_text: str, tailored_md: str) -> bool:
    """True when CV evidences theatre / perioperative / CSSD work."""
    return _scan_experience_section(cv_text, tailored_md, _CV_THEATRE_MARKERS_RE)


# Maps each settable bridge to its CV-evidence gate function.
# LIFESTYLE and HOSPITAL have no bridge phrase (see _SETTING_BRIDGES) so
# both are intentionally absent — _apply_setting_bridge is a no-op for
# either regardless of this dict. _cv_has_hospital_experience/
# _CV_HOSPITAL_MARKERS_RE stay defined (still exported, still tested) as
# a documented record of what was tried and found unreliable, not because
# anything still calls them for gating.
_BRIDGE_EVIDENCE_GATES = {
    _SETTING_HOME:     _cv_has_home_care_experience,
    _SETTING_NDIS:     _cv_has_ndis_experience,
    _SETTING_THEATRE:  _cv_has_theatre_experience,
}


def _apply_setting_bridge(md: str, setting: str, *, cv_text: str = "") -> str:
    """Deterministically replace the residential setting phrase in S1 of Career
    Highlights with a bridge phrase that acknowledges the CV background while
    orienting toward the JD's actual setting.

    Only touches S1 (the first prose line) of the Career Highlights section.
    No-op for residential JDs or lifestyle coordinator (setting is correct).

    HONESTY GATE: every bridge phrase claims experience across BOTH residential
    aged care AND the target setting. When the CV has no evidence of the target
    setting, applying the bridge is a fabrication. The per-setting gates in
    ``_BRIDGE_EVIDENCE_GATES`` (hospital, home, NDIS, theatre) skip the
    replacement in that case and let S1 stay residential — the score will
    reflect the actual mismatch but the CV is truthful.
    """
    bridge = _SETTING_BRIDGES.get(setting)
    if not bridge:
        return md  # residential or lifestyle — no replacement needed

    # Honest-attribution gate — every bridge claims experience in BOTH
    # residential AND the target setting. If the CV has zero evidence of the
    # target setting, applying the bridge fabricates experience. Skip it and
    # let S1 stay residential. The ATS score will honestly reflect the gap.
    gate = _BRIDGE_EVIDENCE_GATES.get(setting)
    if gate and not gate(cv_text, md):
        logger.info(
            "_apply_setting_bridge: SKIPPED %s bridge — CV has no evidence "
            "markers for that setting; would have fabricated.", setting,
        )
        return md

    lines = md.split("\n")
    in_section = False
    first_prose_done = False
    out = []
    for line in lines:
        s = line.strip()
        # C22f: strip a trailing colon the AI writer sometimes emits — a
        # colon'd "## Career Highlights:" previously defeated this check
        # entirely, so the setting bridge silently never applied.
        if s.startswith("## ") and s[3:].strip().lower().rstrip(":") in _HIGHLIGHT_HEADINGS_SET:
            in_section = True
            out.append(line)
            continue
        if in_section and s.startswith("## "):
            in_section = False
        # Only replace in the first non-empty, non-bullet prose line (= S1)
        if in_section and not first_prose_done and s and not re.match(r"^\s*[-*•]", line):
            first_prose_done = True
            # Idempotency guard: the composition prompt's own hard-rule block
            # (_build_jd_setting_block) instructs the model to write this
            # exact bridge phrasing directly, so S1 often already contains it
            # by the time this deterministic pass runs. _S1_RESIDENTIAL_RE
            # matches the plain-residential PREFIX of an already-bridged
            # phrase, so substituting again would double the tail
            # ("...and acute clinical settings and acute clinical settings").
            if bridge.lower() in line.lower():
                out.append(line)
                continue
            new_line = _S1_RESIDENTIAL_RE.sub(bridge, line)
            if new_line != line:
                first_prose_done = True
                logger.debug("_apply_setting_bridge[%s]: replaced S1 setting phrase", setting)
                # After applying the bridge, strip any residual "in residential
                # settings" or "in a residential setting" elsewhere in S1 that
                # wasn't part of the matched span — avoids doubled phrases like
                # "delivering care in home settings, ...for older people in
                # residential settings".
                new_line = re.sub(
                    r"\s+(?:in|at|within)(?: (?:a|an))? (?:residential|facility)(?: (?:aged care|care))? "
                    r"(?:settings?|facilities?|environments?)",
                    "",
                    new_line,
                    flags=re.IGNORECASE,
                )
            line = new_line
        out.append(line)
    return "\n".join(out)
