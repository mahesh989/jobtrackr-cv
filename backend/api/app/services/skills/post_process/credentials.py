"""Credential / qualification phrase recognition and JD credential extraction.

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
    is_noise,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
from ._common import logger
from .grounding import _ground_norm

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
    # Prose adjectives/verbs that signal the credential NAME has ended and a
    # sentence tail has begun ("Bachelor of Nursing and ready to start",
    # "Diploma of Nursing or equivalent and keen to learn").
    "ready", "able", "available", "eager", "keen", "enthusiastic",
    "willing", "interested", "ideally", "preferred", "desirable",
    "essential", "plus", "advantageous", "looking", "seeking",
    "wanting", "equivalent", "must", "should", "able-bodied",
})


# Connector / filler words that must never be the LAST token of a captured
# credential. After trimming the prose tail we strip these so we never leave a
# dangling "...Bachelor of Nursing and" / "...or" / "...with".
_CRED_TAIL_CONNECTORS: frozenset = frozenset({
    "and", "or", "with", "for", "to", "in", "of", "a", "an", "the",
    "at", "on", "by", "&", "plus",
})


# Terminators that end a credential clause when they appear INSIDE a tail token
# (the matching open-paren may be absent in malformed JD text). Comma is
# deliberately excluded — it occurs within real credential names.
_CRED_TAIL_TERMINATOR_RE = re.compile(r"[).;:]")


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
        # A closing paren, sentence period, semicolon or colon inside the token
        # marks the end of the credential clause — even when the matching "("
        # is absent (malformed JD text like "...Individual Support). Strong …").
        # Keep the clean prefix before the terminator, drop everything after,
        # and stop. Commas are NOT terminators (e.g. "ageing, home and community"
        # is part of the credential name).
        mterm = _CRED_TAIL_TERMINATOR_RE.search(w)
        if mterm:
            prefix = w[: mterm.start()].strip(".,;:()")
            if prefix:
                allowed.append(prefix)
            break
        allowed.append(w)
    # Drop any trailing connector/filler tokens so we never leave a dangling
    # "...Nursing and" / "...or" once the prose tail was trimmed.
    while allowed and allowed[-1].strip(".,;:()&").lower() in _CRED_TAIL_CONNECTORS:
        allowed.pop()
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


def _clean_credential_phrase(phrase: str) -> str:
    """Normalise a credential phrase routed to the sidecar so BOTH capture
    paths (the JD-body scan and the LLM-skills sidecar) emit clean values.

    Strips leading filler ('minimum', articles) and any dangling trailing
    connector/punctuation ('Cert IV Med Comp Training - Emerging &' →
    'Cert IV Med Comp Training - Emerging'). Idempotent.
    """
    p = _strip_leading_cred_qualifiers(phrase.strip())
    words = p.split()
    while words and words[-1].strip(".,;:()&/-").lower() in _CRED_TAIL_CONNECTORS:
        words.pop()
    return " ".join(words).strip(" .,;:-&/")


def _is_vaccination_phrase(phrase_lower: str) -> bool:
    """True for vaccination/immunisation phrases — these are compliance/eligibility
    items, not credentials, so they route to the eligibility list."""
    return (
        "vaccin" in phrase_lower
        or "immunis" in phrase_lower
        or "immuniz" in phrase_lower
    )


# ---------------------------------------------------------------------------
# Offer-vs-obligation verb arbiter (Layer 3)
# ---------------------------------------------------------------------------
# Section structure tells us WHERE a phrase sits; these verbs tell us whether a
# line states something the employer OFFERS (a perk — "Cert IV training
# provided", "scholarships on offer") versus something it OBLIGATES the
# candidate to hold ("must hold a current First Aid certificate", "required
# before commencement"). The obligation signal OVERRIDES section/offer — a
# genuine mandatory credential inside a benefits block is still kept; an
# offer-phrased credential is dropped even when section detection missed it
# (the fallback / unstructured-JD safety net).

_OFFER_VERB_RE = re.compile(
    r"(?ix)\b("
    r"provided\b|on\s+offer\b|we\s+(?:provide|offer)\b|on\s+completion\b|"
    r"access\s+to\b|reimburse(?:d|ment)?\b|"
    r"scholarships?\b|study\s+support\b|salary\s+packaging\b|"
    r"career\s+development\b|development\s+pathways?\b|"
    r"training\s+(?:provided|on\s+offer|available|opportunities)\b|"
    r"learning\s+(?:and\s+development|opportunities)\b"
    r")"
)

_OBLIGATION_RE = re.compile(
    r"(?ix)\b("
    r"must\s+(?:have|hold|complete|possess|obtain|undergo|be)\b|"
    r"required\b|essential\b|mandatory\b|"
    r"you\s+(?:will|must)\s+(?:have|need|hold|complete|possess|obtain)\b|"
    r"need\s+to\s+(?:have|hold|complete|obtain)\b|"
    r"applicants?\s+must\b|all\s+applicants\b|"
    r"before\s+commencement\b|prior\s+to\s+(?:commencement|starting|start)\b|"
    r"within\s+\d+\s*(?:months?|weeks?|days?)\b"
    r")"
)


_LEADING_BULLET_RE = re.compile(r"^[\s\-\*•○◦→►▪▶✔✓☑✅◆●♦️]+")


def _line_is_offer_only(line: str) -> bool:
    """True when a line states a PERK the employer offers and carries NO
    obligation marker — i.e. a credential/skill on this line is something
    provided, not something required of the candidate. Obligation wins ties."""
    if not line:
        return False
    if _OBLIGATION_RE.search(line):
        return False
    return bool(_OFFER_VERB_RE.search(line))


def extract_credentials_from_jd(
    jd_text: str,
    *,
    boilerplate_blob: str = "",
    drops_out: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, List[str]]:
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
        # Strip a leading bullet glyph (incl. the ✔/✓/✅ family the emoji
        # normaliser leaves) so it never bleeds into a captured credential.
        line_stripped = _LEADING_BULLET_RE.sub("", line.strip())
        if not line_stripped:
            continue
        line_lower = line_stripped.lower()

        # Layer 3 — offer-vs-obligation: a perk line ("Cert IV training
        # provided", "scholarships on offer") states something the employer
        # offers, not a candidate requirement. Skip required/preferred harvest
        # for it (eligibility is always obligation-shaped so it still flows).
        # An obligation marker on the same line overrides and keeps it.
        line_is_offer = _line_is_offer_only(line_stripped)

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
            found_phrases: List[Tuple[str, str]] = []
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
                # Clean both ends: leading filler ('minimum') AND dangling
                # trailing connectors/punctuation ('Individual Support /',
                # 'Emerging &') left by the ngram-window cut.
                phrase_display = _clean_credential_phrase(phrase_display)
                if not phrase_display:
                    continue

                # Vaccination/immunisation is a compliance item → eligibility,
                # even though the static list tags it as a credential.
                if noise_type == "eligibility" or _is_vaccination_phrase(phrase_lower):
                    eligibility.append(phrase_display)
                    continue
                # Layer 3 — drop a credential merely OFFERED on a perk line.
                if line_is_offer:
                    if drops_out is not None:
                        drops_out.append(
                            {"phrase": phrase_display, "reason": "offer_line"}
                        )
                    continue
                # Belt-and-suspenders — drop a credential whose support is a
                # boilerplate section the cleaner failed to strip (branded
                # heading). _ground_norm keeps this byte-compatible with the
                # blob built from the discarded section_map.
                if boilerplate_blob and _ground_norm(phrase_display) in boilerplate_blob:
                    if drops_out is not None:
                        drops_out.append(
                            {"phrase": phrase_display, "reason": "boilerplate_only"}
                        )
                    continue
                if is_preferred:
                    preferred.append(phrase_display)
                else:
                    required.append(phrase_display)

    return {
        "required":    _dedup_keep_order(required),
        "preferred":   _dedup_keep_order(preferred),
        "eligibility": _dedup_keep_order(eligibility),
    }
