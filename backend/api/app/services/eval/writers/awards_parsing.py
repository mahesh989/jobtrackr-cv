"""Awards / certifications parsing helpers — extracted from writers._impl.

Low-level, deterministic parsers that turn raw award/certification CV lines into
structured (name, org, date, description) entries and format them back to
Markdown. Behaviour-identical to the originals; the only adaptation is the single
cross-module call (_canonicalise_skill_spelling) is imported lazily at its one
call site to avoid an import cycle with _impl.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Awards-only Certifications → "Awards". The source CV often parks an award
# (e.g. "Staff Excellence Award") under a "Certifications" heading. When every
# entry is an award/recognition and none is an actual credential, relabel the
# heading so it reads honestly. Mixed or cert-bearing sections are left alone.
# ---------------------------------------------------------------------------

_AWARD_RE = re.compile(
    # award/prize/honour/medal/dean's-list/scholarship — exact nouns.
    # Plus recognition/recognised/recognize/recognised — the italic
    # continuation line of two-line H3+italic entries often uses the
    # past-tense verb ("Recognised for hard work…") instead of the noun,
    # and without it, the all() check rejects the entry as non-award.
    r"\b(award|recognition|recognise[d]?|recognize[d]?|prize|honou?r|medal"
    r"|dean'?s list|scholarship|commendation|excellence)\b",
    re.IGNORECASE,
)
_CERT_LIKE_RE = re.compile(
    r"\b(certificate|certification|certified|licen[sc]e|diploma|accreditation"
    r"|police check|first aid|cpr|working with children|wwcc|registration"
    r"|qualification)\b",
    re.IGNORECASE,
)


_AWARDS_SOURCE_HEADINGS = {
    "certifications",
    "recognition",
    "recognitions",
    "achievements",
    "achievement",
    "honours",
    "honors",
    "accolades",
}


_DATE_TAIL_RE = re.compile(
    r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
    r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
    r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*$",
    re.IGNORECASE,
)

# Strips "August 2025." or "2025." from the START of a description string.
# The date already appears on the name line, so a leading repetition is noise.
_LEADING_DATE_RE = re.compile(
    r"^(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
    r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
    r"|Nov(?:ember)?|Dec(?:ember)?)\s+)?\d{4}[.\s,]+",
    re.IGNORECASE,
)


def _is_valid_date(d: str) -> bool:
    if not d:
        return False
    has_digit = any(c.isdigit() for c in d)
    has_month = bool(re.search(
        r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b",
        d,
        re.IGNORECASE
    ))
    return has_digit or has_month


def _add_desc_sentence(desc: str, new_sent: str) -> str:
    """Append new_sent to desc only if it is not case-insensitively and
    character-wise (ignoring punctuation/spaces) already present as a
    sentence in desc.
    """
    new_sent = new_sent.strip()
    if not new_sent:
        return desc
    if not desc:
        return new_sent
    # Simple split by punctuation followed by space or end of string
    existing_sentences = [s.strip() for s in re.split(r'\s*\.\s*', desc) if s.strip()]
    norm_new = re.sub(r'[^a-zA-Z0-9]', '', new_sent).lower()
    for s in existing_sentences:
        norm_s = re.sub(r'[^a-zA-Z0-9]', '', s).lower()
        if norm_s == norm_new or norm_s.startswith(norm_new) or norm_new.startswith(norm_s):
            return desc
    return f"{desc.rstrip('.')}. {new_sent}"


def _parse_award_parts(content: str) -> tuple:
    """Extract (name, org, date, description) from any observed award text.

    Handles the four production shapes seen in awards bullets/h3 bodies:
      pipe form:   "Name – Org | Date – Description"
      paren form:  "Name – Org (Date), description"
      plain form:  "Name – Org (Date)"
      bare name:   "Dean's List"
      nested form: "Name (Org (Date))" — the AI occasionally double-wraps the
                   org+date in nested parens. Without a dedicated handler the
                   inner `\(([^()]+)\)` regex below matches the date paren, the
                   outer '(' stays stuck in the name field, and the outer ')'
                   spills into description, producing the malformed render
                   'Name (Org (Date)' + newline + ').' (Opal Healthcare bug,
                   2026-06-12).
    """
    name = org = date = description = ""

    # Nested-paren shape — handle BEFORE the standard regex below would
    # mis-parse the inner paren as the date. Only fires when the inner paren
    # contains a 4-digit year or a month name so we don't accidentally
    # collapse legitimate "Award (Company Name (LLC))" shapes.
    nested = re.match(
        r"^(?P<name>[^()]+?)\s*"
        r"\(\s*(?P<org>[^()]+?)\s*"
        r"\(\s*(?P<date>[^()]+?)\s*\)\s*\)\s*"
        r"(?P<desc>.*)$",
        content.strip(),
    )
    if nested:
        inner = nested.group("date").strip()
        if re.search(
            r"\b\d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)",
            inner,
            re.IGNORECASE,
        ):
            name = nested.group("name").strip()
            org = nested.group("org").strip().rstrip(",").strip()
            date = inner
            description = nested.group("desc").strip().lstrip(",.").strip()
            return name.strip(), org.strip(), date.strip(), description.strip()
    # Middle-dot delimited form — the canonical renderer emits awards as
    # "Name · Issuer · [Location] · Date" (cv_renderer._render_award_lines).
    # Without a dedicated split the whole string lands in `name` and the date
    # is lost. Last segment is taken as the date only when it IS a date; the
    # remaining middle segments become the org (any AU location tail is stripped
    # downstream in _format_award_entry).
    if "·" in content:
        segs = [p.strip() for p in content.split("·") if p.strip()]
        if segs:
            name = segs[0]
            rest = segs[1:]
            if rest:
                dm = _DATE_TAIL_RE.search(rest[-1])
                if dm and dm.start() == 0:
                    date = rest[-1]
                    rest = rest[:-1]
            if rest:
                org = ", ".join(rest)
            return name.strip(), org.strip(), date.strip(), description.strip()
    if "|" in content:
        left, right = content.rsplit("|", 1)
        right = right.strip()
        for sep in (" – ", " — ", " - ", ", "):
            if sep in right:
                date, description = right.split(sep, 1)
                date = date.strip()
                description = description.strip()
                break
        else:
            date = right
        left = left.strip()
        parsed_name, parsed_org = _split_award_name_org(left)
        if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
            description = _add_desc_sentence(description, parsed_org)
            name, org = _split_award_name_org(parsed_name)
        else:
            name = parsed_name
            org = parsed_org
    else:
        m = re.search(r"\(([^()]+)\)", content)
        if m:
            date = m.group(1).strip()
            before = content[:m.start()].strip()
            after = content[m.end():].strip().lstrip(",").strip()
            description = after
            parsed_name, parsed_org = _split_award_name_org(before)
            if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                description = _add_desc_sentence(description, parsed_org)
                name, org = _split_award_name_org(parsed_name)
            else:
                name = parsed_name
                org = parsed_org
        else:
            parsed_name, parsed_org = _split_award_name_org(content)
            if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                description = _add_desc_sentence(description, parsed_org)
                name, org = _split_award_name_org(parsed_name)
            else:
                name = parsed_name
                org = parsed_org
    return name.strip(), org.strip(), date.strip(), description.strip()


_AU_LOCATION_TAIL_RE = re.compile(
    # Strips ", [Suburb,] State[, Australia]" or ", Country" from the end of an
    # org name. The suburb part is optional and matched only when a state or
    # country follows, so it never strips a comma-suburb pattern that lacks the
    # state anchor (e.g. "Some Foundation, Inc." stays intact).
    r",\s*(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*)?"  # optional suburb name
    r"(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
    r"|New South Wales|Victoria|Queensland|Western Australia|South Australia"
    r"|Tasmania|Australian Capital Territory|Northern Territory"
    r"|Australia)\b.*$",
    re.IGNORECASE,
)

# Sprint D — LLM-error variants where the comma is missing. The writer
# occasionally concatenates "Org Name Suburb, NSW, Australia" without the
# comma between Org and Suburb, leaving the existing regex unable to match.
# Strips ` Suburb, State[, Country]` (no leading comma) — anchored strictly
# by `Suburb,\s*STATE` so it CAN'T strip the second-to-last word ambiguously.
# Only one suburb word is consumed; an "Anglicare Sydney Kirrawee, NSW"
# input strips just "Kirrawee, NSW, Australia", keeping the org name
# "Anglicare Sydney" intact (Sydney here is a city-operator suffix, not a
# location suburb).
_AU_LOCATION_TAIL_NOCOMMA_RE = re.compile(
    r"\s+[A-Z][a-zA-Z]+,\s*"                            # ` Suburb,`
    r"(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
    r"|New South Wales|Victoria|Queensland|Western Australia|South Australia"
    r"|Tasmania|Australian Capital Territory|Northern Territory"
    r"|Australia)\b.*$",
    re.IGNORECASE,
)


def _strip_duplicate_trailing_word(org: str) -> str:
    """Strip a trailing capitalised word that ALSO appears earlier in the org.

    Fixes the Anglicare-run bug: 'Jesmond Miranda Nursing Home Miranda' →
    'Jesmond Miranda Nursing Home'. The LLM concatenated the suburb
    ('Miranda') to the org name without a comma; since 'Miranda' already
    appears in the facility's name, we can confidently identify it as
    duplicate.

    Only acts when:
      • There are 3+ words in the org (avoids stripping a real second word)
      • The last word matches a previous word case-insensitively
      • The last word is NOT a corporate suffix (Inc, Ltd, LLC, Pty, Group)
      • The last word is NOT all-caps (NSW, USA — handled by other passes)
    """
    if not org or not org.strip():
        return org
    parts = org.strip().split()
    if len(parts) < 3:
        return org
    last = parts[-1]
    # Skip corporate suffixes; they may genuinely duplicate (rare).
    if last.lower() in {"inc", "ltd", "llc", "pty", "limited", "group", "co"}:
        return org
    if last.isupper() and len(last) <= 4:
        return org  # ALL-CAPS short token: probably acronym, not duplicate suburb
    prior = " ".join(parts[:-1]).lower()
    if last.lower() in prior.split():
        # Duplicate found → strip.
        return " ".join(parts[:-1])
    return org


def _strip_au_location(org: str) -> str:
    """Remove trailing Australian suburb/state/country from an org name.

    Three passes, applied in order:
      1. NO-COMMA tail FIRST (' Suburb, NSW, Australia') — the broader match
         that consumes both Suburb and State. Must run before the comma-led
         regex which would otherwise greedily eat just ', NSW, Australia',
         orphaning the Suburb word inside the org.
      2. Comma-led location tail (', Suburb, NSW, Australia') — catches the
         remaining cases where the LLM emitted a clean comma-delimited tail.
      3. Duplicate trailing word that already appears earlier in the org
         ('Jesmond Miranda Nursing Home Miranda' → strip the duplicate) —
         the writer occasionally concatenates a suburb name verbatim.
    """
    cleaned = _AU_LOCATION_TAIL_NOCOMMA_RE.sub("", org).strip().rstrip(",").strip()
    cleaned = _AU_LOCATION_TAIL_RE.sub("", cleaned).strip().rstrip(",").strip()
    cleaned = _strip_duplicate_trailing_word(cleaned)
    return cleaned if cleaned else org


def _dedupe_award_description_sentences(desc: str) -> str:
    """Drop near-duplicate sentences from an awards description.

    Production bug (Opal Healthcare, 2026-06-12). Two cases observed:

      (a) Oxford-comma-only variants (exact after punctuation strip):
          "Recognised for hard work, caring nature and positive attitude.
           Recognised for hard work, caring nature, and positive attitude."

      (b) FUZZY near-duplicates — one sentence is a near-superset of the
          other, differing by a few extra words:
          "Recognised for hard work, caring nature, empathy and positive
           attitude in resident care.
           Recognised for hard work, caring nature, and positive attitude."

    Both come from upstream (the source CV repeated it, or verify_claims
    appended a reworded copy). This dedupe runs before rendering so the
    user sees ONE sentence — the most informative (longest) of a duplicate
    cluster.

    Strategy:
      1. Split into sentences.
      2. Exact-normalised dedupe (handles case (a)).
      3. Fuzzy pass: process longest-first; drop a sentence whose content
         tokens are ≥80% contained in an already-kept (longer) sentence
         (handles case (b) — the shorter subset is dropped, the richer
         superset is kept). Re-emit in original order.
    """
    if not desc or "." not in desc:
        return desc
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", desc) if s.strip()]
    if len(sentences) <= 1:
        return desc

    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s.lower())).strip()

    def _tokens(s: str) -> set:
        return set(_norm(s).split())

    # Pass 1 — exact-normalised dedupe (preserves first-seen order).
    seen_exact: set[str] = set()
    stage1: list[str] = []
    for s in sentences:
        key = _norm(s)
        if not key or key in seen_exact:
            continue
        seen_exact.add(key)
        stage1.append(s)

    # Pass 2 — fuzzy subset dedupe. Process longest-first so the richest
    # sentence in a duplicate cluster is the one retained; a shorter sentence
    # whose tokens are ≥80% covered by a kept longer one is dropped.
    order = {s: i for i, s in enumerate(stage1)}
    by_len_desc = sorted(stage1, key=lambda s: len(_tokens(s)), reverse=True)
    kept_fuzzy: list[str] = []
    for s in by_len_desc:
        toks = _tokens(s)
        if not toks:
            continue
        is_dup = False
        for k in kept_fuzzy:
            ktoks = _tokens(k)
            overlap = len(toks & ktoks) / len(toks)
            if overlap >= 0.8:
                is_dup = True
                break
        if not is_dup:
            kept_fuzzy.append(s)

    # Re-emit in original order.
    final = sorted(kept_fuzzy, key=lambda s: order.get(s, 0))

    if len(final) == len(sentences):
        return desc  # no duplicates → return original verbatim
    return " ".join(final)


def _format_award_entry(name: str, org: str, date: str, description: str = "") -> list:
    """Produce the canonical bullet-list entry for ## Awards.

    Output shape (name and organisation separated by a comma, rendered flat in
    both the web and PDF renderers):
      * Award Name, Organisation (Date)
        Description sentence.

    Trailing two spaces on the first line create a <br> in ReactMarkdown so
    the description appears on its own visual line inside the same list item.
    Falls back gracefully when any field is missing:
      - no org   →  '* Award Name (Date)'
      - no date  →  '* Award Name, Organisation'
      - no description → single-line bullet, no second line
    """
    org_clean = _strip_au_location(org) if org else ""

    # Strip trailing date from org when the same date will also be appended
    # in parentheses — fixes "Jesmond Miranda Nursing Home, August 2025
    # (August 2025)" duplicates that arise when the upstream parser leaves
    # the date in the org field AND also extracts it separately.
    if org_clean and date:
        # Match either a literal trailing copy of `date` or a generic
        # "Month YYYY"/"YYYY"/"YYYY-YYYY" tail (with optional preceding
        # comma/space). Anchor to end so we don't trim a date that happens
        # to also appear inside the org name.
        date_norm = re.escape(date.strip())
        org_clean = re.sub(
            r"\s*,?\s*" + date_norm + r"\s*$",
            "",
            org_clean,
            flags=re.IGNORECASE,
        ).rstrip(" ,")
        # Generic month-year tail (covers cases where org has "August 2025"
        # but date is normalised to "Aug 2025" or similar — still a duplicate
        # in spirit).
        org_clean = re.sub(
            r"\s*,?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
            r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
            r"Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\s*$",
            "",
            org_clean,
            flags=re.IGNORECASE,
        ).rstrip(" ,")
        # Bare-year tail when the same year is already in `date`. Fixes
        # 'Jesmond Miranda Nursing Home, 2025 (August 2025)' from the
        # ADS Care run (Opus 4.8) where the org field had ', 2025'
        # appended even though the date field carried 'August 2025'.
        date_year_m = re.search(r"\b(\d{4})\b", date.strip())
        if date_year_m:
            year = date_year_m.group(1)
            org_clean = re.sub(
                r"\s*,?\s*" + re.escape(year) + r"\s*$",
                "",
                org_clean,
            ).rstrip(" ,")

    first = name or "(unnamed award)"
    if org_clean:
        first = f"{first}, {org_clean}"
    if date:
        first = f"{first} ({date})"

    if description:
        desc = description.strip()
        # Strip any leading "Month YYYY. " or "YYYY. " that sometimes gets
        # prepended to descriptions (the date already appears on the name line).
        desc = _LEADING_DATE_RE.sub("", desc).strip()
        # Deduplicate near-identical sentences. Observed (Opal Healthcare,
        # 2026-06-12) after the parens-parse fix landed: descriptions sometimes
        # contain two near-identical sentences differing only by an Oxford
        # comma or minor wording. The duplicate was hidden before because the
        # whole description was just ')' from a broken parse — now visible.
        desc = _dedupe_award_description_sentences(desc)
        # Strip stray leading punctuation — e.g. ". Recognised for..." when
        # verify_claims appends description directly after a closing paren date.
        desc = desc.lstrip(".,;").strip()
        # Strip trailing " |" left over from old pipe-delimiter format conversion.
        desc = desc.rstrip("|").strip().rstrip(".")
        if desc:
            if desc.isupper():
                # ALL-CAPS noise → sentence-case it.
                desc = desc[0].upper() + desc[1:].lower() if len(desc) > 1 else desc.upper()
            else:
                # Preserve original casing — blanket .lower() destroyed proper
                # nouns and acronyms (NDIS, RN, place/person names). Just ensure
                # the first character is capitalised.
                desc = desc[0].upper() + desc[1:] if len(desc) > 1 else desc.upper()
            # Lazy import avoids an import cycle with _impl (which imports this
            # module at top level). Same function object, resolved at call time.
            from app.services.eval.writers._impl import _canonicalise_skill_spelling
            desc = _canonicalise_skill_spelling(desc)
            # Trailing "  " = hard line break (<br>) in ReactMarkdown so the
            # description appears on its own line within the same list item.
            lines = [f"* {first}  ", f"  {desc}."]
        else:
            lines = [f"* {first}"]
    else:
        lines = [f"* {first}"]

    return lines


# Keep the old name as an alias so any external callers are not broken.
def _format_award_bullet(name: str, org: str, date: str) -> str:
    return "\n".join(_format_award_entry(name, org, date))


# Words/phrases that mean a line is a DESCRIPTION (not an award name). Used
# to detect the "swapped" shape verify_claims sometimes produces, where the
# description gets promoted to ### and the name lands as plain text.
_DESCRIPTION_PREFIX_RE = re.compile(
    r"^(?:Recogni[sz]ed|Awarded|Received|Nominated|Presented|Given|Honou?red|For)\b",
    re.IGNORECASE,
)


def _classify_entry_line(line: str) -> tuple:
    """Classify a non-blank line inside ## Awards.

    Returns (kind, content) where kind ∈ {h3, italic, bullet, plain}.
    """
    s = line.strip()
    if s.startswith("### "):
        return "h3", s[4:].strip()
    if s.startswith("*") and s.endswith("*") and len(s) > 2:
        return "italic", s.strip("*").strip()
    if s.startswith(("- ", "* ")):
        return "bullet", s[2:].strip()
    return "plain", s


# Anchors for "this is a location, not an organisation". When a side of the
# pipe matches this, it should be discarded (or treated as location to strip)
# rather than promoted to the org field.
_LOCATION_ANCHOR_RE = re.compile(
    r"\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
    r"|New South Wales|Victoria|Queensland|Western Australia|South Australia"
    r"|Tasmania|Australian Capital Territory|Northern Territory|Australia)\b",
    re.IGNORECASE,
)


def _looks_like_location(text: str) -> bool:
    """True when text contains an Australian state/territory/country anchor —
    i.e. it's a location string and NOT an org name."""
    return bool(text and _LOCATION_ANCHOR_RE.search(text))


def _split_award_name_org(text: str) -> tuple:
    """Split 'Award – Org' (dash separator) or 'Award, Org' (comma, no trailing
    date) into (name, org). Returns (text, '') when no separator present.

    The AI commonly emits 'Staff Excellence Award – Jesmond Miranda Nursing
    Home' as a single h3/plain string; this helper extracts the org so the
    layout can put it in the right column instead of mashing it with the name.
    """
    for sep in (" – ", " — ", " - "):
        if sep in text:
            name, org = text.split(sep, 1)
            return name.strip(), org.strip()
    if "," in text and not _DATE_TAIL_RE.search(text):
        name, org = text.split(",", 1)
        return name.strip(), org.strip()
    return text.strip(), ""


def _parse_award_raw_entry(entry_lines: list) -> dict:
    """Parse one raw entry (a group of consecutive non-empty lines from inside
    ## Awards) into {name, org, date, description}.

    Handles every observed shape — bullet (pipe/paren/plain), h3+italic block,
    h3-only with trailing date, and the malformed "swapped" shape where the
    name is plain text and the description is promoted to ###.
    """
    name = org = date = description = ""

    for line in entry_lines:
        kind, content = _classify_entry_line(line)

        if kind == "h3":
            if not name:
                # First h3 = the award name (possibly with date / org / location).
                if "|" in content:
                    left, right = content.split("|", 1)
                    candidate_right = right.strip()
                    # Always try to split left into name+org first — AI emits
                    # 'Award – Org | …' as the dominant shape.
                    parsed_name, parsed_org = _split_award_name_org(left.strip())
                    if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                        description = _add_desc_sentence(description, parsed_org)
                        name, org = _split_award_name_org(parsed_name)
                    else:
                        name = parsed_name
                        if parsed_org and not org:
                            org = parsed_org
                    # Now classify the right side.
                    if _is_valid_date(candidate_right):
                        date = candidate_right
                    elif _looks_like_location(candidate_right) and org:
                        # Org already came from dash split → right is pure
                        # location residue, discard.
                        pass
                    elif not org:
                        # Right may be 'Org, Suburb, State, Country' — accept
                        # and let _format_award_entry strip the location tail.
                        org = candidate_right
                else:
                    parsed_name, parsed_org = _split_award_name_org(content)
                    if parsed_org:
                        if _DESCRIPTION_PREFIX_RE.match(parsed_org):
                            description = _add_desc_sentence(description, parsed_org)
                            name, org = _split_award_name_org(parsed_name)
                        else:
                            name = parsed_name
                            if not org:
                                org = parsed_org
                    else:
                        m_date = _DATE_TAIL_RE.search(content)
                        if m_date:
                            name = content[:m_date.start()].strip()
                            date = m_date.group(1).strip()
                        else:
                            name = content
            else:
                # Second h3 in same entry = description that was wrongly
                # promoted to a heading by verify_claims. Fold it back.
                m_date = _DATE_TAIL_RE.search(content)
                if m_date:
                    candidate_desc = content[:m_date.start()].strip().rstrip(",|").strip()
                    if not date:
                        date = m_date.group(1).strip()
                else:
                    candidate_desc = content
                description = _add_desc_sentence(description, candidate_desc)

        elif kind == "italic":
            if "|" in content:
                left, right = content.rsplit("|", 1)
                if _is_valid_date(right.strip()):
                    description = _add_desc_sentence(description, left.strip())
                    if not date:
                        date = right.strip()
                elif not org:
                    org = content
            elif (_idate := _DATE_TAIL_RE.search(content)) and _idate.start() == 0:
                # Standalone italic date line ("*August 2025*") — the common
                # H3 + italic-date + italic-description award shape. Without this
                # the line fell through to the org/discard branches and the date
                # was lost entirely ("Staff Excellence Award, The Jesmond Group"
                # rendered with no date). Anchored start()==0 so an italic that
                # merely ends in a year ("…recognised in 2024") is NOT consumed.
                if not date:
                    date = _idate.group(1).strip()
            elif _DESCRIPTION_PREFIX_RE.match(content):
                description = _add_desc_sentence(description, content)
            elif not org:
                org = content
            # else: org is already set. A second italic line here is almost
            # always a leftover location residue (e.g. '*Miranda*' after a
            # location strip) or a redundant org repeat — DISCARD it rather
            # than letting it bleed into the description field.

        elif kind == "bullet":
            # If we already have a name and the bullet starts with description
            # language (Recognised for/Awarded/etc.), treat it as a description
            # continuation instead of trying to parse name/org again.
            if name and _DESCRIPTION_PREFIX_RE.match(content):
                m_date = _DATE_TAIL_RE.search(content)
                if m_date:
                    desc_text = content[:m_date.start()].strip().rstrip(",|").strip()
                    if not date:
                        date = m_date.group(1).strip()
                else:
                    desc_text = content
                description = _add_desc_sentence(description, desc_text)
            else:
                n, o, d, desc = _parse_award_parts(content)
                if not name:        name = n
                if not org:         org = o
                if not date and _is_valid_date(d):
                    date = d
                if desc:
                    description = _add_desc_sentence(description, desc)

        else:  # plain
            m_date = _DATE_TAIL_RE.search(content)
            if not name:
                # First plain line — could be "Name – Org | Date" /
                # "Name – Org" / "Name | Date" / "Name | Org" / bare name.
                if "|" in content:
                    left, right = content.split("|", 1)
                    candidate_right = right.strip()
                    parsed_name, parsed_org = _split_award_name_org(left.strip())
                    if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                        description = _add_desc_sentence(description, parsed_org)
                        name, org = _split_award_name_org(parsed_name)
                    else:
                        name = parsed_name
                        if parsed_org and not org:
                            org = parsed_org
                    if _is_valid_date(candidate_right):
                        date = candidate_right
                    elif _looks_like_location(candidate_right) and org:
                        # Org already came from dash split → right is just
                        # location residue, discard.
                        pass
                    elif not org:
                        # Let _format_award_entry strip any trailing location.
                        org = candidate_right
                else:
                    parsed_name, parsed_org = _split_award_name_org(content)
                    if parsed_org:
                        if _DESCRIPTION_PREFIX_RE.match(parsed_org):
                            description = _add_desc_sentence(description, parsed_org)
                            name, org = _split_award_name_org(parsed_name)
                        else:
                            name = parsed_name
                            if not org:
                                org = parsed_org
                    elif m_date:
                        name = content[:m_date.start()].strip()
                        date = m_date.group(1).strip()
                    else:
                        name = content
            elif _DESCRIPTION_PREFIX_RE.match(content):
                # Description-style language — never an org.
                if m_date and not date:
                    description = _add_desc_sentence(description, content[:m_date.start()].strip().rstrip(",|").strip())
                    date = m_date.group(1).strip()
                else:
                    description = _add_desc_sentence(description, content)
            elif not org:
                org = content
            else:
                if m_date and not date:
                    description = _add_desc_sentence(description, content[:m_date.start()].strip().rstrip(",|").strip())
                    date = m_date.group(1).strip()
                else:
                    description = _add_desc_sentence(description, content)

    return {
        "name": name.strip(),
        "org": org.strip(),
        "date": date.strip(),
        "description": description.strip(),
    }
