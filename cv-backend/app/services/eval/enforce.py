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
from typing import List, Tuple

# Per-line caps: (line 1 technical/clinical/core, line 2 soft, line 3 other).
DEFAULT_SKILL_CAPS: Tuple[int, int, int] = (14, 6, 8)

_SKILLS_HEADING_RE = re.compile(r"^##\s+skills\s*$", re.IGNORECASE)
_LABEL_LINE_RE = re.compile(r"^\s*\*\*([^*]+?):\*\*\s*(.*)$")


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

        lines[i] = f"**{label}:** " + ", ".join(kept)

    return "\n".join(lines)
