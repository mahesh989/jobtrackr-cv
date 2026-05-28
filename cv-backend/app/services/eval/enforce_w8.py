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

from typing import Dict, List

from app.services.eval.role_families import RoleFamilyProfile


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


def restore_and_order(markdown: str, rf: RoleFamilyProfile) -> str:
    """Rename canonical headings back to the family's names, then reorder."""
    reverse = {v: k for k, v in _TO_CANONICAL.get(rf.id, {}).items()}
    restored = _rename_headings(markdown, reverse)
    return _reorder_sections(restored, rf.section_order)
