"""
W8 — production-contract integration for the role-family engine.

The FROZEN production presentation contract lives in deterministic code:
  • app/services/pipeline/steps/tailored_cv._enforce_structure
      (3-role cap, 2-3 bullets/entry with word caps, ≤3 Education entries,
       strip-education-bullets, dedup project/highlights, certs-vs-projects)
  • app/services/pipeline/steps/tailored_cv._inject_missing_skills
  • app/services/cv.contact_line.stamp_contact_line
plus the eval gate stack (apply_w3_gates, enforce_skills_section).

ALL of that code is hard-wired to the TECH / master canonical section names:
    Career Highlights · Professional Experience · Education · Skills ·
    Projects · Certifications

To reuse that frozen contract VERBATIM for any role family (nursing, manual…)
WITHOUT forking or re-implementing it, W8 sandwiches the whole stack between a
rename to canonical names and a rename back to the family's names, then reorders
the sections to the family's section_order.

  family md ──rename→ canonical md ──[frozen production + gates]──►
  canonical md ──rename back→ family md ──reorder→ final md

This guarantees 1:1 fidelity with production (same caps, same bullet method,
same summary method) while making it general across role families and fixing
W7's one residual: it now leads nursing with "Registration & Licences" and
respects every family's section order.

Config-driven only — no per-case tokens, no per-CV logic (anti-overfit).
"""
from __future__ import annotations

import re
from typing import Dict, List

from app.services.eval.role_families import RoleFamilyProfile


# A genuine registration/licence reference (held by registered clinicians only —
# RN/EN with AHPRA). Distinct from a CLEARANCE (police check, NDIS, WWCC…) which
# an unregistered care worker can legitimately hold.
_REGISTRATION_TOKEN_RE = re.compile(
    r"\b(ahpra|registration number|reg(?:istration)?\.?\s*no|provider number|"
    r"registered nurse|enrolled nurse|licen[sc]e\s*(?:no|number))\b",
    re.IGNORECASE,
)
_CLEARANCE_TOKEN_RE = re.compile(
    r"\b(working with children|wwcc|blue card|police check|national police|"
    r"ndis worker|first aid certificate|cpr certificate|white card|"
    r"driver'?s? licen[sc]e)\b",
    re.IGNORECASE,
)
# A body that only states the ABSENCE of something (or a placeholder) — useless
# on a CV, so the whole section is dropped rather than shown.
_FILLER_BODY_RE = re.compile(
    r"^\W*(no\b|none\b|not\b|n/?a\b|nil\b|details? available|to be provided)",
    re.IGNORECASE,
)


# Per-family heading → production canonical heading. Only headings whose shape
# the production enforcers know how to police are mapped:
#   • the summary section → "Career Highlights" (2-sentence / 50-word method)
#   • the experience section → "Professional Experience" (3-role + bullet caps)
#   • the certs section → "Certifications" (certs-vs-projects rule)
# Headings the production contract has no opinion on (Registration & Licences,
# Availability) are intentionally NOT mapped — they pass through untouched and
# are simply placed by the section reorder at the end.
_TO_CANONICAL: Dict[str, Dict[str, str]] = {
    "nursing": {
        "Professional Summary": "Career Highlights",
        "Clinical Experience":  "Professional Experience",
        # Education / Skills / Certifications are already canonical.
    },
    "manual": {
        "Summary":                 "Career Highlights",
        "Work Experience":         "Professional Experience",
        "Certifications & Checks":  "Certifications",
        # Skills is already canonical.
    },
    # tech / master use canonical names natively → identity map (absent = {}).
}


def _rename_headings(markdown: str, mapping: Dict[str, str]) -> str:
    """Rename every '## <name>' heading per `mapping` (exact, case-sensitive)."""
    if not mapping:
        return markdown
    lines = markdown.split("\n")
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            name = ln[3:].strip()
            if name in mapping:
                lines[i] = "## " + mapping[name]
    return "\n".join(lines)


def to_canonical(markdown: str, rf: RoleFamilyProfile) -> str:
    """Rename a family's section headings to the production canonical names."""
    return _rename_headings(markdown, _TO_CANONICAL.get(rf.id, {}))


def _reorder_sections(markdown: str, section_order: List[str]) -> str:
    """
    Reorder the '## ' section blocks to match `section_order`. Sections present
    in the document but not named in section_order are appended afterwards in
    their original relative order (never dropped). The H1 + contact preamble
    above the first '## ' is preserved as-is.
    """
    lines = markdown.split("\n")
    first = next((i for i, l in enumerate(lines) if l.startswith("## ")), None)
    if first is None:
        return markdown

    preamble = lines[:first]

    blocks: List[tuple[str, List[str]]] = []
    cur_name: str | None = None
    cur: List[str] = []
    for ln in lines[first:]:
        if ln.startswith("## "):
            if cur_name is not None:
                blocks.append((cur_name, cur))
            cur_name = ln[3:].strip()
            cur = [ln]
        else:
            cur.append(ln)
    if cur_name is not None:
        blocks.append((cur_name, cur))

    ordered: List[List[str]] = []
    used: set[int] = set()
    for want in section_order:
        for idx, (name, blk) in enumerate(blocks):
            if idx in used:
                continue
            if name == want:
                ordered.append(blk)
                used.add(idx)
                break
    for idx, (name, blk) in enumerate(blocks):
        if idx not in used:
            ordered.append(blk)

    out = list(preamble)
    for blk in ordered:
        out.extend(blk)
    return "\n".join(out)


def _split_blocks(markdown: str) -> tuple[List[str], List[tuple[str, List[str]]]]:
    """Return (preamble_lines, [(section_name, block_lines), ...])."""
    lines = markdown.split("\n")
    first = next((i for i, l in enumerate(lines) if l.startswith("## ")), None)
    if first is None:
        return lines, []
    preamble = lines[:first]
    blocks: List[tuple[str, List[str]]] = []
    cur_name: str | None = None
    cur: List[str] = []
    for ln in lines[first:]:
        if ln.startswith("## "):
            if cur_name is not None:
                blocks.append((cur_name, cur))
            cur_name = ln[3:].strip()
            cur = [ln]
        else:
            cur.append(ln)
    if cur_name is not None:
        blocks.append((cur_name, cur))
    return preamble, blocks


def _body_is_empty(block_lines: List[str]) -> bool:
    """True if a section has no content beyond its heading and blank lines."""
    return all(not ln.strip() for ln in block_lines[1:])


def _merge_same_named_sections(markdown: str) -> str:
    """
    Merge sections that share a name (case-insensitive). The model sometimes
    emits both an empty family-named section AND the real content under the
    canonical name; after the rename-back that leaves two identically-named
    sections. We keep the FIRST occurrence's position and append every later
    same-named body into it, so the real content lands in the right slot
    instead of being dumped at the end. (Fixes the duplicate "Clinical
    Experience" defect the mismatch case exposed.)
    """
    preamble, blocks = _split_blocks(markdown)
    if not blocks:
        return markdown

    merged: List[tuple[str, List[str]]] = []
    index_by_key: Dict[str, int] = {}
    for name, blk in blocks:
        key = name.lower()
        if key in index_by_key:
            tgt = index_by_key[key]
            # Append this block's body (skip its heading line) to the target.
            body = [ln for ln in blk[1:]]
            if body:
                merged[tgt] = (merged[tgt][0], merged[tgt][1] + body)
        else:
            index_by_key[key] = len(merged)
            merged.append((name, list(blk)))

    out = list(preamble)
    for _name, blk in merged:
        out.extend(blk)
    return "\n".join(out)


def _drop_empty_sections(markdown: str) -> str:
    """Remove sections whose body is entirely blank (heading-only placeholders)."""
    preamble, blocks = _split_blocks(markdown)
    if not blocks:
        return markdown
    out = list(preamble)
    for _name, blk in blocks:
        if _body_is_empty(blk):
            continue
        out.extend(blk)
    return "\n".join(out)


def _relabel_registration(markdown: str, rf: RoleFamilyProfile) -> str:
    """
    Normalise the nursing "Registration & Licences" section by what it actually
    contains:
      • a genuine registration (AHPRA / RN / EN)        → keep the heading;
      • only clearances (police check / NDIS / WWCC…)   → relabel "Checks &
        Clearances" (the honest equivalent for unregistered care workers);
      • neither — i.e. a filler/negative body like "No registration listed" or
        "Details available on request"                  → DROP the section.
    A section that only states the ABSENCE of a credential is useless on a CV.
    """
    if rf.id != "nursing":
        return markdown
    preamble, blocks = _split_blocks(markdown)
    if not blocks:
        return markdown
    out = list(preamble)
    for name, blk in blocks:
        if name == "Registration & Licences":
            body_text = "\n".join(blk[1:])
            body_plain = re.sub(r"[*_>#`]", "", body_text).strip()
            has_reg = bool(_REGISTRATION_TOKEN_RE.search(body_text))
            has_clr = bool(_CLEARANCE_TOKEN_RE.search(body_text))
            is_filler = (not body_plain) or bool(_FILLER_BODY_RE.match(body_plain))
            if is_filler or (not has_reg and not has_clr):
                continue  # drop the section entirely
            if not has_reg and has_clr:
                blk = ["## Checks & Clearances"] + blk[1:]
        out.extend(blk)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Bachelor re-add — deterministic recovery of a dropped baseline credential.
#
# The composition prompt instructs the writer to ALWAYS keep the candidate's
# Bachelor's, but the model sometimes drops it (recurring across runs). The
# degree-relevance gate can prune but cannot re-add what the writer never
# emitted. This recovers the Bachelor from the ORIGINAL CV and inserts a
# two-line Education entry — best-effort, only when both a degree phrase AND an
# institution can be extracted (never emits a half-broken entry).
# ---------------------------------------------------------------------------

_BACHELOR_DETECT_RE = re.compile(r"\b(bachelor|b\.?sc|b\.?eng|b\.?a\.?\b|undergrad)", re.IGNORECASE)
_BACHELOR_WORD_RE = re.compile(r"\bbachelor\b|\bb\.?sc\b|\bb\.?eng\b", re.IGNORECASE)
_INSTITUTION_RE = re.compile(
    # "<Capitalised words> University/College/…"  OR  "University/College/… of <Place>"
    r"([A-Z][A-Za-z.&'’-]+(?:\s+[A-Z][A-Za-z.&'’-]+){0,5}\s+"
    r"(?:University|College|Institute|Polytechnic|Academy)"
    r"|(?:University|College|Institute)\s+of\s+[A-Z][A-Za-z'’-]+"
    r"(?:\s+[A-Z][A-Za-z'’-]+){0,3})"
)
_YEARRANGE_RE = re.compile(
    r"((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present|current)", re.IGNORECASE
)


def _extract_bachelor(cv_text: str):
    """Return (institution, location, degree, years) or None. Best-effort."""
    if not cv_text:
        return None
    m = _BACHELOR_WORD_RE.search(cv_text)
    if not m:
        return None
    start = m.start()

    tail = cv_text[start: start + 80]
    degree = re.split(r"[,\n|()]|\s\d{4}|\s{2,}", tail)[0].strip()
    degree = re.sub(r"\s+", " ", degree)
    if len(degree) < 5:
        return None

    # Institution: prefer one stated AFTER the degree; otherwise take the NEAREST
    # one BEFORE it. PDF-extracted CVs frequently jumble the Education block so
    # the institution precedes the degree (e.g. "…Tribhuvan University Kathmandu
    # Bachelor of Science…"). Forward-only search misses that.
    institution = None
    after = ""
    fwd = cv_text[start: start + 200]
    inst_m = _INSTITUTION_RE.search(fwd)
    if inst_m:
        institution = inst_m.group(1).strip()
        after = fwd[inst_m.end(): inst_m.end() + 50]
    else:
        back = cv_text[max(0, start - 160): start]
        back_matches = list(_INSTITUTION_RE.finditer(back))
        if back_matches:
            last = back_matches[-1]
            institution = last.group(1).strip()
            after = back[last.end(): last.end() + 50]
    if not institution:
        return None

    # The greedy institution match can swallow a PRECEDING degree's field words
    # when the source has no separator (e.g. "…Theoretical Physics Tribhuvan
    # University"). Strip leading academic field/degree tokens — an institution
    # name almost never begins with one.
    _FIELD_STOP = {
        "theoretical", "physics", "science", "sciences", "mathematics", "maths",
        "engineering", "arts", "commerce", "technology", "information", "data",
        "business", "management", "computer", "applied", "master", "masters",
        "master's", "bachelor", "bachelors", "phd", "doctor", "doctorate", "of",
        "in", "the", "and",
    }
    inst_words = institution.split()
    while len(inst_words) > 2 and inst_words[0].lower().strip(".,") in _FIELD_STOP:
        inst_words.pop(0)
    institution = " ".join(inst_words)

    loc = ""
    loc_m = re.match(r"\s*[,|]?\s*([A-Z][A-Za-z ,'’-]+?)(?:[|(\n0-9]|$)", after)
    if loc_m:
        cand = loc_m.group(1).strip().rstrip(",").strip()
        if 0 < len(cand) <= 40 and not _BACHELOR_DETECT_RE.search(cand):
            loc = cand

    # Years deliberately OMITTED: in jumbled Education blocks the year-range next
    # to the degree often belongs to a different degree, so a recovered Bachelor
    # carries degree + institution only — wrong years are worse than no years.
    return institution, loc, degree, ""


def ensure_bachelor(markdown: str, original_cv_text: str) -> str:
    """
    If the Education section has no Bachelor's but the original CV does, insert a
    reconstructed two-line Bachelor entry. Keeps the section ≤3 entries (drops
    the oldest surplus grad to make room). No-op when a Bachelor is already
    present or none can be reliably extracted.
    """
    lines = markdown.split("\n")
    edu_start = next(
        (i for i, l in enumerate(lines) if l.strip().lower() == "## education"), None
    )
    if edu_start is None:
        return markdown
    edu_end = next(
        (i for i in range(edu_start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    body = lines[edu_start + 1: edu_end]
    if _BACHELOR_DETECT_RE.search("\n".join(body)):
        return markdown  # already has a Bachelor

    extracted = _extract_bachelor(original_cv_text)
    if not extracted:
        return markdown
    institution, loc, degree, years = extracted

    while body and not body[-1].strip():
        body.pop()

    entry_idxs = [i for i, l in enumerate(body) if l.lstrip().startswith("### ")]
    if len(entry_idxs) >= 3:
        body = body[: entry_idxs[2]]  # keep first 2 entries, room for the Bachelor

    h3 = f"### {institution}" + (f" | {loc}" if loc else "")
    sub = f"*{degree}" + (f" | {years}" if years else "") + "*"
    body = body + ["", h3, sub]

    return "\n".join(lines[: edu_start + 1] + body + lines[edu_end:])


def restore_and_order(markdown: str, rf: RoleFamilyProfile) -> str:
    """
    Rename canonical headings back to the family's names, merge duplicate
    sections, drop empty placeholders, reorder to the family's section order,
    then relabel a filler Registration section. Order matters: reorder runs
    while the heading is still "Registration & Licences" (so section_order
    matches), and the relabel happens last as an in-place heading swap.
    """
    reverse = {v: k for k, v in _TO_CANONICAL.get(rf.id, {}).items()}
    md = _rename_headings(markdown, reverse)
    md = _merge_same_named_sections(md)
    md = _drop_empty_sections(md)
    md = _reorder_sections(md, rf.section_order)
    md = _relabel_registration(md, rf)
    return md
