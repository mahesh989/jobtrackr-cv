"""Markdown -> section parsing, including experience headers.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
import re
from .primitives import (
    _is_italic_only_line,
    _norm,
    _split_pipes,
    _strip_md_emphasis,
)

# ---------------------------------------------------------------------------
# Markdown parser
# ---------------------------------------------------------------------------

def _parse_markdown(md: str) -> Tuple[Optional[str], Optional[str], List[Tuple[str, List[Dict]]]]:
    """
    Returns (name, contact, sections).
    sections[i] = (title, items) where each item is:
        {"type": "h3"|"bullet"|"paragraph", "text": str}
    """
    lines = md.splitlines()
    name: Optional[str] = None
    contact: Optional[str] = None
    sections: List[Tuple[str, List[Dict]]] = []
    cur_title: Optional[str] = None
    cur_items: List[Dict] = []
    header_done = False

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not header_done and stripped.startswith("# "):
            name = stripped[2:].strip()
            i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines) and not lines[i].strip().startswith("#"):
                contact = lines[i].strip()
                i += 1
            header_done = True
            continue

        if stripped.startswith("## "):
            if cur_title is not None:
                sections.append((cur_title, cur_items))
            cur_title = stripped[3:].strip()
            cur_items = []
            i += 1
            continue

        if stripped.startswith("### "):
            cur_items.append({"type": "h3", "text": stripped[4:].strip()})
            i += 1
            continue

        if stripped.startswith(("- ", "* ")):
            cur_items.append({"type": "bullet", "text": stripped[2:].strip()})
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        if cur_title is not None or header_done:
            cur_items.append({"type": "paragraph", "text": stripped})
        i += 1

    if cur_title is not None:
        sections.append((cur_title, cur_items))

    return name, contact, sections


# ---------------------------------------------------------------------------
# Contact line
# ---------------------------------------------------------------------------

_DOMAIN_LABELS: Dict[str, str] = {
    "linkedin.com":  "LinkedIn",
    "github.com":    "GitHub",
    "github.io":     "GitHub",
    "behance.net":   "Behance",
    "dribbble.com":  "Dribbble",
}


def _contact_label(url: str) -> str:
    low = url.lower()
    for domain, label in _DOMAIN_LABELS.items():
        if domain in low:
            return label
    return re.sub(r'^https?://(www\.)?', '', url).rstrip("/")


# ---------------------------------------------------------------------------
# Entry header parsing — handles BOTH single-line and two-line shapes
# ---------------------------------------------------------------------------

class _EntryHeader:
    """Parsed entry header. left_top/right_top render row 1; left_bot/right_bot row 2."""
    def __init__(
        self,
        left_top: str = "",
        right_top: str = "",
        left_bot: str = "",
        right_bot: str = "",
        consumed: int = 1,
        fingerprint: str = "",
    ):
        self.left_top = left_top
        self.right_top = right_top
        self.left_bot = left_bot
        self.right_bot = right_bot
        self.consumed = consumed
        self.fingerprint = fingerprint


def _parse_experience_header(items: List[Dict], i: int) -> Optional[_EntryHeader]:
    """
    Parse one Experience entry header starting at items[i]. Returns None if
    items[i] is not a header.

    Supported shapes:
      A) Two-line:
           ### Company | Location
           *Title | Tools | Date*
      B) Single-line (legacy):
           ### Company, Title | Tools | Location | Date
      C) Bold paragraph (fallback):
           **Company, Title | Tools | Location | Date**
    """
    item = items[i]
    if item["type"] not in ("h3", "paragraph"):
        return None

    text = _strip_md_emphasis(item["text"])
    if not text or "|" not in text:
        return None

    # Shape A: h3 has 1–2 pipes, next item is *italic* line
    if (
        item["type"] == "h3"
        and i + 1 < len(items)
        and items[i + 1]["type"] == "paragraph"
        and _is_italic_only_line(items[i + 1]["text"])
    ):
        top_parts = _split_pipes(text)
        bot_text = _strip_md_emphasis(items[i + 1]["text"])
        bot_parts = _split_pipes(bot_text)

        company = top_parts[0] if top_parts else ""
        location = " | ".join(top_parts[1:]) if len(top_parts) > 1 else ""

        if bot_parts:
            date = bot_parts[-1]
            title_tools = " | ".join(bot_parts[:-1])
        else:
            date = ""
            title_tools = ""

        fp = _norm(text + bot_text)
        return _EntryHeader(
            left_top=company, right_top=location,
            left_bot=title_tools, right_bot=date,
            consumed=2, fingerprint=fp,
        )

    # Shape B / C: single-line with all parts pipe-separated
    parts = _split_pipes(text)
    if len(parts) < 2:
        return None

    # Find the date part (rightmost part containing a 4-digit year or "Present")
    date_idx = -1
    for j in range(len(parts) - 1, -1, -1):
        if re.search(r'\b\d{4}\b', parts[j]) or re.search(r'\bpresent\b', parts[j], re.I):
            date_idx = j
            break

    if date_idx == -1:
        date = ""
        non_date = parts
    else:
        date = parts[date_idx]
        non_date = parts[:date_idx] + parts[date_idx + 1:]

    if len(non_date) >= 3:
        # Company,Title | Tools | Location
        company_title = non_date[0]
        tools = non_date[1]
        location = non_date[2]
    elif len(non_date) == 2:
        # Company,Title | Location
        company_title = non_date[0]
        tools = ""
        location = non_date[1]
    elif len(non_date) == 1:
        company_title = non_date[0]
        tools = ""
        location = ""
    else:
        company_title = text
        tools = ""
        location = ""

    if "," in company_title:
        comma = company_title.index(",")
        company = company_title[:comma].strip()
        title = company_title[comma + 1:].strip()
    else:
        company = company_title
        title = ""

    title_tools = title
    if tools:
        title_tools = f"{title} | {tools}" if title else tools

    return _EntryHeader(
        left_top=company, right_top=location,
        left_bot=title_tools, right_bot=date,
        consumed=1, fingerprint=_norm(text),
    )


# ---------------------------------------------------------------------------
# Section routing — strict canonical order
# ---------------------------------------------------------------------------

_SECTION_ALIASES: Dict[str, str] = {
    "career highlights":            "highlights",
    "professional summary":         "highlights",
    "career profile":               "highlights",
    "summary":                      "highlights",
    "profile":                      "highlights",
    "professional experience":      "experience",
    "experience":                   "experience",
    "work experience":              "experience",
    "education":                    "education",
    "skills":                       "skills",
    "technical skills":             "skills",
    "projects":                     "projects",
    "personal projects":            "projects",
    "key projects":                 "projects",
    "certifications":               "certifications",
    "professional certifications":  "certifications",
    "licences & certifications":    "certifications",
    "licenses & certifications":    "certifications",
    "awards":                       "awards",
    "recognition":                  "awards",
    "honours":                      "awards",
    "honors":                       "awards",
    "references":                   "references",
    "referees":                     "references",
}

_SECTION_ORDER = ["highlights", "experience", "education", "skills", "projects", "certifications", "awards", "references"]

_SECTION_LABELS = {
    "highlights":     "Profile",
    "experience":     "Experience",
    "education":      "Education",
    "skills":         "Skills",
    "projects":       "Projects",
    "certifications": "Professional Certifications",
    "awards":         "Awards",
    "references":     "References",
}
