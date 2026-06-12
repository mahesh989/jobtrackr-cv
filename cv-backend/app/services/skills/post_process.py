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


def _empty_sidecar() -> Dict[str, list]:
    # Keys are kept SINGULAR to match the source-of-truth NoiseT literals
    # ("credential", "eligibility", "noise") returned by `is_noise()` so the
    # sidecar can be indexed by noise_type directly without a translation map.
    return {
        "credential": [],   # phrases that resolved to noise.credential
        "eligibility": [],  # phrases that resolved to noise.eligibility
        "noise": [],        # phrases that resolved to noise.noise
        "unknown": [],      # vertical-lexicon misses (kept in LLM bucket)
        "moved": [],        # phrase moved between categories by the lexicon
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
                    display = c.canonical
                    target_cat = c.category  # type: ignore[assignment]
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

    # (a) direct token overlap, OR 4-char prefix match for compound tokens.
    # The prefix path catches single-word compounds where the JD uses one
    # half: "teamwork" ← evidence "works well as part of a team"
    # ("team" is a 4-char prefix of "teamwork" with a word boundary in
    # evidence). Width-4 is a deliberate floor: anything shorter (e.g. 3-char
    # prefix "tea") would over-accept.
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

    # (b) lexicon synonym mapping (vertical-aware)
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
) -> Dict[str, Any]:
    """Drop skills whose evidence quote is not in the JD body or whose
    skill cannot be derived from the quote.

    No-op when ``jd_analysis["skill_evidence"]`` is missing or empty
    (back-compat with older AI runs that didn't emit evidence).

    Mutates a shallow copy. Drops are recorded under
    ``lexicon_meta.ungrounded`` as a list of
    ``{"skill", "bucket", "evidence", "reason"}`` dicts.
    """
    evidence_map = jd_analysis.get("skill_evidence") or {}
    if not isinstance(evidence_map, dict) or not evidence_map:
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
                if not _skill_derivable_from_evidence(skill, evidence_norm, vertical):
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
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    if vertical is None:
        return jd_analysis

    text = _scan_text(
        jd_text,
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
        canon_lower = canonical.lower()
        if canon_lower in already:
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
            if any(
                re.search(r"\b" + re.escape(p) + r"\b", text) for p in phrases
            ):
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
    # Other settings could be added later; conservative for now.
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
    out, subsumed = _dedupe_by_subsumption(out, vertical)

    out["lexicon_meta"] = {
        "role_family": role_family_id,
        "vertical": vertical,
        "required": req_side,
        "preferred": pref_side,
        "subsumed": subsumed,
    }

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
