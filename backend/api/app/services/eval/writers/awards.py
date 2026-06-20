"""Awards & credentials section logic — extracted from writers._impl.

High-level passes over the Awards / Certifications sections: entry normalisation,
awards-only Certifications relabelling, the awards/certs splitter, credential
grounding against the original CV (ensure_awards, _strip_ungrounded_credentials).
Builds on the low-level parsers in writers.awards_parsing (acyclic dependency).
Moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from app.services.eval.writers.awards_parsing import (
    _AWARD_RE, _CERT_LIKE_RE, _AWARDS_SOURCE_HEADINGS, _DESCRIPTION_PREFIX_RE,
    _format_award_entry, _parse_award_raw_entry,
)

logger = logging.getLogger(__name__)

def _is_description_only_entry(entry: dict) -> bool:
    """An entry is description-only when:
      - its name starts with description language (Recognised for / Awarded / …)
      - OR it has no name + no org but a description
    """
    n = entry.get("name", "")
    if n and _DESCRIPTION_PREFIX_RE.match(n):
        return True
    if not n and not entry.get("org") and entry.get("description"):
        return True
    return False


def _normalise_awards_entries(markdown: str) -> str:
    """Normalise every entry inside ## Awards to the simple bullet format:

      * Award Name - Organisation (Date)
        Description sentence.

    Robust to all observed production shapes (bullet, h3+italic, h3-only) AND
    to the "swapped" shape verify_claims sometimes produces (name as plain
    text, description promoted to ###). Idempotent — running twice on already-
    structured input is a no-op. No-op when ## Awards is absent.
    """
    lines = markdown.split("\n")
    start = next(
        (i for i, l in enumerate(lines)
         if l.strip().lower().rstrip(":") == "## awards"),
        -1,
    )
    if start < 0:
        return markdown
    end = next(
        (j for j in range(start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    # Step 1: split section body into RAW ENTRIES. A new entry starts on a blank
    # line OR on a new bullet/h3 line — so adjacent award bullets with no blank
    # line between them (as verify_claims sometimes emits) are NOT merged into a
    # single entry (which silently dropped the second award). EXCEPTION: a
    # description-language line (Recognised for / Awarded / …) is a continuation
    # of the current award, not a new entry, even when the AI emits it as its own
    # bullet or promotes it to a `### ` heading (the "swapped" shape). Indented
    # continuation lines and `*italic*` lines never trigger a split (they lack the
    # trailing space the `* `/`- ` check needs).
    body = lines[start + 1:end]
    raw_entries: list[list[str]] = []
    current: list[str] = []
    for ln in body:
        stripped = ln.strip()
        if not stripped:
            if current:
                raw_entries.append(current)
                current = []
            continue
        starts_entry = stripped.startswith(("* ", "- ", "### "))
        if starts_entry:
            entry_content = stripped.lstrip("*-# ").strip()
            if _DESCRIPTION_PREFIX_RE.match(entry_content):
                starts_entry = False
        if starts_entry and current:
            raw_entries.append(current)
            current = []
        current.append(ln)
    if current:
        raw_entries.append(current)

    if not raw_entries:
        return markdown

    # Step 2: parse each raw entry into structured fields. Fail loud when a
    # non-empty raw entry yields no usable field — that's an unrecognised shape
    # the parser silently swallowed, not legitimately-empty content.
    parsed = [_parse_award_raw_entry(e) for e in raw_entries]
    for raw, entry in zip(raw_entries, parsed):
        if not (entry.get("name") or entry.get("org") or entry.get("description")):
            logger.warning("awards: unparsed entry shape: %r", raw)

    # Step 3: merge description-only entries back into the previous entry
    # (handles the swapped shape: name+org as plain, description as own ### block).
    merged: list[dict] = []
    for entry in parsed:
        if (merged and _is_description_only_entry(entry)
                and not merged[-1].get("description")):
            # Promote this entry's contents into the previous entry's description.
            prev = merged[-1]
            new_desc = entry.get("description") or entry.get("name")
            prev["description"] = new_desc
            if entry.get("date") and not prev.get("date"):
                prev["date"] = entry["date"]
        else:
            merged.append(entry)

    # Step 4: drop entries with no usable content; emit the structured shape.
    new_entries: list[str] = []
    for entry in merged:
        if not (entry.get("name") or entry.get("org") or entry.get("description")):
            continue
        for ln in _format_award_entry(
            entry["name"], entry["org"], entry["date"], entry["description"]
        ):
            new_entries.append(ln)

    if not new_entries:
        return markdown

    # Blank line between entries (keeps list items parseable as separate
    # entries on a re-run), trailing blank before the next section.
    spaced: list[str] = []
    for ln in new_entries:
        if ln.startswith("* ") and spaced:
            spaced.append("")
        spaced.append(ln)

    rebuilt = [lines[start], ""] + spaced + [""]
    return "\n".join(lines[:start] + rebuilt + lines[end:])


def _relabel_awards_only_certifications(markdown: str) -> str:
    """Rename a credentials-style heading to ``## Awards`` when its entries
    are all award/recognition lines and none is an actual credential.

    Catches Certifications AND the AI's recurring alternatives — Recognition,
    Achievements, Honours. Without this, an ## Recognition section emitted by
    the writer (production Sanctuary CV) escapes the relabel and persists as
    an off-rolepack heading, breaking section_order semantics."""
    lines = markdown.split("\n")
    start = None
    end = len(lines)
    for i, line in enumerate(lines):
        if line.startswith("## "):
            heading = line[3:].strip().lower().rstrip(":")
            if heading in _AWARDS_SOURCE_HEADINGS and start is None:
                start = i
                continue
            if start is not None:
                end = i
                break
    if start is None:
        return markdown

    content = [ln.strip() for ln in lines[start + 1:end] if ln.strip()]
    if not content:
        return markdown
    if all(_AWARD_RE.search(e) for e in content) and not any(
        _CERT_LIKE_RE.search(e) for e in content
    ):
        original_heading = lines[start][3:].strip().rstrip(":")
        lines[start] = "## Awards"
        logger.info(
            "w8: relabelled awards-only %s section to Awards",
            original_heading,
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Sprint A — Awards / Certifications disambiguator (Phase 2 Module 7).
#
# The Phase-1 _relabel_awards_only_certifications only handles the pure case
# (every entry is an award → rename heading). It does NOT split a MIXED
# section. So when GPT-5.1 generates:
#
#   ## Certifications
#   First Aid Certification
#   Staff Excellence Award, Jesmond Miranda Nursing Home
#     Recognised for hard work, caring nature, and positive attitude.
#
# …the relabel pass sees the cert entry, refuses to rename, and the award
# entry ends up under the wrong heading. This is the Anglicare run bug.
#
# Sprint A: classify EACH entry, then SPLIT.
#   • Pure award (match _AWARD_RE, not _CERT_LIKE_RE) → ## Awards
#   • Credential ALREADY in Registration & Licences (literal substring) → drop
#     (duplicate; the canonical home is Registration)
#   • Industry cert (_CERT_LIKE_RE only, not already in Registration) → keep
#     under Certifications
#   • Section empty after split → drop heading entirely
#
# Result: Awards always shows when an award exists; Certifications only
# appears when there's a real industry-cert entry no other section covers.
# ---------------------------------------------------------------------------


def _entry_is_award(text: str) -> bool:
    """Award-shaped entry: matches award vocabulary AND not cert vocabulary."""
    return bool(_AWARD_RE.search(text)) and not bool(_CERT_LIKE_RE.search(text))


def _entry_is_cert(text: str) -> bool:
    """Credential-shaped entry (certificate/licence/first aid/cpr/etc.)."""
    return bool(_CERT_LIKE_RE.search(text))


def _registration_section_text(markdown: str) -> str:
    """Lowercased body text of ## Registration & Licences (and aliases),
    used to detect when a Certifications entry duplicates a credential
    already canonically listed in Registration. Returns "" when no such
    section exists."""
    aliases = {
        "registration & licences", "registration and licences",
        "registration", "registrations", "licences", "licenses",
        "licences and registrations", "credentials & checks",
    }
    lines = markdown.split("\n")
    out: list[str] = []
    collecting = False
    for ln in lines:
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            collecting = heading in aliases
            continue
        if collecting and ln.strip():
            out.append(ln.lower())
    return "\n".join(out)


def _credential_already_in_registration(entry: str, registration_blob: str) -> bool:
    """True if the credential phrase already appears in Registration & Licences.

    Conservative match: looks for the credential's canonical word stem
    (first aid / cpr / police check / driver licence / vaccination /
    medication competency / wwcc) in the registration blob. Exact-phrase
    matching would miss synonyms ("First Aid Certification" vs
    "First Aid (HLTAID011)")."""
    if not registration_blob:
        return False
    t = entry.lower()
    # Canonical credential anchors — if entry contains one AND registration
    # also contains it, treat as duplicate. Keeps the check tight (avoids
    # over-matching on generic words).
    anchors = (
        "first aid", "cpr", "police check", "working with children", "wwcc",
        "driver licence", "drivers license", "driver license", "drivers licence",
        "medication competency", "ndis worker", "covid", "influenza",
        "vaccination", "police clearance", "work rights",
    )
    for anchor in anchors:
        if anchor in t and anchor in registration_blob:
            return True
    return False


def split_awards_and_certifications(markdown: str) -> str:
    """Sprint A core pass: classify each entry under a Certifications/Recognition/
    Achievements/Honours heading, then split into clean ## Awards + ## Certifications
    sections (dropping credential entries already covered by Registration).

    Idempotent — running twice produces identical output.

    Source section detection: any heading in _AWARDS_SOURCE_HEADINGS. Multiple
    such sections are merged.

    Entry classification:
      • award-shaped → Awards bucket
      • cert-shaped AND duplicate of Registration entry → DROP
      • cert-shaped AND not in Registration → Certifications bucket (real industry cert)
      • ambiguous (neither matches) → Awards bucket (default — better to over-include awards
        than drop content; the Awards renderer is more permissive of free-form text)
    """
    lines = markdown.split("\n")
    # Find every candidate source section (Certifications, Recognition, etc.)
    # so we can merge multi-section content from chatty LLM output.
    section_ranges: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            if heading in _AWARDS_SOURCE_HEADINGS:
                start = i
                j = i + 1
                while j < len(lines) and not lines[j].startswith("## "):
                    j += 1
                section_ranges.append((start, j, heading))
                i = j
                continue
        i += 1

    if not section_ranges:
        return markdown

    # Collect every entry across all source sections. Track which source
    # heading each entry came from so ambiguous (neither award nor cert
    # vocabulary) entries default sensibly: source "certifications" → keep
    # as cert; source "awards"/"recognition"/"honours" → award.
    raw_entries: list[tuple[str, str]] = []  # (entry_text, source_heading)
    for start, end, source_heading in section_ranges:
        block_lines = lines[start + 1:end]
        # Group lines into entries. A new entry starts on a non-indented,
        # non-bullet, non-blank line. Lines that are indented (2+ leading
        # spaces, a tab) OR start with a bullet marker (-, *, •) are
        # CONTINUATIONS of the previous entry. Blank lines also flush.
        current: list[str] = []

        def flush():
            if current:
                raw_entries.append(("\n".join(current).rstrip(), source_heading))

        for bl in block_lines:
            stripped = bl.strip()
            if not stripped:
                flush()
                current = []
                continue
            is_continuation = (
                bl[:1] in (" ", "\t")            # indented
                or stripped[:1] in ("-", "*", "•")  # bullet → could be either,
                # but bullet items lead a NEW entry only when current is empty
            )
            # Special-case: if the line starts with a bullet AND current is
            # empty, treat as a new entry (e.g. "- Award Name").
            if stripped[:1] in ("-", "*", "•") and not current:
                current.append(bl)
                continue
            if is_continuation and current:
                current.append(bl)
            else:
                flush()
                current = [bl]
        flush()

    if not raw_entries:
        # All source sections empty — just drop the headings.
        return _drop_sections_by_ranges(lines, section_ranges)

    registration_blob = _registration_section_text(markdown)

    awards_entries: list[str] = []
    cert_entries: list[str] = []
    dropped_dup: list[str] = []

    _CERT_SOURCE_HEADINGS = {
        "certifications", "certification", "certs", "cert",
        "credentials", "credential",
    }

    for entry, source_heading in raw_entries:
        flat = entry.replace("\n", " ")
        if _entry_is_award(flat):
            awards_entries.append(entry)
        elif _entry_is_cert(flat):
            if _credential_already_in_registration(flat, registration_blob):
                dropped_dup.append(flat[:80])
                continue
            cert_entries.append(entry)
        else:
            # Ambiguous — default to the source heading's category.
            # "## Certifications" + ambiguous entry → keep as cert (might be
            # an industry cert like "CKAD" the regex doesn't recognise).
            # "## Recognition" / "## Honours" + ambiguous → award.
            if source_heading in _CERT_SOURCE_HEADINGS:
                cert_entries.append(entry)
            else:
                awards_entries.append(entry)

    # Re-emit: drop all source-section blocks, then append new Awards + Certifications
    # at the position of the FIRST source section (preserves rough layout). The
    # downstream _reorder_sections pass repositions to canonical order anyway.
    insertion_point = section_ranges[0][0]
    out_lines = _drop_sections_by_ranges(lines, section_ranges)
    new_blocks: list[str] = []
    if awards_entries:
        new_blocks.append("## Awards\n\n" + "\n\n".join(awards_entries).rstrip())
    if cert_entries:
        new_blocks.append("## Certifications\n\n" + "\n\n".join(cert_entries).rstrip())

    if not new_blocks:
        # Everything was deduplicated — log and return without source sections.
        if dropped_dup:
            logger.info(
                "sprint-A awards-split: dropped %d credential duplicate(s) of Registration",
                len(dropped_dup),
            )
        return "\n".join(out_lines)

    # Find the insertion line in the reduced out_lines. We tracked the original
    # insertion_point but the array has been edited; find a stable anchor.
    # Simplest: append before the next non-source ## heading that follows the
    # original position; otherwise append at end.
    new_text = "\n\n".join(new_blocks)
    # Splice: walk the reduced output, find where we should insert (matching
    # the original first-source position by counting headings).
    result = "\n".join(out_lines).rstrip() + "\n\n" + new_text + "\n"

    if dropped_dup:
        logger.info(
            "sprint-A awards-split: split %d source section(s) → %d award + %d cert; dropped %d duplicate(s)",
            len(section_ranges), len(awards_entries), len(cert_entries), len(dropped_dup),
        )
    else:
        logger.info(
            "sprint-A awards-split: split %d source section(s) → %d award + %d cert",
            len(section_ranges), len(awards_entries), len(cert_entries),
        )
    return result


def _drop_sections_by_ranges(lines: list[str], ranges: list[tuple[int, int, str]]) -> list[str]:
    """Return `lines` with the (start, end) ranges removed. Ranges are
    sorted/de-overlapped before applying so multiple sections drop cleanly."""
    keep = [True] * len(lines)
    for start, end, _ in ranges:
        for k in range(start, min(end, len(lines))):
            keep[k] = False
    out = [ln for ln, k in zip(lines, keep) if k]
    # Collapse runs of >2 blank lines that the drop may have left.
    cleaned: list[str] = []
    blank_run = 0
    for ln in out:
        if not ln.strip():
            blank_run += 1
            if blank_run <= 2:
                cleaned.append(ln)
        else:
            blank_run = 0
            cleaned.append(ln)
    return cleaned


# ---------------------------------------------------------------------------
# Awards / certifications recovery — deterministic, grounded in the original CV.
# The composition writer occasionally drops the whole Certifications/Awards
# section (run-to-run variance), silently losing genuine achievements the
# candidate listed. Like ensure_bachelor for the degree, this re-adds any
# original Certifications/Awards entry that is missing from the tailored CV.
# Honest by construction: entries are copied verbatim from the source CV and
# only re-added when absent (so it never duplicates or invents).
# ---------------------------------------------------------------------------

# Headings (markdown or plain) whose entries we treat as awards/credentials.
_CRED_KEYWORDS = {
    "certifications", "certification", "cert", "certs", "awards", "award",
    "honours", "honors", "recognition", "recognitions", "accolades",
    "clearances", "clearance", "checks", "check", "licences", "licence",
    "licenses", "license", "registration", "registrations", "achievements",
    "achievement", "credential", "credentials", "development",
}
# Other common CV headings — used to detect where a credentials section ends.
_OTHER_SECTION_WORDS = {
    "education", "experience", "work experience", "professional experience",
    "clinical experience", "skills", "summary", "professional summary",
    "profile", "projects", "references", "interests", "languages", "contact",
    "objective", "career highlights", "registration & licences",
}


def _is_cred_heading(heading: str, is_explicit: bool = False) -> bool:
    h = heading.lower()
    if h in _OTHER_SECTION_WORDS:
        return False
    if not is_explicit:
        if h.startswith(("-", "*", "•")):
            return False
        if len(h.split()) > 5:
            return False
    tokens = re.findall(r"\b\w+\b", h)
    return any(t in _CRED_KEYWORDS for t in tokens)


def _cv_heading_word(line: str) -> Optional[str]:
    """If `line` is a section heading (markdown '## X' or a bare label line),
    return its lowercased label; else None."""
    s = line.strip()
    if s.startswith("## "):
        label = s[3:].strip().lower().rstrip(":")
        if _is_cred_heading(label, is_explicit=True) or label in _OTHER_SECTION_WORDS:
            return label
        return None
    low = s.lower().rstrip(":").strip()
    if _is_cred_heading(low, is_explicit=False) or low in _OTHER_SECTION_WORDS:
        return low
    return None


def _extract_original_credentials(cv_text: str) -> list[str]:
    """Entries listed under a Certifications/Awards-type heading in the source CV."""
    entries: list[str] = []
    collecting = False
    for raw in (cv_text or "").split("\n"):
        word = _cv_heading_word(raw)
        if word is not None:
            collecting = _is_cred_heading(word, is_explicit=True)
            continue
        if not collecting:
            continue
        item = raw.strip().lstrip("-*•").strip()
        if item and len(item) <= 160:
            entries.append(item)
    seen: set[str] = set()
    return [e for e in entries if not (e.lower() in seen or seen.add(e.lower()))]


def _awards_section_text(markdown: str) -> str:
    """Return the lowercased text of every credential/awards section in the
    markdown, joined. Used to decide if an award is already surfaced as a
    DEDICATED entry (Certifications/Awards/Achievements section), not just
    mentioned inline in an Experience bullet. Returns "" when no such section
    exists."""
    lines = markdown.split("\n")
    parts: list[str] = []
    collecting = False
    for ln in lines:
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            collecting = _is_cred_heading(heading, is_explicit=True)
            continue
        if collecting and ln.strip():
            parts.append(ln.lower())
    return "\n".join(parts)


def ensure_awards(markdown: str, original_cv_text: str) -> str:
    """Re-add original-CV *award/recognition* entries the tailoring dropped.

    Award-only by design: trainings, certificates, licences and checks are NOT
    recovered here (the writer/structure path owns real credentials, and
    re-adding them tends to resurrect verbose JD-phrasing junk). No-op when the
    original lists no awards, or every award already appears as a dedicated
    entry in a Certifications/Awards section (an inline mention inside an
    Experience bullet does NOT count — the dedicated entry is what we recover).
    """
    entries = [e for e in _extract_original_credentials(original_cv_text)
               if _AWARD_RE.search(e) and not _CERT_LIKE_RE.search(e)]
    if not entries:
        return markdown
    # Scope the "already present" check to credential/awards sections only.
    # Bullets like "Received Staff Excellence Award at Jesmond…" in Experience
    # are NOT a substitute for a dedicated Awards entry — we still recover.
    awards_text = _awards_section_text(markdown)
    missing: list[str] = []
    for e in entries:
        # Split at any common award-name separator: spaced dash/en-dash, (date),
        # comma, OR the middle-dot (·) style — "Award · Org · Date". Extract the
        # part before the first separator as the canonical core to match against.
        core = re.split(r"\s[–—·-]\s|\(|,", e)[0].strip().lower()
        if (core and core in awards_text) or e.lower() in awards_text:
            continue
        missing.append(e)
    if not missing:
        return markdown
    missing = missing[:4]

    lines = markdown.rstrip("\n").split("\n")
    # Append into an existing credentials section if present, else create one.
    sec_start = None
    sec_end = len(lines)
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and _is_cred_heading(ln[3:].strip().rstrip(":"), is_explicit=True):
            sec_start = i
            sec_end = next(
                (j for j in range(i + 1, len(lines)) if lines[j].startswith("## ")),
                len(lines),
            )
            break

    bullets = [f"- {m}" for m in missing]
    if sec_start is not None:
        insert_at = sec_end
        while insert_at - 1 > sec_start and not lines[insert_at - 1].strip():
            insert_at -= 1
        new_lines = lines[:insert_at] + bullets + lines[insert_at:]
    else:
        new_lines = lines + ["", "## Certifications"] + bullets
    logger.info("w8: recovered %d dropped credential/award entr(ies) from CV", len(missing))
    return "\n".join(new_lines)


# Sections whose bullet entries must be grounded in the original CV. The AI
# composer sometimes invents credentials/checks (e.g. "First Aid Training –
# [Provider not specified]", "Driver Licence (NSW)") that the candidate never
# listed. We drop any bullet that carries a placeholder marker or whose lead
# phrase is absent from the source CV, and remove a section left empty.
_GROUNDED_SECTION_WORDS = {
    "certifications", "certification", "checks & clearances",
    "checks and clearances", "clearances", "checks", "licences", "licenses",
    "registration", "registrations", "registration & licences",
    "professional development",
}
_PLACEHOLDER_RE = re.compile(
    r"\[[^\]]*\]|not\s+specified|not\s+provided|tbc|to\s+be\s+confirmed",
    re.IGNORECASE,
)


def _strip_ungrounded_credentials(markdown: str, original_cv_text: str) -> str:
    """Drop AI-fabricated entries from credential/checks sections.

    For any section whose heading is a credential/checks word, remove bullet
    entries that (a) contain a placeholder marker, or (b) whose distinctive lead
    phrase is not a substring of the original CV. A section emptied of bullets is
    removed entirely."""
    cv_low = (original_cv_text or "").lower()
    lines = markdown.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith("## ") and line[3:].strip().lower().rstrip(":") in _GROUNDED_SECTION_WORDS:
            j = i + 1
            while j < n and not lines[j].startswith("## "):
                j += 1
            body = lines[i + 1:j]
            kept: list[str] = []
            dropped = 0
            kept_bullet = False
            for bl in body:
                stripped = bl.strip()
                is_bullet = stripped[:1] in ("-", "*", "•")
                if not is_bullet:
                    kept.append(bl)
                    continue
                entry = stripped.lstrip("-*•").strip()
                core = re.split(r"\s[–—-]\s|\(|,", entry)[0].strip().lower()
                grounded = bool(core) and core in cv_low
                if _PLACEHOLDER_RE.search(entry) or not grounded:
                    dropped += 1
                    continue
                kept.append(bl)
                kept_bullet = True
            if dropped:
                logger.info(
                    "w8: dropped %d ungrounded credential entr(ies) from %s",
                    dropped, line[3:].strip(),
                )
            if kept_bullet:
                out.append(line)
                out.extend(kept)
            # else: section had no grounded bullets → drop heading + body.
            i = j
            continue
        out.append(line)
        i += 1
    return "\n".join(out)
