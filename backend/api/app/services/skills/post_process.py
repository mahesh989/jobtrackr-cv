"""Apply lexicon classification to LLM-extracted skill lists.

Used after JD analysis (LLM) and after CV categorisation (LLM) to:

  • drop universal noise from skill buckets (eligibility / credential /
    framework noise — these are NEVER skills)
  • move mis-bucketed skills to their lexicon-correct category
  • replace surface phrasings with canonical forms (so the CV and JD
    sides agree on the same canonical entry — which is what makes
    downstream matching deterministic)
  • track what was removed/moved in a `sidecar` dict, for routing
    (credentials → Registration & Licences) and for diagnostics

The LLM still EXTRACTS phrases (variance-tolerant). The lexicon
DECIDES the category (deterministic). Unknown phrases stay in the
LLM-assigned bucket as a safe fallback rather than being guessed
into the wrong one.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.skills.classifier import (
    _SUBSUMES,
    _VERTICAL_LOOKUPS,
    classify,
    is_noise,
    normalise,
    variants_for_canonical,
)

# ---------------------------------------------------------------------------
# Pattern-based qualification / student-status filter
# ---------------------------------------------------------------------------
# These phrases are ALWAYS credentials/prerequisites, never a skill the
# candidate demonstrates.  A single regex is more maintainable than
# listing every "Certificate III in …" / "Diploma of …" variant explicitly.
#
# Conservative: anchored at the START so "individual support certificate"
# doesn't accidentally match.  Route to sidecar["credential"].
_QUAL_PATTERN = re.compile(
    r"^(?:"
    r"certificate\s+(?:i{1,4}|iv|[1-4]|in\b|of\b)|"     # certificate III/IV/in
    r"cert\.?\s+(?:i{1,4}|iv|[1-4]|in\b)|"               # cert III / cert. IV
    r"diploma\s+of\b|"
    r"advanced\s+diploma\b|"
    r"bachelor\s+(?:of|degree)\b|"
    r"graduate\s+(?:certificate|diploma|entry)\b|"
    r"master\s+of\b|"
    r"enrolled\s+in\b|"
    r"completion\s+of\b|"
    # "completed first year of nursing", "completed bachelor of", "completed
    # certificate IV", "completed diploma of nursing" — qualification progress.
    r"completed\s+(?:"
        r"(?:first|second|third|fourth|final|1st|2nd|3rd|4th)\s+year\b|"
        r"year\s+(?:one|two|three|four|1|2|3|4)\b|"
        r"certificate\b|cert\.?\s+(?:i{1,4}|iv|[1-4]|in\b)|"
        r"diploma\b|advanced\s+diploma\b|"
        r"bachelor\b|master\b|graduate\b|"
        r"nursing\s+course\b|nursing\s+degree\b|nursing\s+studies\b"
    r")|"
    # Bare "first year of nursing course" / "third year medical student" / etc.
    # — anchored at start. Only matches when followed by a clear qualification
    # context word ("nursing/medical/midwifery/medicine/pharmacy/allied
    # health"), so "first year of employment" stays a skill phrase (it isn't).
    r"(?:first|second|third|fourth|final|1st|2nd|3rd|4th)\s+year\s+"
    r"(?:of\s+)?"
    r"(?:nursing|medical|midwifery|medicine|pharmacy|allied\s+health)\b|"
    r"year\s+(?:one|two|three|four|1|2|3|4)\s+of\s+"
    r"(?:nursing|medical|midwifery|medicine|pharmacy|allied\s+health|"
    r"the\s+(?:nursing|medical|midwifery)\s+(?:course|degree|program))\b|"
    r"hltaid\d"                                            # HLTAID011 etc.
    r")",
    re.IGNORECASE,
)

# Student / qualification descriptions that are NOT captured by the pattern
# above but should still route to the credential sidecar.
_STUDENT_NOISE = frozenset({
    "rn student", "en student",
    "nursing student clinical skills",
    "nursing student with aged care placement",
    "nursing student with aged care placement experience",
    "overseas nursing qualification",
    "overseas qualified nurse",
    "overseas nursing registration",
    "assistant in nursing qualification",
    "enrolled nurse qualification",
    "registered nurse qualification",
    "allied health student background",
    "allied health training",
    "nursing assistance in residential aged care",
    "fundamental clinical nursing skills",
    "fundamental clinical skills",
    "health service assistance",
    "basic clinical nursing skills",
    "rn studies",
    "en studies",
    "assistant in nursing skills",
    "aged care worker skills",
})


def _is_qualification_phrase(phrase: str) -> bool:
    """True if the phrase describes a qualification/credential, not a skill."""
    lowered = phrase.strip().lower()
    if _QUAL_PATTERN.match(lowered):
        return True
    return lowered in _STUDENT_NOISE


# Embedded credential markers — the qualification pattern above is anchored at
# the START of the phrase, so it misses cases where a credential marker is
# embedded mid-phrase: "individual support at certificate iv level",
# "medication endorsement (HLTHPS007 unit)". This regex scans for those
# markers anywhere in the phrase.
_EMBEDDED_CREDENTIAL_MARKER_RE = re.compile(
    r"(?ix)("
    # "at certificate iv level" / "at cert iv level" / "(certificate iv)" / "(cert iv)"
    # Also catches slashed pairs like "(certificate iii/iv)" and "cert iii or iv"
    # by allowing an optional "/iv" or " or iv" tail before the closer.
    r"\b(?:at\s+)?(?:certificate|cert\.?)\s*(?:i{1,4}|iv|[1-4])"
    r"(?:\s*(?:[/]|\bor\b)\s*(?:iv|i{1,4}|[1-4]))?"
    r"\s*(?:level\b|\)|$|\sin\b|\sof\b)"
    r"|"
    # Embedded AU VET unit codes anywhere in the phrase:
    # "(HLTHPS007)", "(HLTHPS007 unit)", " HLTHPS007 ", etc.
    r"\b(?:hltaid|hlthps|chcccs|chc|hlt|bsb|fsk|sit|cpp|ahc)\d{3,}"
    r"|"
    # The medication-endorsement family — never a skill.
    r"\bmedication\s+endorsement\b"
    r")"
)


def _has_credential_marker(phrase: str) -> bool:
    """True when the phrase contains an embedded credential/qualification
    marker that the leading-anchored ``_QUAL_PATTERN`` misses.

    Examples that match:
      • "individual support at certificate iv level"
      • "aged care at certificate iv level"
      • "medication endorsement (HLTHPS007 unit)"
      • "experience with HLTAID011"
      • "individual support (ageing, home and community)"
      • "infection prevention (vaccination awareness)"
      • "infection prevention and control (immunisation requirements)"

    Used by ``post_process_skills`` to route these phrases to the
    credential sidecar instead of leaving them as Care Skills.
    """
    if not phrase:
        return False
    p = phrase.lower()
    if _EMBEDDED_CREDENTIAL_MARKER_RE.search(p):
        return True
    # Parenthetical credential tail — phrase ends in "(X)" where X contains
    # a credential-flavoured token. Distinguishes between a clarifying
    # parenthetical ("(BESTMed)" after a tool name) and a credential one
    # ("(immunisation requirements)" after a clinical skill).
    if _CREDENTIAL_PAREN_TAIL_RE.search(p):
        return True
    return False


_CREDENTIAL_PAREN_TAIL_RE = re.compile(
    r"(?ix)"
    r"\("
    r"[^()]{0,200}"
    r"(?:"
    r"vaccination|immunisation|immunization|"
    r"certificate|cert\.?\s*[iv1-4]|cert\s*[iv1-4]|"
    r"ahpra|nmba|registration\s+number|"
    r"(?:ageing|aged)\s*,\s*home(?:\s*,)?\s*(?:and\s+)?community|"
    r"(?:home|community)\s*,\s*(?:ageing|aged)"
    r")"
    r"[^()]{0,200}"
    r"\)\s*$",
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Three pattern-based recognisers covering issues that recur across JDs:
#
#   1. Conditional REQUIRED skills like "current ndiswc OR willingness to
#      apply" — the JD itself says the requirement is soft, so the entry
#      belongs in PREFERRED, not REQUIRED. Without demotion the matching
#      denominator treats it as a hard miss and tanks the score.
#
#   2. Languages mis-bucketed as care/clinical skills ("cantonese language"
#      under domain_knowledge). Languages are NOT care competencies. Route
#      to `technical` so they render under Other Skills, not Care Skills.
#
#   3. Australian VET unit codes ("HLTHPS007", "HLTAID011", "CHCCCS015")
#      embedded in a skill list. These are CERT-UNIT identifiers, not
#      skills — they belong with credentials. Route to sidecar["credential"].
# ---------------------------------------------------------------------------

# Conditional / soft-requirement phrasing — when a "required" item contains
# one of these clauses, the JD is signalling "or you can apply / obtain it
# after". That's the textbook definition of a PREFERRED skill.
_CONDITIONAL_CLAUSE_RE = re.compile(
    r"\s*(?:"
    r"\bor\s+(?:willing(?:ness)?|able|prepared|happy|eligible|eligibility)"
    r"\s+(?:to\s+)?(?:apply|obtain|complete|undergo|undertake|acquire|gain)"
    r"|\bwilling(?:ness)?\s+to\s+(?:apply|obtain|complete|undergo|undertake|acquire)"
    r"|\beligibility\s+to\s+(?:apply|obtain)"
    r"|\bopen\s+to\s+(?:obtaining|applying)"
    r"|\bability\s+to\s+obtain"
    r"|\b(?:can|could)\s+be\s+(?:obtained|acquired)"
    r")\b.*$",
    re.IGNORECASE,
)


def _split_conditional_phrase(phrase: str) -> Tuple[str, bool]:
    """Return (stripped_phrase, was_conditional).

    Strips a trailing conditional clause and reports whether one was found.
    The caller demotes phrases with `was_conditional=True` to preferred.
    """
    if not phrase:
        return phrase, False
    m = _CONDITIONAL_CLAUSE_RE.search(phrase)
    if not m:
        return phrase, False
    stripped = phrase[: m.start()].rstrip(" ,;-")
    # If the entire phrase IS the conditional clause (no core skill left),
    # don't demote a placeholder — just return the original.
    if not stripped:
        return phrase, False
    return stripped, True


# Language detector — matches "X language" / "X-speaking" / "speaks X" /
# "X speaker" / "bilingual (X)" / "fluent in X". Word-boundary anchored so
# it doesn't false-fire on "sign language" inside a clinical phrase.
_LANGUAGE_PATTERN_RE = re.compile(
    r"(?:"
    r"\b[a-z]+\s+language\b"
    r"|\b[a-z]+[- ]speaking\b"
    r"|\bspeaks?\s+[a-z]+\b"
    r"|\b[a-z]+\s+speaker\b"
    r"|\bfluent\s+in\s+[a-z]+\b"
    r"|\bbilingual\s+(?:\(.+\)|in\s+[a-z]+)\b"
    r"|\bmultilingual\b"
    r")",
    re.IGNORECASE,
)
# Phrases that look like languages BUT are clinical idioms — keep as skills.
_LANGUAGE_FALSE_POSITIVES = frozenset({
    "sign language",      # legitimate clinical communication skill
    "auslan",
    "auslan language",
    "body language",      # soft skill
    "patient language",
    "plain language",
})


def _looks_like_language(phrase: str) -> bool:
    """True when phrase is a (spoken/written) language skill that should
    NOT be bucketed as a clinical/care competency."""
    if not phrase:
        return False
    lowered = phrase.strip().lower()
    if lowered in _LANGUAGE_FALSE_POSITIVES:
        return False
    if "sign language" in lowered:
        return False
    return bool(_LANGUAGE_PATTERN_RE.search(lowered))


# Australian VET / nationally-recognised unit codes — 3 to 7 alpha prefix
# (HLT, HLTHPS, CHC, BSB, FSK, SIT, CPP, AHC, ...) followed by 3-4 digits.
# Conservative: requires the all-caps shape OR explicit "unit" suffix.
_AU_UNIT_CODE_RE = re.compile(
    r"^(?:"
    r"[a-z]{3,7}\d{3,5}[a-z]?"
    r")(?:\s+unit)?$",
    re.IGNORECASE,
)
# Common cert prefixes — used as a SECOND check to keep false positives down.
# Without this guard the broad regex above would also strip arbitrary tokens
# like "ABC123" that aren't qualification codes.
_AU_UNIT_PREFIXES = frozenset({
    "hlt", "hlthps", "hltaid", "hltinf", "hltwhs", "hltaap", "hltent",
    "chc", "chcccs", "chcage", "chcdis", "chcdiv", "chccom", "chcmhs",
    "bsb", "bsbwhs", "bsbcmm", "bsbops",
    "fsk", "fskdig", "fsknum", "fskoc", "fskrdg", "fskwtg",
    "sit", "sithccc", "sitxcom", "sitxfsa", "sitxhrm",
    "cpp", "cppgna", "cppclo",
    "ahc", "ahcwhs", "ahclpw",
})


# Vehicle / driver-licence / insurance JD requirements — these describe
# eligibility requirements ("you must have a car and insurance"), not
# discrete competencies. Catches phrasing variants the static credential
# lexicon misses (state-prefixed licences like "NSW driver's license",
# vehicle-access phrases like "access to a car with third-party property
# insurance", and bare insurance references in JD body).
_VEHICLE_ELIGIBILITY_RE = re.compile(
    r"\b("
    r"(?:nsw|vic|qld|wa|sa|tas|act|nt)\s+(?:driver'?s?|drivers?)\s+(?:licen[cs]e|permit)"
    r"|driver'?s?\s+(?:licen[cs]e|permit)"
    r"|(?:access\s+to\s+(?:a\s+)?(?:car|vehicle))"
    r"|(?:reliable|own|private|comprehensive)\s+(?:car|vehicle|transport)"
    r"|(?:car|vehicle|transport)\s+(?:insurance|registration|access|with\s+insurance)"
    r"|(?:third[-\s]?party\s+(?:property\s+)?insurance)"
    r"|comprehensive\s+car\s+insurance"
    r"|valid\s+(?:car|vehicle|driver'?s?)\s+(?:licen[cs]e|insurance|registration)"
    r")\b",
    re.IGNORECASE,
)


def _is_vehicle_eligibility(phrase: str) -> bool:
    """True when the phrase is a vehicle / driver-licence / car-insurance JD
    eligibility statement, not a competency. Routed to the credential sidecar."""
    if not phrase:
        return False
    return bool(_VEHICLE_ELIGIBILITY_RE.search(phrase))


def _is_au_unit_code(phrase: str) -> bool:
    """True when phrase is an Australian VET unit code (HLTHPS007, HLTAID011,
    CHCCCS015 …). Used to route the entry to the credential sidecar — these
    are qualification components, never skills."""
    if not phrase:
        return False
    lowered = phrase.strip().lower()
    if not _AU_UNIT_CODE_RE.match(lowered):
        return False
    # Extract the alpha prefix and confirm it's a known VET training-package
    # prefix. Keeps random "ABC123" out.
    m = re.match(r"^([a-z]+)", lowered)
    if not m:
        return False
    alpha = m.group(1)
    # Accept any prefix that STARTS with a known VET package code.
    return any(alpha.startswith(p) for p in _AU_UNIT_PREFIXES)


def _demote_conditional_required_to_preferred(
    jd_analysis: Dict[str, Any],
) -> Dict[str, Any]:
    """Move any required_skills entry with a 'or willing to obtain'-style
    clause to preferred_skills, with the conditional clause stripped from
    the keyword text.

    Mutates a shallow copy. Same category preserved (technical → technical,
    soft → soft, domain → domain). Idempotent on already-cleaned input.
    """
    req = (jd_analysis.get("required_skills") or {})
    pref = (jd_analysis.get("preferred_skills") or {})
    if not req:
        return jd_analysis

    new_req: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    new_pref: Dict[str, List[str]] = {c: list(pref.get(c) or []) for c in _CATEGORIES}
    demoted_count = 0

    for cat in _CATEGORIES:
        for kw in (req.get(cat) or []):
            if not isinstance(kw, str):
                continue
            stripped, was_cond = _split_conditional_phrase(kw)
            if was_cond:
                # Demote to preferred (same category), with the conditional
                # clause stripped. Dedup against existing preferred entries.
                if stripped.lower() not in {p.lower() for p in new_pref[cat]}:
                    new_pref[cat].append(stripped)
                demoted_count += 1
            else:
                new_req[cat].append(kw)

    if demoted_count == 0:
        return jd_analysis

    out = dict(jd_analysis)
    out["required_skills"] = new_req
    out["preferred_skills"] = new_pref
    logger.info(
        "JD conditional demoter: moved %d required entries to preferred "
        "(conditional 'or willing to apply'-style clause detected)",
        demoted_count,
    )
    return out


# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
_CATEGORIES: Tuple[str, ...] = ("technical", "soft_skills", "domain_knowledge")

# role_family.id → lexicon vertical. The `master` family is the general
# fallback (unknown role): we don't apply a vertical lexicon to it, but we
# DO still apply the universal noise filter (sector-agnostic).
_ROLE_FAMILY_TO_VERTICAL: Dict[str, Optional[str]] = {
    "tech": "tech",
    "nursing": "nursing",
    "manual": "cleaning",
    "master": None,
}


# JD-side sector / setting labels — descriptors of the role's WORK SETTING or
# SECTOR, not skills the candidate exercises. The CV side already filters
# these from the Skills section (see eval/enforce.py _ROLE_CATEGORY_LABELS);
# this is the symmetric JD-side strip so they don't appear as JD keywords the
# CV must "match". Each entry is the canonical-lower form returned by the
# vertical lexicon (or a bare variant that the LLM is likely to emit).
#
# Conservative — we INCLUDE the home/community/disability/retirement variants
# that have been confirmed as JD-leak symptoms, and EXCLUDE 'aged care' and
# 'domestic assistance' because:
#   • 'aged care' is often the role's primary vertical (when a JD says
#     "5 years aged care experience" we want to keep it).
#   • 'domestic assistance' describes a duty (washing/ironing/vacuuming),
#     not a setting — the JD genuinely demands it as a skill.
_SECTOR_SETTING_LABELS: frozenset = frozenset({
    # Job-type / vertical descriptors — align with enforce._ROLE_CATEGORY_LABELS
    "aged care",
    "domestic assistance",
    "independent living support",
    "independent living assistance",
    # Setting / service-type descriptors
    "home care",
    "in-home care",
    "in home care",
    "domiciliary care",
    "home care worker",
    "community care",
    "community aged care",
    "home and community care",
    "disability support",
    "disability care",
    "disability services",
    "retirement living",
    "retirement village",
    "residential care",
    "residential aged care",
})


# JD-side credential-component labels — phrases that ONLY appear as fragments
# of a credential name (notably "Certificate III/IV in Individual Support
# (Ageing, Home, and Community)"). The LLM splits the parenthetical into
# bare skills ("individual support" / "ageing support") which are neither
# settings nor competencies — they're qualification components. Route to the
# credential sidecar so they don't pollute the Skills bucket.
_CREDENTIAL_COMPONENT_LABELS: frozenset = frozenset({
    "individual support",
    "ageing support",
    "ageing, home and community",
    "ageing home and community",
})


_WORD_FAMILY_TOKEN_RE = re.compile(r"[a-z][a-z]+")

# Context words that indicate a setting-label phrase is being used as a JD
# requirement qualifier (e.g. "residential aged care facility experience")
# rather than as a standalone skill. Containment of any _SECTOR_SETTING_LABELS
# member PLUS one of these trailing words → treat as setting descriptor.
_SETTING_CONTEXT_WORDS: frozenset = frozenset({
    "experience", "facility", "environment", "setting",
    "background", "exposure", "knowledge",
})


# Words that signal a prose sentence tail rather than credential content.
# When _QUAL_PATTERN matches a prefix of an ngram phrase, the tail after the
# match is walked word-by-word; the first hit in this set terminates the
# captured credential.  e.g. "cert iii and or iv TO join our" → stops at "to".
_CRED_PROSE_TAIL_STOP: frozenset = frozenset({
    "to", "you", "we", "our", "their", "will", "provide",
    "join", "team", "staff", "passionate", "motivated",
    "who", "where", "when", "while", "which", "as",
    "are", "is", "has", "have", "was", "were",
    "currently", "supportive", "friendly",
})


def _trim_qual_phrase(phrase_lower: str) -> str:
    """Trim a qualification phrase to remove trailing prose words.

    ``_QUAL_PATTERN.match`` is anchored at the start but does NOT require a
    full match, so "cert iii and or iv to join our" also matches.  This helper
    walks the tail after the matched portion and stops at the first stop word,
    yielding "cert iii and or iv" instead.

    The pattern's alternation (``i{1,4}`` before ``iv``) can stop mid-word
    (matching "i" from "iv"), so we first advance to the nearest word boundary
    before inspecting the tail.
    """
    m = _QUAL_PATTERN.match(phrase_lower)
    if not m:
        return phrase_lower
    # Advance to the end of the current token (handles regex stopping mid-word,
    # e.g. matching "certificate i" from "certificate iv").
    end = m.end()
    while end < len(phrase_lower) and phrase_lower[end] not in " \t":
        end += 1
    base = phrase_lower[:end]
    tail_words = phrase_lower[end:].strip().split()
    allowed: list = []
    for w in tail_words:
        # A parenthetical opens an alternative/clarification ("(or equivalent)",
        # "(or Certificate IV …)") that is not part of the core credential name —
        # stop before it so we never leave a dangling "(or".
        if w.startswith("("):
            break
        if w.strip(".,;:()") in _CRED_PROSE_TAIL_STOP:
            break
        allowed.append(w)
    return (base + (" " + " ".join(allowed) if allowed else "")).strip()


def _is_setting_descriptor(phrase_lower: str) -> bool:
    """True when *phrase_lower* is a sector/setting label OR a setting label
    followed by a context qualifier (experience/facility/environment/…).

    Examples:
      "aged care"                              → True  (exact)
      "residential aged care"                  → True  (exact)
      "residential aged care facility experience" → True  (containment)
      "personal care"                          → False (not a setting label)
    """
    if phrase_lower in _SECTOR_SETTING_LABELS:
        return True
    tokens = phrase_lower.split()
    if tokens and tokens[-1] in _SETTING_CONTEXT_WORDS:
        # Check whether any setting label is a prefix of this phrase
        for label in _SECTOR_SETTING_LABELS:
            if phrase_lower.startswith(label):
                return True
    return False


# Values/motivational fluff the LLM sometimes emits as a "soft skill". These are
# aspirational statements, not competencies, and carry no ATS or matching value.
# Matched as substrings (lowercased) so minor wording variants are covered.
# Kept deliberately narrow to avoid swallowing real soft skills.
_FLUFF_SUBSTRINGS: tuple = (
    "making a positive difference",
    "make a positive difference",
    "positive difference",
    "make a difference",
    "making a difference",
    "go the extra mile",
    "give back to the community",
    "passion for making",
)


def _is_fluff_phrase(phrase_lower: str) -> bool:
    """True for aspirational/values fluff that should not surface as a skill."""
    return any(f in phrase_lower for f in _FLUFF_SUBSTRINGS)


def _share_content_token(phrase_a: str, phrase_b: str, *, min_len: int = 4) -> bool:
    """True when any content token (alpha-only, >= ``min_len`` chars) of
    one phrase is a prefix of any content token of the other. This catches
    same-family pairs like ``team`` ↔ ``teamwork`` and ``verbal`` ↔ ``verbal
    communication`` while correctly rejecting cross-family pairs like
    ``compassion`` ↔ ``empathy`` and ``flexible`` ↔ ``adaptability``.

    Used to decide whether a lexicon canonical is from the SAME word family
    as the LLM's surface phrase. Cross-family rewrites are blocked for
    soft skills via this check."""
    a = [t for t in _WORD_FAMILY_TOKEN_RE.findall(phrase_a.lower()) if len(t) >= min_len]
    b = [t for t in _WORD_FAMILY_TOKEN_RE.findall(phrase_b.lower()) if len(t) >= min_len]
    for ta in a:
        for tb in b:
            shorter, longer = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
            if longer.startswith(shorter):
                return True
    return False


def _dedup_keep_order(items: List[str]) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for item in items:
        key = item.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _build_credentials_block(
    req_side: Dict[str, list], pref_side: Dict[str, list]
) -> Dict[str, List[str]]:
    """Assemble the top-level credentials field from post_process sidecars."""
    return {
        "required":    _dedup_keep_order(req_side.get("credential", [])),
        "preferred":   _dedup_keep_order(pref_side.get("credential", [])),
        "eligibility": _dedup_keep_order(
            req_side.get("eligibility", []) + pref_side.get("eligibility", [])
        ),
    }


def _build_job_context(
    req_side: Dict[str, list], pref_side: Dict[str, list]
) -> Dict[str, Any]:
    """Assemble the top-level job_context field from setting labels in sidecars."""
    settings = _dedup_keep_order(
        req_side.get("setting_label", []) + pref_side.get("setting_label", [])
    )
    return {
        "setting":  settings[0] if settings else None,
        "settings": settings,
    }


# Preferred-signal markers in a JD line — when a line containing a credential
# phrase also has one of these words, treat the credential as preferred/desirable
# rather than required.
_PREFERRED_MARKERS: frozenset = frozenset({
    "desirable", "highly desirable", "advantageous", "preferred",
    "highly regarded", "well regarded", "nice to have", "bonus",
    "ideally", "would be an advantage", "an advantage",
})

# Leading filler words trimmed from a captured credential phrase so the surfaced
# value reads as the credential itself ("Minimum Certificate III" → "Certificate III").
_LEADING_CRED_QUALIFIERS: frozenset = frozenset({"minimum", "a", "an", "the"})


def _strip_leading_cred_qualifiers(phrase_display: str) -> str:
    """Drop leading filler words ('minimum', articles) from a credential phrase."""
    words = phrase_display.split()
    while words and words[0].lower().strip(".,;:()") in _LEADING_CRED_QUALIFIERS:
        words = words[1:]
    return " ".join(words)


def _is_vaccination_phrase(phrase_lower: str) -> bool:
    """True for vaccination/immunisation phrases — these are compliance/eligibility
    items, not credentials, so they route to the eligibility list."""
    return (
        "vaccin" in phrase_lower
        or "immunis" in phrase_lower
        or "immuniz" in phrase_lower
    )


def extract_credentials_from_jd(jd_text: str) -> Dict[str, List[str]]:
    """Deterministic scan of JD text for credential and eligibility phrases.

    Returns ``{"required": [...], "preferred": [...], "eligibility": [...]}``.
    Reuses the existing recogniser functions and ``is_noise`` (which covers the
    251 credential + 106 eligibility entries in ``_universal_noise.json``).

    Lines containing preferred-signal markers (``desirable``, ``preferred``,
    etc.) route matching phrases to ``preferred``; otherwise to ``required``.
    Eligibility phrases (working rights, police/NDIS checks, vaccination) route
    to the flat ``eligibility`` list regardless of preferred markers.

    Order-preserving dedup via ``_dedup_keep_order``.
    """
    required: List[str] = []
    preferred: List[str] = []
    eligibility: List[str] = []

    for line in jd_text.splitlines():
        line_stripped = line.strip()
        if not line_stripped:
            continue
        line_lower = line_stripped.lower()

        # A leading "Desirable:"/"Preferred:" heading applies its preferred-signal
        # to every clause on the line; detect it once per line.
        prefix = line_lower.split(":", 1)[0] if ":" in line_lower else ""
        line_prefix_preferred = any(m in prefix for m in _PREFERRED_MARKERS)

        # Split the line into clauses so distinct credentials on one line
        # ("Certificate III, Certificate IV desirable") are classified
        # independently rather than merged into a single greedy phrase.
        for clause in re.split(r"[,;]", line_stripped):
            clause_stripped = clause.strip()
            if not clause_stripped:
                continue
            clause_lower = clause_stripped.lower()

            # Preferred if the line carries a heading marker OR this clause itself
            # contains a preferred marker ("Certificate IV highly desirable").
            is_preferred = line_prefix_preferred or any(
                m in clause_lower for m in _PREFERRED_MARKERS
            )

            # Trim the credential portion at the first preferred marker so marker
            # words ("highly desirable") never bleed into the captured phrase.
            cut = len(clause_stripped)
            for m in _PREFERRED_MARKERS:
                pos = clause_lower.find(m)
                if pos != -1:
                    cut = min(cut, pos)
            scan_text = clause_stripped[:cut].strip()
            if not scan_text:
                continue
            scan_lower = scan_text.lower()

            # Collect candidate phrases via a sliding ngram window (1–8 words) to
            # cover multi-word credentials like "certificate iii in individual
            # support (ageing)".
            words = scan_text.split()
            found_phrases: List[str] = []
            for start in range(len(words)):
                for end in range(start + 1, min(start + 9, len(words) + 1)):
                    phrase = " ".join(words[start:end])
                    phrase_lower = phrase.lower().strip(".,;:()")
                    if not phrase_lower:
                        continue

                    # Route via recognisers — same logic as post_process_skills.
                    # For qualification phrases, trim any trailing prose words
                    # (_QUAL_PATTERN is prefix-only so "cert iii to join our"
                    # also matches; _trim_qual_phrase stops at prose stop words).
                    if _is_qualification_phrase(phrase_lower):
                        found_phrases.append((_trim_qual_phrase(phrase_lower), "credential"))
                        continue
                    if _is_au_unit_code(phrase_lower):
                        found_phrases.append((phrase_lower, "credential"))
                        continue

                    if _is_vehicle_eligibility(phrase_lower):
                        found_phrases.append((phrase_lower, "eligibility"))
                        continue

                    # is_noise covers the static credential/eligibility lists
                    noise_type = is_noise(phrase_lower)
                    if noise_type in ("credential", "eligibility"):
                        found_phrases.append((phrase_lower, noise_type))

            if not found_phrases:
                continue

            # Greedy longest-first, non-overlapping pick within the clause to avoid
            # "police check" AND "national police check" both appearing.
            found_phrases_sorted = sorted(
                found_phrases, key=lambda x: len(x[0]), reverse=True
            )
            used_chars: set = set()
            for phrase_lower, noise_type in found_phrases_sorted:
                idx = scan_lower.find(phrase_lower)
                if idx == -1:
                    continue
                span = set(range(idx, idx + len(phrase_lower)))
                if span & used_chars:
                    continue  # overlaps a longer match already accepted
                used_chars |= span

                phrase_display = scan_text[idx: idx + len(phrase_lower)]
                phrase_display = _strip_leading_cred_qualifiers(phrase_display)
                if not phrase_display:
                    continue

                # Vaccination/immunisation is a compliance item → eligibility,
                # even though the static list tags it as a credential.
                if noise_type == "eligibility" or _is_vaccination_phrase(phrase_lower):
                    eligibility.append(phrase_display)
                elif is_preferred:
                    preferred.append(phrase_display)
                else:
                    required.append(phrase_display)

    return {
        "required":    _dedup_keep_order(required),
        "preferred":   _dedup_keep_order(preferred),
        "eligibility": _dedup_keep_order(eligibility),
    }


def _empty_sidecar() -> Dict[str, list]:
    # Keys are kept SINGULAR to match the source-of-truth NoiseT literals
    # ("credential", "eligibility", "noise") returned by `is_noise()` so the
    # sidecar can be indexed by noise_type directly without a translation map.
    return {
        "credential": [],     # phrases that resolved to noise.credential
        "eligibility": [],    # phrases that resolved to noise.eligibility
        "noise": [],          # phrases that resolved to noise.noise
        "unknown": [],        # vertical-lexicon misses (kept in LLM bucket)
        "moved": [],          # phrase moved between categories by the lexicon
        "setting_label": [],  # phrases stripped as sector/setting descriptors
    }


def post_process_skills(
    skills_by_category: Dict[str, Any],
    *,
    role_family_id: str,
) -> Tuple[Dict[str, List[str]], Dict[str, list]]:
    """Apply lexicon classification to a single skills dict.

    Input  : ``{"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}``
             (the LLM's raw output for one bucket — required or preferred).
    Output : ``(cleaned, sidecar)``.

    Resolution per phrase:
      1. Universal-noise check → if hit, route to sidecar by type and
         REMOVE from skills. Runs for every role family, including master.
      2. If a vertical lexicon applies (tech / nursing / cleaning):
         classify and either KEEP (matches LLM-assigned category) or
         MOVE (canonical category differs from LLM-assigned). The
         phrase is replaced with its canonical form.
      3. If the lexicon doesn't recognise the phrase, it stays in the
         LLM-assigned bucket and is recorded in ``sidecar.unknown``.

    Deduplication is by (canonical_lower, target_category) — so the
    same skill listed under two LLM buckets collapses to one.
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)

    cleaned: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    sidecar = _empty_sidecar()
    seen: set = set()  # (canonical_lower, target_category)

    for cat in _CATEGORIES:
        items = skills_by_category.get(cat) or []
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, str):
                continue
            phrase = raw.strip()
            if not phrase:
                continue

            # 1a. Qualification / student-status phrases — always credentials.
            if _is_qualification_phrase(phrase):
                sidecar["credential"].append(phrase)
                continue

            # 1a'. Australian VET unit codes (HLTHPS007, HLTAID011, CHCCCS015)
            #     — qualification components, route to credentials. Caught
            #     here before noise lookup because they're not in the static
            #     noise lexicon (there are hundreds; pattern is cleaner).
            if _is_au_unit_code(phrase):
                sidecar["credential"].append(phrase)
                continue

            # 1a-veh. Vehicle / driver-licence / car-insurance JD requirements
            #     — eligibility statements, not competencies. Catches state-
            #     prefixed licences ("NSW driver's license"), vehicle-access
            #     phrases ("access to a car with third-party property
            #     insurance"), bare insurance/registration references. Caught
            #     before the static noise lookup because variants outnumber
            #     what's reasonable to enumerate by hand.
            if _is_vehicle_eligibility(phrase):
                sidecar["credential"].append(phrase)
                continue

            # 1a''. Embedded credential markers — the qualification-phrase
            #      and unit-code detectors above are anchored at the START
            #      of the phrase, so they miss embedded markers like
            #      "individual support at certificate iv level" or
            #      "medication endorsement (HLTHPS007 unit)". This scan
            #      catches them anywhere in the phrase and routes to the
            #      credential sidecar so the JD-analysis display stays
            #      clean of credential leakage.
            if _has_credential_marker(phrase):
                sidecar["credential"].append(phrase)
                continue

            phrase_lower = phrase.lower().strip()

            # 1a'''. Sector / setting descriptors — strip from Skills, route
            #       to setting_label sidecar. Symmetric to the CV-side
            #       _ROLE_CATEGORY_LABELS filter in eval/enforce.py.
            #       Containment check catches "residential aged care facility
            #       experience" which has trailing words beyond the bare label.
            if _is_setting_descriptor(phrase_lower):
                sidecar["setting_label"].append(phrase)
                continue

            # 1a'''-fluff. Values/motivational fluff ("making a positive
            #       difference") — drop from Skills, route to the noise sidecar.
            if _is_fluff_phrase(phrase_lower):
                sidecar["noise"].append(phrase)
                continue

            # 1a''''. Bare credential-component labels (fragments of Cert III
            #        in Individual Support / Ageing). These are NOT standalone
            #        credentials — surfacing "individual support" in the
            #        credential block produces a phantom "missing credential".
            #        Drop them to noise: out of Skills AND out of credentials.
            if phrase_lower in _CREDENTIAL_COMPONENT_LABELS:
                sidecar["noise"].append(phrase)
                continue

            # 1b. Universal noise — runs for ALL families. A phrase here
            #    is never a skill regardless of vertical.
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue

            # 1c. Language entries ("Cantonese language", "Greek-speaking")
            #     must NOT land in the clinical/care domain_knowledge bucket.
            #     Force them to `technical` (renders as Other Skills in
            #     nursing) regardless of where the LLM put them. Recorded in
            #     `moved` when category actually changed.
            if _looks_like_language(phrase):
                if cat != "technical":
                    sidecar["moved"].append({
                        "phrase": phrase,
                        "from": cat,
                        "to": "technical",
                        "canonical": phrase,
                        "match_kind": "language-pattern",
                    })
                key = (phrase.lower(), "technical")
                if key in seen:
                    continue
                seen.add(key)
                cleaned["technical"].append(phrase)
                continue

            # 2. Vertical lexicon (when applicable).
            target_cat = cat
            display = phrase
            if vertical is not None:
                c = classify(phrase, vertical)  # type: ignore[arg-type]
                if c is not None and c.is_skill:
                    target_cat = c.category  # type: ignore[assignment]
                    # For SOFT SKILLS we PRESERVE the LLM's surface phrase
                    # when the lexicon canonical is from a DIFFERENT word
                    # family (e.g. "compassion" → canonical "empathy",
                    # "flexible" → "adaptability"). Cross-family rewrites
                    # contradict the JD-analysis prompt's verbatim rule and
                    # break tailored-CV matching to the JD's actual wording.
                    #
                    # Within-family canonicalisation is still fine
                    # ("effective verbal communication" → "verbal
                    # communication"; "ability to work in a team" →
                    # "teamwork" — both share a content token).
                    if (
                        cat == "soft_skills"
                        and target_cat == "soft_skills"
                        and not _share_content_token(phrase, c.canonical)
                    ):
                        display = phrase  # preserve verbatim (cross-family)
                    else:
                        display = c.canonical
                    if target_cat != cat:
                        sidecar["moved"].append({
                            "phrase": phrase,
                            "from": cat,
                            "to": target_cat,
                            "canonical": c.canonical,
                            "match_kind": c.match_kind,
                        })
                else:
                    # 3. Unknown — keep the LLM phrase in its bucket but
                    #    flag for visibility (so the lexicon can grow).
                    sidecar["unknown"].append({"phrase": phrase, "category": cat})

            # 2b. Re-check sector / credential-component after lexicon
            # canonicalisation. The lexicon collapses variants like "home
            # care support" → canonical "home care", "individualised
            # support" → "individual support" — those canonicals are
            # exactly the labels we need to strip, but step 1a' could only
            # see the LLM's surface phrase. Catch them now.
            canon_lower = display.lower()
            if _is_setting_descriptor(canon_lower):
                sidecar["setting_label"].append(phrase)
                continue
            if canon_lower in _CREDENTIAL_COMPONENT_LABELS:
                sidecar["noise"].append(phrase)
                continue

            key = (display.lower(), target_cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[target_cat].append(display)

    return cleaned, sidecar


# ---------------------------------------------------------------------------
# JD-body lexicon scan — surface canonical care/domain skills the LLM missed.
# ---------------------------------------------------------------------------
#
# The JD analysis prompt is IT-centric (its only `domain_knowledge` examples
# are GDPR / data warehouse / IFRS / agile / B2B SaaS). On a prose-heavy
# nursing JD that says "support residents with daily personal care and
# companionship" in RESPONSIBILITIES, the LLM frequently fails to extract
# "personal care", "companionship", "aged care" etc. into
# required_skills.domain_knowledge.
#
# That empty bucket combined with the presence-aware ATS redistribution
# (commits 1dbf4a6 + 8c87f56) makes nursing scores swing 20+ points based on
# AI variance alone — same JD, same CV, different runs.
#
# This deterministic scan closes the variance by surfacing any nursing-
# lexicon canonical that literally appears in jd_text / summary /
# responsibilities. Canonicals already extracted under any bucket are
# skipped. Capped to keep below the JD schema's 10-per-bucket ceiling.
#
# Vertical-gated — only fires for verticals with a curated lexicon (today:
# nursing/tech/cleaning). Tech JDs rarely have this problem because the
# prompt's examples are IT-flavoured already; the scan is safe there too
# but mostly a no-op.

# Word characters that can occur INSIDE a lexicon phrase. Used to choose
# the boundary regex — `\b` is fine for plain words but the default behaviour
# treats hyphens as boundaries, which is correct here (we look up the literal
# phrase, hyphenated entries work because their internal '-' is matched
# literally and `\b` anchors at the outer ends).
_JD_BODY_SCAN_CAP: int = 10  # max canonicals to inject; mirrors schema limit
_MAX_PHRASE_TOKENS: int = 6  # skip very-long lexicon phrases (rarely literal)


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
"""When evidence is not a verbatim substring, accept if its first N tokens
appear as a substring — tolerates trivial whitespace/punctuation drift."""


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
    skill_tokens = [t for t in re.findall(r"[a-z][a-z\-]*", skill_norm) if len(t) > 3]
    if not skill_tokens:
        # very short skill (e.g. "sql") — fall back to ANY token
        skill_tokens = re.findall(r"[a-z][a-z\-]*", skill_norm)
    for tok in skill_tokens:
        if not tok:
            continue
        if tok in evidence_norm:
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

    blob = _ground_blob(jd_text)
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


# Coordination-expansion — "written and verbal communication" → expands to
# also include "written communication" and "verbal communication" as separate
# scannable phrases so the lexicon recall floor can match each modifier.
# Narrowly scoped to the communication modifier family to avoid false positives
# (e.g. "manual handling and infection control" must NOT expand).
_COORD_COMM_RE = re.compile(
    r"\b(written|verbal|oral|interpersonal)\s+and\s+(written|verbal|oral|interpersonal)"
    r"\s+(communication)\b",
    re.IGNORECASE,
)


def _expand_coordinated_modifiers(text: str) -> str:
    """Append expanded forms for coordinated communication modifiers.

    "written and verbal communication skills" → appends
    " written communication verbal communication" so both variants are
    reachable by a `\b…\b` regex search.
    """
    extras: List[str] = []
    for m in _COORD_COMM_RE.finditer(text):
        mod1, mod2, head = m.group(1), m.group(2), m.group(3)
        extras.append(f"{mod1.lower()} {head.lower()}")
        extras.append(f"{mod2.lower()} {head.lower()}")
    if extras:
        return text + " " + " ".join(extras)
    return text


def _scan_text(jd_text: str, summary: Optional[str], responsibilities: Any) -> str:
    """Combine jd_text + structured summary + responsibilities into one
    lowercase scannable blob. Unicode dash-likes are normalised to '-' so
    hyphenated lexicon canonicals match smart-punctuation JDs."""
    parts: List[str] = []
    if jd_text:
        parts.append(jd_text)
    if summary:
        parts.append(str(summary))
    if isinstance(responsibilities, list):
        parts.extend(str(r) for r in responsibilities if r)
    text = " ".join(parts).lower()
    # Normalise unicode dash variants (matches classifier.normalise)
    for ch in "‐‑‒–—−":
        text = text.replace(ch, "-")
    # Expand coordinated communication modifiers so "written and verbal
    # communication" also matches "written communication" in the lexicon scan.
    text = _expand_coordinated_modifiers(text)
    return text


def _already_extracted_canonicals(
    jd_analysis: Dict[str, Any], vertical: str
) -> set:
    """Return the set of CANONICAL forms (lowercased) already present in any
    of the LLM's extracted buckets, so the scan never re-adds something the
    LLM already surfaced (in any category, required or preferred)."""
    seen: set = set()
    for side_key in ("required_skills", "preferred_skills"):
        block = jd_analysis.get(side_key) or {}
        for cat in _CATEGORIES:
            for kw in (block.get(cat) or []):
                if not isinstance(kw, str):
                    continue
                c = classify(kw, vertical)  # type: ignore[arg-type]
                if c is not None and c.is_skill:
                    seen.add(c.canonical.lower())
                else:
                    seen.add(kw.strip().lower())
    return seen


# Per-bucket caps for the recall floor. Mirror the prompt schema's caps so
# we never push past what downstream consumers expect.
_BUCKET_CAPS: Dict[str, int] = {
    "technical":        15,
    "soft_skills":      10,
    "domain_knowledge": 10,
}


def enrich_required_skills_from_jd_body(
    jd_analysis: Dict[str, Any],
    jd_text: str,
    *,
    role_family_id: str,
    skill_text: Optional[str] = None,
) -> Dict[str, Any]:
    """Deterministic recall floor — surface canonical skills the LLM missed
    by scanning the JD body against the per-vertical lexicon.

    Scans ALL THREE buckets (technical / soft_skills / domain_knowledge),
    not just domain_knowledge. This is the safety net behind the JD-analysis
    LLM call: it stops the per-run variance ("got 7 skills this run, 2 next
    run") and stops paraphrase misses ("commitment to allocated shifts" →
    `reliability` is in the lexicon as a variant, so it always lands).

    Per-bucket cap matches the prompt schema (`_BUCKET_CAPS`). No-op when
    the role family has no curated vertical lexicon, when there is no text
    to scan, or when no new canonical matches.

    ``skill_text`` (optional): when supplied, the lexicon scan runs over this
    text instead of the full ``jd_text``. The orchestrator passes the
    pre-filtered JD (boilerplate sections stripped) so the recall floor no
    longer matches lexicon canonicals that appear only in About-Us / benefits
    / reporting-structure prose — the classic source of false positives like
    "reporting to registered nurse" or a provider's cross-service portfolio
    leaking into required skills. ``jd_text`` is retained for the no-op /
    presence guards and as the fallback when ``skill_text`` is empty.
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    if vertical is None:
        return jd_analysis

    text = _scan_text(
        skill_text if (skill_text and skill_text.strip()) else jd_text,
        jd_analysis.get("summary"),
        jd_analysis.get("responsibilities"),
    )
    if not text.strip():
        return jd_analysis

    already = _already_extracted_canonicals(jd_analysis, vertical)
    lookup = _VERTICAL_LOOKUPS.get(vertical) or {}  # type: ignore[arg-type]

    # Group by (bucket, canonical) so the first-matching variant wins and
    # we never consider the same canonical twice per bucket.
    by_bucket_canonical: Dict[str, Dict[str, List[str]]] = {
        cat: {} for cat in _CATEGORIES
    }
    for norm_phrase, (canonical, cat) in lookup.items():
        if cat not in _CATEGORIES:
            continue
        # Soft-skill recall is allowed ONLY when the canonical tokens are
        # literally present in the matched surface phrase (same word family).
        # Cross-family canonicalisation ("compassionate" → "empathy",
        # "flexible" → "adaptability") is still blocked by the token-subset
        # check applied in the injection loop below — so "written
        # communication" and "verbal communication" can be recalled while
        # "caring nature" → "empathy" cannot.
        canon_lower = canonical.lower()
        if canon_lower in already:
            continue
        # Skip sector / setting labels and credential components — the
        # post-process layer strips them from LLM extractions, so the
        # recall floor must not re-inject them via the vertical lexicon.
        if _is_setting_descriptor(canon_lower):
            continue
        if canon_lower in _CREDENTIAL_COMPONENT_LABELS:
            continue
        if len(norm_phrase.split()) > _MAX_PHRASE_TOKENS:
            continue
        by_bucket_canonical[cat].setdefault(canon_lower, []).append(norm_phrase)

    req_block = jd_analysis.get("required_skills") or {}
    new_req = dict(req_block)
    all_additions: Dict[str, List[str]] = {}

    for cat in _CATEGORIES:
        existing = list(req_block.get(cat) or [])
        slots = max(0, _BUCKET_CAPS[cat] - len(existing))
        if slots <= 0:
            continue
        additions: List[str] = []
        for canon_lower, phrases in by_bucket_canonical[cat].items():
            matched = next(
                (p for p in phrases if re.search(r"\b" + re.escape(p) + r"\b", text)),
                None,
            )
            if matched is None:
                continue
            # Soft-skill guard: only inject when canonical tokens are a subset
            # of the matched-phrase tokens (same word family). Blocks
            # cross-family canonicalisation ("compassionate" → "empathy").
            if cat == "soft_skills" and not set(canon_lower.split()).issubset(
                set(matched.split())
            ):
                continue
            additions.append(lookup[phrases[0]][0])
            if len(additions) >= slots:
                break
        if additions:
            new_req[cat] = (existing + additions)[: _BUCKET_CAPS[cat]]
            all_additions[cat] = additions

    if not all_additions:
        return jd_analysis

    out = dict(jd_analysis)
    out["required_skills"] = new_req

    # E2: write skill_evidence entries for injected canonicals so that
    # verify_skill_evidence (when require_evidence=True) doesn't drop them.
    # The matching phrase from the JD text is the evidence.
    existing_evidence: Dict[str, str] = dict(jd_analysis.get("skill_evidence") or {})
    for cat, additions in all_additions.items():
        for canon in additions:
            key = canon.strip().lower()
            if key not in existing_evidence:
                phrases = by_bucket_canonical[cat].get(key, [])
                matched_phrase = next(
                    (p for p in phrases if re.search(r"\b" + re.escape(p) + r"\b", text)),
                    phrases[0] if phrases else canon,
                )
                existing_evidence[key] = matched_phrase
    if existing_evidence != (jd_analysis.get("skill_evidence") or {}):
        out["skill_evidence"] = existing_evidence

    logger.info(
        "JD-body lexicon scan (vertical=%s, recall-floor): added %s",
        vertical,
        {cat: adds for cat, adds in all_additions.items() if adds},
    )
    return out


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
# clearly RESIDENTIAL, demote off-setting domain keywords from required
# to preferred. We don't drop them entirely — they may still be present
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
    "home": frozenset({
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


# ---------------------------------------------------------------------------
# Section-header clamp — Essential vs Desirable
# ---------------------------------------------------------------------------
#
# Many JDs split candidate requirements under explicit headings:
#   "Essential / Required / Must have / You must have / To be considered:"
#   "Desirable / Preferred / Nice to have / Highly desirable / Bonus:"
#
# The LLM often gets the Required/Preferred split right on the SECTION-LEVEL
# extraction, but slips when an item from one section is verbally similar to
# an item from another (e.g. "Basic computer and smartphone working knowledge"
# under DESIRABLE ends up in required.technical as "computer skills").
#
# This deterministic clamp walks the raw JD text, locates each section's
# body, and for every skill currently in the WRONG bucket relative to the
# section it appears in, MOVES it to the right bucket. Same category
# (technical / soft / domain) preserved. Idempotent.

_SECTION_HEAD_ESSENTIAL = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?\**\s*"
    r"(essential|required|must\s+have|you\s+must\s+have|"
    r"to\s+be\s+considered|requirements?)"
    r"\s*[:\-]?\s*\**\s*$",
)
_SECTION_HEAD_DESIRABLE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?\**\s*"
    r"(desirable|preferred|nice\s+to\s+have|highly\s+desirable|"
    r"bonus|advantageous|would\s+be\s+(?:a\s+)?(?:plus|advantage))"
    r"\s*[:\-]?\s*\**\s*$",
)
# Inline "Essential:" / "Desirable:" prefix on a single line. Captures the
# rest-of-line tail as that section's body when the JD uses the compact
# "Essential: ..." pattern instead of a multi-line section.
_INLINE_ESSENTIAL = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:essential|required|must\s+have)\s*[:\-]\s*(.+)$",
)
_INLINE_DESIRABLE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:desirable|preferred|nice\s+to\s+have|highly\s+desirable)\s*[:\-]\s*(.+)$",
)


def _collect_section_bodies(jd_text: str) -> Tuple[str, str]:
    """Return (essential_blob, desirable_blob) lowercase blobs by scanning
    section headers in ``jd_text``. Inline 'Essential: …' / 'Desirable: …'
    lines also contribute to the relevant blob. Empty string when a section
    isn't present."""
    if not jd_text:
        return "", ""
    lines = jd_text.splitlines()
    essential_parts: List[str] = []
    desirable_parts: List[str] = []
    current: Optional[str] = None
    for line in lines:
        bare = line.strip()
        if not bare:
            continue
        # Inline prefix lines contribute regardless of current section.
        m = _INLINE_ESSENTIAL.match(bare)
        if m:
            essential_parts.append(m.group(1).lower())
            current = "essential"
            continue
        m = _INLINE_DESIRABLE.match(bare)
        if m:
            desirable_parts.append(m.group(1).lower())
            current = "desirable"
            continue
        if _SECTION_HEAD_ESSENTIAL.match(bare):
            current = "essential"
            continue
        if _SECTION_HEAD_DESIRABLE.match(bare):
            current = "desirable"
            continue
        # Section bodies end at a blank line OR a long header-like line. We
        # already skipped blanks; cap by length to avoid running into prose
        # paragraphs. 200 chars is generous for a bullet, restrictive for
        # the "About Us" paragraph that often follows.
        if current and len(bare) <= 200:
            if current == "essential":
                essential_parts.append(bare.lower())
            elif current == "desirable":
                desirable_parts.append(bare.lower())
    return " | ".join(essential_parts), " | ".join(desirable_parts)


def _phrase_in_blob(phrase: str, blob: str) -> bool:
    """True when any content token of ``phrase`` (>3 chars) appears in
    ``blob`` AND the matched span is within a window suggesting the phrase
    really belongs to that section. Approximation — but combined with the
    head/body extraction in ``_collect_section_bodies`` it catches the
    common cases without over-firing on incidental keyword mentions
    elsewhere in the JD."""
    if not phrase or not blob:
        return False
    tokens = [t for t in re.findall(r"[a-z][a-z\-]+", phrase.lower()) if len(t) > 3]
    if not tokens:
        return False
    return any(t in blob for t in tokens)


def clamp_by_jd_sections(
    jd_analysis: Dict[str, Any], jd_text: str,
) -> Dict[str, Any]:
    """Move skills between required ↔ preferred when the JD's Essential /
    Desirable section headers contradict the LLM's bucketing.

    Mutates a shallow copy. No-op when neither section is detected in the
    JD text. Records moves under ``lexicon_meta.section_clamp`` for
    diagnostics."""
    essential_blob, desirable_blob = _collect_section_bodies(jd_text)
    if not essential_blob and not desirable_blob:
        return jd_analysis

    req = dict(jd_analysis.get("required_skills") or {})
    pref = dict(jd_analysis.get("preferred_skills") or {})
    moves: List[Dict[str, str]] = []

    for cat in _CATEGORIES:
        req_items = list(req.get(cat) or [])
        pref_items = list(pref.get(cat) or [])
        new_req: List[str] = []
        new_pref: List[str] = list(pref_items)

        # Required → Preferred when phrase only matches Desirable blob.
        for s in req_items:
            if not isinstance(s, str):
                continue
            in_desirable = desirable_blob and _phrase_in_blob(s, desirable_blob)
            in_essential = essential_blob and _phrase_in_blob(s, essential_blob)
            if in_desirable and not in_essential:
                if s.lower() not in {p.lower() for p in new_pref}:
                    new_pref.append(s)
                moves.append({"skill": s, "from": "required", "to": "preferred", "category": cat})
            else:
                new_req.append(s)

        # Preferred → Required when phrase only matches Essential blob.
        final_pref: List[str] = []
        for s in new_pref:
            if not isinstance(s, str):
                continue
            in_essential = essential_blob and _phrase_in_blob(s, essential_blob)
            in_desirable = desirable_blob and _phrase_in_blob(s, desirable_blob)
            if in_essential and not in_desirable:
                if s.lower() not in {r.lower() for r in new_req}:
                    new_req.append(s)
                moves.append({"skill": s, "from": "preferred", "to": "required", "category": cat})
            else:
                final_pref.append(s)

        req[cat] = new_req
        pref[cat] = final_pref

    if not moves:
        return jd_analysis

    out = dict(jd_analysis)
    out["required_skills"] = req
    out["preferred_skills"] = pref
    meta = dict(out.get("lexicon_meta") or {})
    meta["section_clamp"] = moves
    out["lexicon_meta"] = meta
    logger.info(
        "section clamp: moved %d skill(s) between required/preferred per JD section headers",
        len(moves),
    )
    return out


# ---------------------------------------------------------------------------
# Phase 3 — subsumption dedup
# ---------------------------------------------------------------------------
#
# Some lexicon canonicals are GENERIC parents that the LLM extracts alongside
# one or more SPECIFIC children. Example: a nursing JD says "verbal and
# written communication" — the LLM happily emits all three of
# {communication, verbal communication, written communication}. The parent is
# pure redundancy: the children already say everything the parent says, with
# more specificity. Keeping the parent inflates the bucket and dilutes ATS
# match weight per item.
#
# The lexicon declares parent→children via the optional ``subsumes`` field
# on a canonical entry. ``_SUBSUMES`` in classifier.py loads those into
# ``{parent_canonical_lower: {child_canonical_lower, ...}}`` per vertical.
#
# Rule: within ONE bucket, if parent + ≥1 child are both present, drop the
# parent. Parent alone → kept. Cross-bucket presence (parent in required,
# child in preferred) is a deliberate non-action: those are different
# urgencies, not a redundancy.

# Parents where collapsing 2+ specific children → parent is recruiter-friendly
# (the parent is the term ATS / recruiters scan for and the specifics are
# micro-tasks that belong under the umbrella). Exclude:
#   • 'aged care' (children community/home/dementia/palliative are MAJOR care
#     types whose distinct signal matters)
#   • 'communication' (verbal vs written are recognised distinct soft skills
#     and tests + recruiters explicitly want both)
_ROLL_UP_PARENTS: frozenset = frozenset({
    "personal care",      # showering/bathing, dressing/grooming, toileting,
                          # feeding, continence — all ADL micro-tasks
    "care planning",      # individual planning process is just one variant
})


def _collapse_children_to_parent(
    jd_analysis: Dict[str, Any], vertical: Optional[str], *, min_children: int = 2,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Roll up ≥`min_children` specific canonicals into their umbrella parent
    when the parent itself is NOT present in the same bucket.

    Recruiter-friendly direction: an LLM that emits "showering and bathing",
    "dressing and grooming", "toileting assistance" gets a single canonical
    "personal care" — the term recruiters actually scan for. Limited via
    `_ROLL_UP_PARENTS` to canonicals where collapse is unambiguously good
    (excludes 'aged care' / 'communication' where children carry distinct
    signal worth preserving).
    """
    if vertical is None:
        return jd_analysis, []
    sub_map = _SUBSUMES.get(vertical) or {}  # type: ignore[arg-type]
    if not sub_map:
        return jd_analysis, []

    # parent → set(children_lower)
    rollups: List[Dict[str, Any]] = []
    out = dict(jd_analysis)

    for side in ("required_skills", "preferred_skills"):
        block = dict(out.get(side) or {})
        for cat in _CATEGORIES:
            items = list(block.get(cat) or [])
            if len(items) < min_children:
                continue
            present_lower = {s.strip().lower() for s in items if isinstance(s, str)}
            for parent_lower, children_lower in sub_map.items():
                if parent_lower not in _ROLL_UP_PARENTS:
                    continue          # opt-in list — most parents preserve children
                if parent_lower in present_lower:
                    continue          # parent already there — dedup handles it
                children_here = present_lower & children_lower
                if len(children_here) < min_children:
                    continue
                # Roll up: drop these children, insert the parent canonical.
                items = [s for s in items if isinstance(s, str) and s.strip().lower() not in children_here]
                items.append(parent_lower)
                present_lower = present_lower - children_here
                present_lower.add(parent_lower)
                rollups.append({
                    "side": side, "bucket": cat,
                    "parent": parent_lower,
                    "children_collapsed": sorted(children_here),
                })
            block[cat] = items
        out[side] = block

    return out, rollups


def _dedupe_by_subsumption(
    jd_analysis: Dict[str, Any], vertical: Optional[str],
) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """Drop generic parent canonicals when ≥1 child is in the same bucket.

    Returns ``(mutated_copy, removed)``. ``removed`` lists the drops as
    ``{bucket, side, parent, children_present}`` dicts for diagnostics.
    No-op when the vertical has no subsumption map or no entries to drop.
    """
    if vertical is None:
        return jd_analysis, []
    sub_map = _SUBSUMES.get(vertical) or {}  # type: ignore[arg-type]
    if not sub_map:
        return jd_analysis, []

    removed: List[Dict[str, str]] = []
    out = dict(jd_analysis)

    for side in ("required_skills", "preferred_skills"):
        block = dict(out.get(side) or {})
        for cat in _CATEGORIES:
            items = list(block.get(cat) or [])
            if not items:
                continue
            # Build a case-insensitive index of what's in this bucket.
            present_lower = {s.strip().lower() for s in items if isinstance(s, str)}
            kept: List[str] = []
            for s in items:
                if not isinstance(s, str):
                    continue
                key = s.strip().lower()
                children = sub_map.get(key)
                if children and (children & present_lower):
                    removed.append({
                        "side": side, "bucket": cat,
                        "parent": s,
                        "children_present": sorted(children & present_lower),
                    })
                    continue
                kept.append(s)
            block[cat] = kept
        out[side] = block

    return out, removed


def post_process_jd_analysis(
    jd_analysis: Dict[str, Any],
    *,
    role_family_id: str,
) -> Dict[str, Any]:
    """Apply lexicon post-processing to a complete JD-analysis result.

    Mutates a shallow copy: ``required_skills`` and ``preferred_skills``
    are replaced with the lexicon-cleaned versions, and a new
    ``lexicon_meta`` field is attached containing the per-bucket
    sidecar (for downstream routing and diagnostics).

    Runs the conditional-clause demoter FIRST so any "X or willingness to
    apply" required entries are moved to preferred BEFORE per-bucket
    classification / dedup runs. Subsumption dedup runs LAST so it sees
    the final canonicalised set.
    """
    # Demote conditional REQUIRED entries to PREFERRED — must run before
    # post_process_skills() because the demoter moves entries BETWEEN buckets
    # (required ↔ preferred), which the per-bucket cleaner can't do.
    jd_analysis = _demote_conditional_required_to_preferred(jd_analysis)

    out = dict(jd_analysis)  # shallow copy — JSON-roundtrippable anyway

    req_clean, req_side = post_process_skills(
        out.get("required_skills") or {}, role_family_id=role_family_id,
    )
    pref_clean, pref_side = post_process_skills(
        out.get("preferred_skills") or {}, role_family_id=role_family_id,
    )

    out["required_skills"] = req_clean
    out["preferred_skills"] = pref_clean

    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    # Roll up specific children → parent canonical when ≥2 specific siblings
    # appear without their umbrella term ("showering and bathing", "dressing
    # and grooming" → "personal care"). Runs BEFORE dedup so the new parent
    # entry has a chance to participate in subsequent passes.
    out, rolled_up = _collapse_children_to_parent(out, vertical)
    out, subsumed = _dedupe_by_subsumption(out, vertical)

    # Cross-bucket dedup — same canonical (case-insensitive) in both
    # required and preferred means the LLM emitted it twice from two
    # different bits of JD prose. Required wins; drop the preferred copy.
    # Same category required.
    req_blk = dict(out.get("required_skills") or {})
    pref_blk = dict(out.get("preferred_skills") or {})
    cross_dropped: List[str] = []
    for cat in _CATEGORIES:
        req_lower = {s.lower() for s in (req_blk.get(cat) or []) if isinstance(s, str)}
        if not req_lower:
            continue
        kept_pref: List[str] = []
        for s in (pref_blk.get(cat) or []):
            if isinstance(s, str) and s.lower() in req_lower:
                cross_dropped.append(f"{cat}:{s}")
                continue
            kept_pref.append(s)
        pref_blk[cat] = kept_pref
    if cross_dropped:
        out["preferred_skills"] = pref_blk
        logger.info(
            "cross-bucket dedup: dropped %d duplicate(s) from preferred "
            "(already present in required): %s",
            len(cross_dropped), cross_dropped,
        )

    # Preserve any prior lexicon_meta entries (e.g. ``ungrounded`` written
    # by verify_skill_evidence). Merging instead of overwriting keeps the
    # full diagnostic trail visible downstream.
    prior_meta = dict(jd_analysis.get("lexicon_meta") or {})
    prior_meta.update({
        "role_family": role_family_id,
        "vertical": vertical,
        "required": req_side,
        "preferred": pref_side,
        "subsumed": subsumed,
    })
    out["lexicon_meta"] = prior_meta

    # Surface credentials and job-context as first-class output fields so
    # the UI and future ATS scorer can consume them without digging into
    # lexicon_meta internals.
    out["credentials"] = _build_credentials_block(req_side, pref_side)
    out["job_context"] = _build_job_context(req_side, pref_side)

    # Single concise log line summarising what changed. Useful when
    # something looks off in a production run — quick to spot whether
    # the lexicon dropped/moved anything material.
    n_dropped = (len(req_side["credential"]) + len(req_side["eligibility"]) + len(req_side["noise"])
                 + len(pref_side["credential"]) + len(pref_side["eligibility"]) + len(pref_side["noise"]))
    n_moved = len(req_side["moved"]) + len(pref_side["moved"])
    n_unknown = len(req_side["unknown"]) + len(pref_side["unknown"])
    if n_dropped or n_moved or n_unknown:
        logger.info(
            "lexicon post-process (family=%s): dropped %d non-skill, moved %d, %d unknown",
            role_family_id, n_dropped, n_moved, n_unknown,
        )

    return out


def post_process_cv_skills(
    cv_skills: Dict[str, Any],
) -> Tuple[Dict[str, List[str]], Dict[str, list]]:
    """CV-side variant: apply ONLY the universal-noise filter.

    The CV categoriser produces buckets without knowing the vertical
    (it's run at upload time, no JD context). Applying a vertical
    lexicon here would require guessing the candidate's primary
    vertical — the LLM already does a decent job on the CV side
    (current symptom of the bug is on the JD side). So we just strip
    universal noise (credentials/eligibility/values) and trust the
    LLM's bucketing. Dedupes case-insensitively.

    Sidecar shape matches ``post_process_skills`` (credentials /
    eligibility / noise populated; moved + unknown stay empty
    because no vertical lexicon was applied).
    """
    cleaned: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    sidecar = _empty_sidecar()
    seen: set = set()
    for cat in _CATEGORIES:
        items = cv_skills.get(cat) or []
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, str):
                continue
            phrase = raw.strip()
            if not phrase:
                continue
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue
            key = (phrase.lower(), cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[cat].append(phrase)
    return cleaned, sidecar
