"""Markdown section splitting, entry parsing and two-line block shapes.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
import re
from .results import (
    _result,
    _short,
)

# Section names we recognise (case-insensitive). The first match wins.
_PROFILE_ALIASES = ("career highlights", "highlights",
                    "professional summary", "professional profile",
                    "career profile", "profile", "summary")
_EXPERIENCE_ALIASES = ("experience", "work experience",
                       "professional experience")
_EDUCATION_ALIASES = ("education",)
_PROJECTS_ALIASES = ("projects", "personal projects", "side projects")
_SKILLS_ALIASES = ("skills", "technical skills", "core skills")


# ---------------------------------------------------------------------------
# Markdown parsing helpers
# ---------------------------------------------------------------------------


def _split_sections(md: str) -> Dict[str, str]:
    """
    Split a markdown CV into {normalised_section_name: body_text}.

    Section name is the text after the level-2 heading, lowercased and
    whitespace-trimmed. Anything before the first ## heading (the contact
    block) is stored under the key "_preamble".
    """
    sections: Dict[str, str] = {}
    current_name = "_preamble"
    current_body: List[str] = []
    for line in md.splitlines():
        stripped = line.strip()
        # Section break only on ## headings, not deeper.
        if stripped.startswith("## ") and not stripped.startswith("### "):
            sections[current_name] = "\n".join(current_body).strip()
            current_name = stripped[3:].strip().lower()
            current_body = []
        else:
            current_body.append(line)
    sections[current_name] = "\n".join(current_body).strip()
    return sections


def _resolve_section(sections: Dict[str, str], aliases: Tuple[str, ...]) -> str:
    for alias in aliases:
        if alias in sections:
            return sections[alias]
    return ""


def _parse_entries(section_body: str) -> List[Dict[str, Any]]:
    """
    Parse an Experience or Projects section into discrete entries.

    An entry starts at an h3 heading (### ...) and runs through any
    subsequent subtitle lines and bullet lines until the next h3 heading.
    The italic subtitle line (*Title | Dates*) that follows the h3 heading
    is treated as part of the same entry — NOT as a separate entry.

    Returns: [{"title_line": str, "bullets": [str, ...]}, ...]
    """
    entries: List[Dict[str, Any]] = []
    current_title: str | None = None
    current_bullets: List[str] = []

    bullet_re = re.compile(r"^\s*[-•*]\s+(.*)$")
    # Matches italic subtitle lines like: *Data Analyst | July 2024 – Present*
    subtitle_re = re.compile(r"^\s*\*[^*]+\*\s*$")

    def _flush() -> None:
        if current_title is not None:
            entries.append({
                "title_line": current_title,
                "bullets":    list(current_bullets),
            })

    for raw in section_body.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        m = bullet_re.match(raw)
        if m:
            if current_title is None:
                # Orphan bullet without a preceding title — ignore.
                continue
            current_bullets.append(m.group(1).strip())
        elif subtitle_re.match(raw):
            # Italic subtitle line (e.g. *Title | Dates*) — belongs to
            # the current entry, not a new one. Skip silently.
            continue
        else:
            _flush()
            current_title = stripped
            current_bullets = []

    _flush()
    return entries


def _word_count(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


# ---------------------------------------------------------------------------
# Shape-consistency gates — Education and Projects must use the
# two-line "### Title | Right\n*Subline | Right*" rhythm uniformly.
# ---------------------------------------------------------------------------


# A header line that opens an entry: "### Something" (Education uses h3
# the same way Experience and Projects do). We accept either "### " or
# bold-only "**...**" lines as title candidates because the writer
# occasionally drops the heading level.
_ENTRY_TITLE_RE = re.compile(r"^\s*(?:###\s+|\*\*[^*]+\*\*\s*$)")
_ITALIC_SUBLINE_RE = re.compile(r"^\s*\*[^*][^\n]*[^*]\*\s*$")


def _parse_two_line_blocks(body: str) -> List[Dict[str, Any]]:
    """
    Parse a section body into blocks of {title_line, subline, has_subline}.

    A block starts at a title line (### ... or **...**) and the next
    non-empty line is treated as its subline if and only if that line is
    a single italic paragraph (`*...*`). Anything else means the entry
    skipped the second line.
    """
    blocks: List[Dict[str, Any]] = []
    lines = [ln for ln in body.splitlines()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if _ENTRY_TITLE_RE.match(line):
            title = line.strip()
            subline = ""
            has_subline = False
            # Look ahead past blank lines for the immediate next non-empty line.
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines):
                nxt = lines[j].strip()
                if _ITALIC_SUBLINE_RE.match(nxt):
                    subline = nxt
                    has_subline = True
                    i = j  # skip past the subline
            blocks.append({
                "title_line":  title,
                "subline":     subline,
                "has_subline": has_subline,
            })
        i += 1
    return blocks


def _check_two_line_shape(
    blocks: List[Dict[str, Any]], gate_name: str, section_label: str,
) -> Dict[str, Any]:
    """
    Shared shape-consistency check for Education and Projects sections.

    Reports FAIL when:
      - any entry is missing the italic subline, OR
      - entries are inconsistent: some have it, some don't.

    Reports PASS only when every entry has the two-line shape.
    """
    if not blocks:
        return _result(
            gate_name, "pass",
            f"No {section_label} entries to check.",
        )

    missing = [
        _short(b["title_line"].lstrip("#").strip().lstrip("*").rstrip("*"), 60)
        for b in blocks if not b["has_subline"]
    ]
    if not missing:
        return _result(
            gate_name, "pass",
            f"All {len(blocks)} {section_label} entry/entries use the "
            "two-line shape.",
        )
    if len(missing) == len(blocks):
        return _result(
            gate_name, "fail",
            f"None of the {len(blocks)} {section_label} entries use the "
            f"required two-line shape (`### Title | Right` then "
            f"`*Subline | Right*`): " + "; ".join(missing[:3])
            + (f" (+{len(missing) - 3} more)" if len(missing) > 3 else ""),
        )
    return _result(
        gate_name, "fail",
        f"{section_label} entries inconsistent — {len(missing)} of "
        f"{len(blocks)} missing the italic subline: "
        + "; ".join(missing[:3])
        + (f" (+{len(missing) - 3} more)" if len(missing) > 3 else ""),
    )
