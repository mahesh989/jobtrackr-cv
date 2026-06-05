"""
Deterministic enforcement for the composition writer (W3).

These are the structural rules we learned (from the W2/W4 eval) NOT to trust a
prompt with. They run on the generated markdown, in code:

  • enforce_skills_section — dedup across the three skill lines, cap each line,
    and (for strict injection policies) drop skill items with no grounding in
    the original CV. Fixes W4's 25-item skills dump and the duplicate-skill
    issue, regardless of how the model behaved.

Category-label-agnostic: works whether the three lines are
Technical/Soft/Other, Clinical/Soft/Other, or Core/Soft/Other — it operates on
whatever "**Label:** items" lines appear inside ## Skills.

The existing production post-processors (_enforce_structure,
_inject_missing_skills, stamp_contact_line) still run too; this adds the
skills hygiene they don't cover.
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

# Per-line caps: (line 1 technical/clinical/core, line 2 soft, line 3 other).
# Soft + Other hard-capped at 6 — recruiter scanability is the goal; a CV
# with 8+ soft skills reads padded. Other Skills line is dropped entirely
# when empty (see enforce_skills_section's `kept` check), so a candidate
# with no tools/credentials worth surfacing won't get a dangling label.
DEFAULT_SKILL_CAPS: Tuple[int, int, int] = (14, 6, 6)

_SKILLS_HEADING_RE = re.compile(r"^##\s+skills\s*$", re.IGNORECASE)
# Matches both bullet-prefixed and bare bold-label lines:
#   "- **Care Skills:** items"  OR  "**Care Skills:** items"
_LABEL_LINE_RE = re.compile(r"^\s*(?:[-*•]\s+)?\*\*([^*]+?):\*\*\s*(.*)$")


def _split_items(rest: str) -> List[str]:
    """
    Split a skills-line body into items, respecting parentheses so
    'SQL (PostgreSQL, MySQL)' stays one item, and treating ' | ' sub-group
    separators as item boundaries.
    """
    items: List[str] = []
    buf: List[str] = []
    depth = 0
    i = 0
    while i < len(rest):
        ch = rest[i]
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif depth == 0 and ch == "," :
            items.append("".join(buf).strip())
            buf = []
        elif depth == 0 and ch == "|":
            # group separator — also an item boundary
            items.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        items.append("".join(buf).strip())
    return [it for it in items if it]


def _norm(item: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", item.lower()).strip()


def _content_words(item: str) -> List[str]:
    return [w for w in _norm(item).split() if len(w) >= 4]


# Category markers inside the Skills section. Two alternatives, bold tried
# first: (1) any bold '**Label:**' marker; (2) a BARE label of the form
# '<Capitalised word> Skills:' or '<Word> Knowledge:' (e.g. 'Care Skills:',
# 'Soft Skills:', 'Domain Knowledge:'). The bare alternative is what catches
# the LLM regression where all three categories land on one unbolded line.
_CATEGORY_MARKER_RE = re.compile(
    r"(\*\*[^*]+?:\*\*\s*"
    r"|[A-Z][a-zA-Z]*\s+(?:Skills|Knowledge)\s*:\s*)"
)


def _clean_category_name(marker: str) -> str:
    """Strip bold markers, whitespace and the trailing colon from a marker."""
    m = marker.strip().strip("*").strip()
    if m.endswith(":"):
        m = m[:-1].strip()
    return m


def _split_compound_skills(markdown: str) -> str:
    """
    If any single line inside the '## Skills' section contains multiple
    category markers — bold ('**Core Skills:** ... **Soft Skills:** ...') OR
    bare ('Care Skills: ... Soft Skills: ... Other Skills: ...') — split them
    onto separate lines and normalise every marker to the bold form.
    """
    lines = markdown.split("\n")
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip().lower() == "## skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown

    skills_lines: List[str] = []

    for i in range(skills_start + 1, skills_end):
        ln = lines[i]
        parts = _CATEGORY_MARKER_RE.split(ln)
        if len(parts) > 3:  # has at least 2 category markers
            first = parts[0].strip()
            if first:
                skills_lines.append(first)
            for j in range(1, len(parts), 2):
                cat = _clean_category_name(parts[j])
                content = parts[j + 1].strip().lstrip(",").strip() if j + 1 < len(parts) else ""
                skills_lines.append(f"- **{cat}:** {content}".rstrip())
        else:
            skills_lines.append(ln)

    new_lines = lines[:skills_start + 1] + skills_lines + lines[skills_end:]
    return "\n".join(new_lines)


def enforce_skills_section(
    markdown: str,
    original_cv_text: str = "",
    *,
    caps: Tuple[int, int, int] = DEFAULT_SKILL_CAPS,
    drop_ungrounded: bool = False,
) -> str:
    """
    Dedup + cap the three skill lines. When drop_ungrounded is True, also drop
    items whose content words are entirely absent from the original CV
    (conservative — keeps anything sharing a word with the CV).
    """
    markdown = _split_compound_skills(markdown)
    lines = markdown.split("\n")

    # Locate ## Skills section.
    start = next((i for i, ln in enumerate(lines) if _SKILLS_HEADING_RE.match(ln.strip())), None)
    if start is None:
        return markdown
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    cv_norm = f" {_norm(original_cv_text)} " if original_cv_text else ""
    seen: set[str] = set()           # cross-line dedup
    line_idx = 0                      # which of the 3 category lines we're on
    drop_idx: set[int] = set()        # empty category lines to remove entirely

    for i in range(start + 1, end):
        m = _LABEL_LINE_RE.match(lines[i])
        if not m:
            continue
        label, rest = m.group(1).strip(), m.group(2).strip()
        cap = caps[line_idx] if line_idx < len(caps) else caps[-1]
        line_idx += 1

        kept: List[str] = []
        for item in _split_items(rest):
            key = _norm(item)
            if not key or key in seen:
                continue
            if drop_ungrounded and cv_norm:
                words = _content_words(item)
                if words and not any(f" {w} " in cv_norm for w in words):
                    continue  # no content word grounded in the CV → drop
            seen.add(key)
            kept.append(item)
            if len(kept) >= cap:
                break

        # Never emit a dangling "**Label:**" with no items — if a category has
        # nothing genuine to show, drop the whole line rather than enforce an
        # empty section the user didn't earn.
        if not kept:
            drop_idx.add(i)
            continue
        lines[i] = f"- **{label}:** " + ", ".join(kept)

    if drop_idx:
        lines = [ln for idx, ln in enumerate(lines) if idx not in drop_idx]

    return "\n".join(lines)


def reroute_skills_by_lexicon(markdown: str, vertical: Optional[str]) -> str:
    """Move Skills-section entries to the lexicon-correct line.

    classify(entry, vertical) is the authority on category. Entries the
    lexicon doesn't recognise stay on their current line. Runs only when a
    vertical lexicon is available (vertical != None).

    Examples (nursing):
        'Clinical Documentation' on Other Skills → Care Skills
        'Patient Care' on Other Skills → Care Skills
        'Elderly Care' on Other Skills → Care Skills

    Call AFTER _strip_non_skill_phrases and BEFORE _normalise_skills_case.
    Follow with enforce_skills_section to re-cap any line that gained items.
    """
    if not vertical:
        return markdown

    from app.services.skills.classifier import classify as lex_classify, is_noise as lex_is_noise

    lines = markdown.split("\n")

    start = next(
        (i for i, ln in enumerate(lines) if _SKILLS_HEADING_RE.match(ln.strip())),
        None,
    )
    if start is None:
        return markdown

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    # Collect all skill lines in section order.
    skill_idxs: List[int] = []
    skill_labels: List[str] = []
    skill_items_list: List[List[str]] = []

    for i in range(start + 1, end):
        m = _LABEL_LINE_RE.match(lines[i])
        if m:
            skill_idxs.append(i)
            skill_labels.append(m.group(1).strip())
            skill_items_list.append(_split_items(m.group(2).strip()))

    if not skill_idxs:
        return markdown

    def _label_cat(label: str) -> str:
        ll = label.lower()
        if "soft" in ll:
            return "soft_skills"
        if "other" in ll or "technical" in ll:
            return "technical"
        return "domain_knowledge"  # Care, Clinical, Core, Domain, etc.

    # Redistribute entries: classify each, route to lexicon-correct category.
    cat_buckets: dict = {"domain_knowledge": [], "soft_skills": [], "technical": []}
    seen: set = set()

    for label, items in zip(skill_labels, skill_items_list):
        src_cat = _label_cat(label)
        for item in items:
            key = item.lower().strip()
            if not key or key in seen:
                continue
            seen.add(key)
            if lex_is_noise(item) is not None:
                continue  # belt-and-suspenders: should already be stripped upstream
            c = lex_classify(item, vertical)
            tgt_cat = c.category if (c is not None and c.is_skill) else src_cat
            cat_buckets[tgt_cat].append(item)

    # Rebuild lines in-place (preserve the existing label name on each line).
    for line_idx, label in zip(skill_idxs, skill_labels):
        cat = _label_cat(label)
        items = cat_buckets[cat]
        if items:
            lines[line_idx] = f"- **{label}:** " + ", ".join(items)
        else:
            # Empty line — enforce_skills_section will drop it on the next pass.
            lines[line_idx] = f"- **{label}:**"

    return "\n".join(lines)
