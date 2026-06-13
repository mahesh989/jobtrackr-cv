"""Body spelling + heading title-case — extracted from writers._impl.

Deterministic, case-preserving British/Australian spelling normalisation of body
prose (summary, bullets, education, award descriptions) and proper title-casing
of italic role/heading lines. Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

_BR_AM_BODY_SUBS: list[tuple[re.Pattern, str]] = [
    # -ize / -ized / -izing / -ization → -ise / -ised / -ising / -isation
    # Curated word list rather than blanket suffix so we don't break "size",
    # "prize", "seize", etc.
    (re.compile(r"\bspecializ(e[ds]?|ing|ation)\b", re.IGNORECASE), "specialis"),
    (re.compile(r"\borganiz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "organis"),
    (re.compile(r"\bindividualiz(e[ds]?|ing|ation)\b", re.IGNORECASE), "individualis"),
    (re.compile(r"\bpersonaliz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "personalis"),
    (re.compile(r"\boptimiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "optimis"),
    (re.compile(r"\brealiz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "realis"),
    (re.compile(r"\bcategoriz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "categoris"),
    (re.compile(r"\bprioritiz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "prioritis"),
    (re.compile(r"\bstandardiz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "standardis"),
    (re.compile(r"\bmodernis(e[ds]?|ing|ation)\b", re.IGNORECASE),     "modernis"),
    (re.compile(r"\bemphasiz(e[ds]?|ing)\b", re.IGNORECASE),           "emphasis"),
    (re.compile(r"\bcustomiz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "customis"),
    (re.compile(r"\bauthoriz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "authoris"),
    (re.compile(r"\bsynthesiz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "synthesis"),
    (re.compile(r"\butiliz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "utilis"),
    (re.compile(r"\bminimiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "minimis"),
    (re.compile(r"\bmaximiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "maximis"),
    (re.compile(r"\banalyz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "analys"),
    (re.compile(r"\brecogniz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "recognis"),
    # -or → -our (curated to avoid false hits on "actor", "doctor", "factor")
    (re.compile(r"\bcolor(s|ed|ing|ful)?\b", re.IGNORECASE),  "colour"),
    (re.compile(r"\bbehavior(s|al|ally)?\b", re.IGNORECASE),  "behaviour"),
    (re.compile(r"\bfavor(s|ed|ing|ite|able|ably)?\b", re.IGNORECASE), "favour"),
    (re.compile(r"\bhonor(s|ed|ing|able|ably)?\b", re.IGNORECASE),     "honour"),
    (re.compile(r"\blabor(s|ed|ing|ious)?\b", re.IGNORECASE),          "labour"),
    # -er → -re (curated)
    (re.compile(r"\bcenter(s|ed|ing)?\b", re.IGNORECASE),  "centre"),
    # Other common spelling pairs
    (re.compile(r"\benrol(l)(ed|ing|ment)\b", re.IGNORECASE),  "enrol"),  # double-l → single (UK)
    (re.compile(r"\bfulfil(l)(ed|ing|ment)\b", re.IGNORECASE), "fulfil"),
    (re.compile(r"\bskillful\b", re.IGNORECASE),               "skilful"),
    (re.compile(r"\benroll\b", re.IGNORECASE),                 "enrol"),
]


def _case_preserve_replace(match: "re.Match", british_lower: str) -> str:
    """Apply case style of the matched substring to the British canonical.
    Suffix-extending substitutions (-ize family) keep the matched suffix
    intact: 'Specialized' → 'Specialised' (match='Specialized', british_lower
    ='specialis', captured suffix='ed' → 'Specialised')."""
    matched = match.group(0)
    # For substitutions that capture a tail group (the -ize family), splice
    # the tail back in. Otherwise the british_lower is the full replacement.
    suffix = ""
    if match.groups():
        # Use group(1) verbatim if present (e.g. "ed", "ing", "ation").
        captured = match.group(1)
        if captured:
            suffix = captured.lower()
    full_lower = british_lower + suffix
    # Detect case style of the matched word.
    if matched.isupper():
        return full_lower.upper()
    if matched[0].isupper():
        return full_lower[0].upper() + full_lower[1:]
    return full_lower


def canonicalise_body_spelling(markdown: str) -> str:
    """Apply British/Australian spelling to body text, preserving each
    matched substring's case (lowercase / Capitalised / ALL-CAPS).

    Skips:
      • Fenced code blocks (` ``` … ``` `) — no relevant CV content but
        keeps the pass safe to run on any markdown.
      • Inline code spans (`` `…` ``)
      • The Registration & Licences section's middot-delimited line
        (Already canonical from stamp_credentials.)
    """
    if not markdown:
        return markdown

    lines = markdown.split("\n")
    in_code = False
    out: list[str] = []
    for ln in lines:
        stripped = ln.strip()
        # Fenced code block toggle.
        if stripped.startswith("```"):
            in_code = not in_code
            out.append(ln)
            continue
        if in_code:
            out.append(ln)
            continue
        # Replace OUTSIDE inline-code spans only. Cheap split-on-backtick.
        if "`" in ln:
            parts = ln.split("`")
            for i in range(0, len(parts), 2):  # even indices are non-code
                parts[i] = _apply_body_spelling_subs(parts[i])
            out.append("`".join(parts))
        else:
            out.append(_apply_body_spelling_subs(ln))
    return "\n".join(out)


def _apply_body_spelling_subs(text: str) -> str:
    """Run every body spelling substitution with case-preserving replacement."""
    if not text:
        return text
    for pat, british_lower in _BR_AM_BODY_SUBS:
        text = pat.sub(
            lambda m, _b=british_lower: _case_preserve_replace(m, _b),
            text,
        )
    return text


# ---------------------------------------------------------------------------
# Module 5 — heading title-case normaliser.
#
# Targets italic role / qualification lines and H3 headings. Stop-words that
# should be lowercase in non-leading position. Preserves ALL-CAPS tokens
# (IV, NSW, CPR, RN, AHPRA, NDIS, BSc) and known mixed-case brand names
# (BESTMed, MedMobile, eHealth, iPhone).
# ---------------------------------------------------------------------------

_TITLE_CASE_STOPWORDS: set[str] = {
    "in", "of", "to", "for", "and", "or", "the", "a", "an", "by", "with",
    "on", "at", "as", "but", "nor", "via",
}

# Tokens whose case must be preserved exactly (acronyms, brand names, roman
# numerals, qualifiers). Lowercased for lookup but emitted as the canonical
# stored form.
_PRESERVE_CASE_TOKENS: dict[str, str] = {
    "nsw": "NSW", "vic": "VIC", "qld": "QLD", "wa": "WA", "sa": "SA",
    "act": "ACT", "tas": "TAS", "nt": "NT",
    "iv": "IV", "iii": "III", "ii": "II", "vi": "VI", "vii": "VII", "viii": "VIII",
    "cpr": "CPR", "rn": "RN", "en": "EN", "ain": "AIN",
    "ahpra": "AHPRA", "ndis": "NDIS", "wwcc": "WWCC", "hltaid011": "HLTAID011",
    "uk": "UK", "usa": "USA", "us": "US", "eu": "EU", "uae": "UAE", "anz": "ANZ",
    "bsc": "BSc", "msc": "MSc", "ba": "BA", "ma": "MA", "phd": "PhD",
    "bestmed": "BESTMed", "medmobile": "MedMobile", "leecare": "Leecare",
    "ehealth": "eHealth", "iphone": "iPhone", "ipad": "iPad",
    "sql": "SQL", "aws": "AWS", "gcp": "GCP", "api": "API", "rest": "REST",
}

_TITLE_CASE_LINE_RE = re.compile(
    r"^(\s*\*)([^*]+)(\*\s*)$"  # *...* (italic block, allow trailing whitespace)
)
_H3_HEADING_RE = re.compile(r"^(###\s+)(.*?)(\s*)$")


def _title_case_token(token: str, *, is_first: bool, is_last: bool) -> str:
    """Title-case a single token with the stop-word and preserve-case rules.

    Hyphenated compounds ("Person-Centred", "Co-worker") are title-cased
    segment by segment.
    """
    if not token:
        return token
    # Preserve ALL-CAPS tokens (NSW, IV, CPR…) or known mixed-case brands.
    lower = token.lower()
    if lower in _PRESERVE_CASE_TOKENS:
        return _PRESERVE_CASE_TOKENS[lower]
    # If the token is already ALL-CAPS and contains digits/letters mix (e.g.
    # HLTAID011, ISO27001), preserve as-is.
    if token.isupper() and any(c.isalpha() for c in token):
        return token
    # Hyphenated compound: recurse on each segment.
    if "-" in token:
        segs = token.split("-")
        return "-".join(_title_case_token(s, is_first=False, is_last=False) for s in segs)
    # Stop-word in non-leading/non-trailing position → lowercase.
    if not is_first and not is_last and lower in _TITLE_CASE_STOPWORDS:
        return lower
    # Default: Capitalise first letter, preserve the rest (handles brand-
    # internal capitalisation if any sneaks through).
    return token[0].upper() + token[1:].lower() if len(token) > 1 else token.upper()


def _title_case_phrase(phrase: str) -> str:
    """Title-case a phrase like 'assistant in nursing' → 'Assistant in Nursing'.
    Splits on whitespace; punctuation (commas, parens, pipes) is preserved as
    boundaries."""
    if not phrase or not phrase.strip():
        return phrase

    # Tokenise: keep punctuation as separate tokens so they don't affect
    # is_first/is_last logic per "word".
    tokens = re.findall(r"[\w'-]+|[^\w\s]+|\s+", phrase)
    word_positions = [i for i, t in enumerate(tokens) if re.match(r"[\w'-]+", t)]
    if not word_positions:
        return phrase
    first_word = word_positions[0]
    last_word = word_positions[-1]

    out = []
    for i, t in enumerate(tokens):
        if re.match(r"[\w'-]+", t):
            is_first = (i == first_word)
            is_last = (i == last_word)
            out.append(_title_case_token(t, is_first=is_first, is_last=is_last))
        else:
            out.append(t)
    return "".join(out)


def normalise_heading_title_case(markdown: str) -> str:
    """Title-case italic role/qualification lines (`*…*`).

    Targets the lines we've seen LLM drift on:
      *Assistant In Nursing (Casual) | May 2025 – Present*
      *Bachelor Of Science | Sept 2019 – June 2022*
      *Certificate IV In Ageing Support | May 2025*

    H3 employer/institution lines are deliberately SKIPPED — they're
    proper-noun heavy ("Uniting – The Marion", "Jesmond Miranda Nursing
    Home", "Anglicare Mildred Symons House") where stop-word rules
    don't apply cleanly. Lowercasing "the" in "Uniting – The Marion"
    broke a brand-internal capitalisation (Sprint C hotfix learnt the
    hard way: title-case on H3s is collateral damage, not the target).
    """
    lines = markdown.split("\n")
    out: list[str] = []
    in_code = False
    changed = 0
    for ln in lines:
        if ln.lstrip().startswith("```"):
            in_code = not in_code
            out.append(ln)
            continue
        if in_code:
            out.append(ln)
            continue

        # Italic single-line `*…*` — the only target.
        m = _TITLE_CASE_LINE_RE.match(ln)
        if m:
            prefix, body, suffix = m.groups()
            new_body = _title_case_phrase(body)
            if new_body != body:
                changed += 1
            out.append(prefix + new_body + suffix)
            continue

        # H3 headings deliberately skipped — proper nouns, brand-internal
        # capitalisation must be preserved.
        out.append(ln)

    if changed:
        logger.info("sprint-C title-case: normalised %d italic line(s)", changed)
    return "\n".join(out)
