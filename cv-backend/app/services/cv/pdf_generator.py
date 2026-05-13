"""
CV PDF generator — converts the AI-produced markdown tailored CV to a
professionally formatted A4 PDF using ReportLab Platypus.

Formatting spec:
  - A4 (595.28 × 841.89 pt), 0.5 in (36 pt) margins all sides
  - Usable width = 523.28 pt
  - Two-column grid: left = usable_width − 130 pt (right col)
  - Font: Helvetica family (built-in to PDF spec, no font files needed)
  - Body 10 pt / 11 pt leading; Name 20 pt; Section headers 10 pt bold uppercase
  - Colors: body #000000, headers/titles #1a1a1a, links #000080
  - Bullet column 16 pt, text column remainder
  - Spacing: section_above=14pt, subsection_gap=10pt, bullet_gap=2.5pt,
            after_bullets=8pt, line_after_section=4pt, education_gap=4pt
  - Strict section order: Career Highlights → Experience → Education →
                          Skills → Projects → Certifications
"""
from __future__ import annotations

import io
import re
import logging
from typing import Any, Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PAGE_W, PAGE_H = A4              # 595.28 × 841.89 pt
MARGIN = 0.5 * inch              # 36 pt
USABLE_W = PAGE_W - 2 * MARGIN   # 523.28 pt
RIGHT_COL_W = 1.8 * inch         # 129.6 pt
LEFT_COL_W = USABLE_W - RIGHT_COL_W

BULLET_COL_W = 16
TEXT_COL_W = USABLE_W - BULLET_COL_W

# Colours
C_BODY = colors.HexColor("#000000")
C_HEADER = colors.HexColor("#1a1a1a")
C_LINK = colors.HexColor("#000080")
C_RULE = colors.HexColor("#000000")

# Spacing (pt)
SECTION_ABOVE = 14
SUBSECTION_GAP = 10
BULLET_GAP = 2.5
SKILLS_LINE_GAP = BULLET_GAP + 2   # extra breathing room between skill categories
AFTER_BULLETS = 8
LINE_AFTER_SECTION = 4
RULE_TITLE_SPACER = 2
EDUCATION_GAP = 4

# ---------------------------------------------------------------------------
# Font — Helvetica only (built-in to the PDF spec, always available, no font
# files to register, no environment drift between dev and prod).
# ---------------------------------------------------------------------------
F_REGULAR    = "Helvetica"
F_BOLD       = "Helvetica-Bold"
F_ITALIC     = "Helvetica-Oblique"
F_BOLDITALIC = "Helvetica-BoldOblique"

# ---------------------------------------------------------------------------
# Paragraph styles
# ---------------------------------------------------------------------------

def _ps(name: str, **kwargs) -> ParagraphStyle:
    defaults = {
        "fontName": F_REGULAR,
        "fontSize": 10,
        "leading": 11,
        "textColor": C_BODY,
        "spaceAfter": 0,
        "spaceBefore": 0,
        "leftIndent": 0,
        "rightIndent": 0,
        "firstLineIndent": 0,
        "wordWrap": "LTR",
    }
    defaults.update(kwargs)
    return ParagraphStyle(name, **defaults)


STYLES: Dict[str, ParagraphStyle] = {
    "name":         _ps("name", fontName=F_BOLD, fontSize=20, leading=22,
                        alignment=1, textColor=C_HEADER),
    "contact":      _ps("contact", alignment=1),
    "section":      _ps("section", fontName=F_BOLD, textColor=C_HEADER),
    "body":         _ps("body", alignment=4),                       # justify
    "bullet_sym":   _ps("bullet_sym"),
    "bullet_text":  _ps("bullet_text", alignment=4),                # justify
    "company_row":  _ps("company_row", fontName=F_BOLD, textColor=C_HEADER),
    "job_title":    _ps("job_title", fontName=F_ITALIC, textColor=C_HEADER),
    "date_right":   _ps("date_right", alignment=2),                 # right
    "degree":       _ps("degree", fontName=F_BOLD, textColor=C_HEADER),
    "institution":  _ps("institution", fontName=F_ITALIC),
    "project_name": _ps("project_name", fontName=F_BOLD, textColor=C_HEADER),
    "project_meta": _ps("project_meta", fontName=F_ITALIC),
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NO_PAD_TABLE = TableStyle([
    ("LEFTPADDING",   (0, 0), (-1, -1), 0),
    ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
    ("TOPPADDING",    (0, 0), (-1, -1), 0),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ("VALIGN",        (0, 0), (-1, -1), "TOP"),
])


def _spacer(h: float) -> Spacer:
    return Spacer(1, h)


def _hr() -> Table:
    hr = HRFlowable(width=USABLE_W, thickness=0.5, color=C_RULE, hAlign="LEFT")
    t = Table([[hr]], colWidths=[USABLE_W])
    t.setStyle(_NO_PAD_TABLE)
    return t


def _section_header(title: str) -> List[Any]:
    p = Paragraph(title.upper(), STYLES["section"])
    t = Table([[p]], colWidths=[USABLE_W])
    t.setStyle(_NO_PAD_TABLE)
    return [
        _spacer(SECTION_ABOVE),
        t,
        _spacer(RULE_TITLE_SPACER),
        _hr(),
        _spacer(LINE_AFTER_SECTION),
    ]


def _two_col(left: Paragraph, right: Paragraph) -> Table:
    t = Table([[left, right]], colWidths=[LEFT_COL_W, RIGHT_COL_W])
    t.setStyle(_NO_PAD_TABLE)
    return t


def _bullet_row(text_para: Paragraph) -> Table:
    sym = Paragraph("•", STYLES["bullet_sym"])
    t = Table([[sym, text_para]], colWidths=[BULLET_COL_W, TEXT_COL_W])
    t.setStyle(_NO_PAD_TABLE)
    return t


def _ensure_https(url: str) -> str:
    if url and "://" not in url:
        return "https://" + url
    return url


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inline_markup(text: str, base_style: ParagraphStyle) -> Paragraph:
    """Convert markdown inline (**bold**, *italic*, [link](url)) → ReportLab XML."""
    result = _escape(text)
    result = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', result)
    result = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', result)
    result = re.sub(r'(?<![\*\w])\*([^*\n]+?)\*(?!\*)', r'<i>\1</i>', result)
    result = re.sub(r'(?<![\w_])_([^_\n]+?)_(?![\w_])', r'<i>\1</i>', result)

    def _link_repl(m: re.Match) -> str:
        label = m.group(1)
        url = _ensure_https(m.group(2))
        return f'<a href="{url}" color="{C_LINK.hexval()}">{label}</a>'
    result = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', _link_repl, result)
    return Paragraph(result, base_style)


def _norm(text: str) -> str:
    """Aggressive fingerprint for dedup: lowercase + alphanumerics only."""
    return re.sub(r'[^a-z0-9]', '', text.lower())


def _strip_md_emphasis(text: str) -> str:
    """Remove *...* and **...** markers so dedup/parsing sees clean text."""
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    s = re.sub(r'\*(.+?)\*', r'\1', s)
    s = re.sub(r'_(.+?)_', r'\1', s)
    return s.strip()


def _is_italic_only_line(text: str) -> bool:
    """True if the entire (stripped) line is wrapped in single * markers."""
    s = text.strip()
    return (
        len(s) >= 4
        and s.startswith("*")
        and s.endswith("*")
        and not s.startswith("**")
        and not s.endswith("**")
    )


def _split_pipes(text: str) -> List[str]:
    return [p.strip() for p in re.split(r'\s*\|\s*', text) if p.strip()]


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


def _render_contact_line(contact: str) -> List[Any]:
    parts = [p.strip() for p in contact.split("|") if p.strip()]
    fragments: List[str] = []
    for part in parts:
        if "@" in part and "." in part and " " not in part:
            fragments.append(f'<a href="mailto:{part}" color="#000080">{_escape(part)}</a>')
        elif re.search(r'(linkedin\.com|github\.com|github\.io|behance|dribbble|https?://|www\.)', part, re.I):
            url = _ensure_https(part)
            label = _contact_label(url)
            fragments.append(
                f'<a href="{url.replace("&", "&amp;")}" color="#000080">{_escape(label)}</a>'
            )
        else:
            fragments.append(_escape(part))
    return [Paragraph(" | ".join(fragments), STYLES["contact"])]


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
# Section renderers
# ---------------------------------------------------------------------------

def _render_bullets(items: List[Dict], start: int, end: int) -> List[Any]:
    out: List[Any] = []
    for j, item in enumerate(items[start:end], start=start):
        para = _inline_markup(item["text"], STYLES["bullet_text"])
        out.append(_bullet_row(para))
        if j < end - 1:
            out.append(_spacer(BULLET_GAP))
    return out


def _render_highlights(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    seen: set = set()
    bullet_paras: List[Paragraph] = []

    for item in items:
        text = item["text"].strip()
        if not text:
            continue
        fp = _norm(text)
        if fp in seen:
            continue
        seen.add(fp)

        if item["type"] == "bullet":
            if text.lower().startswith("skills:"):
                colon = text.index(":")
                skills_text = text[colon + 1:].strip()
                bullet_paras.append(Paragraph(
                    f"Skills: <i>{_escape(skills_text)}</i>",
                    STYLES["bullet_text"],
                ))
            else:
                bullet_paras.append(_inline_markup(text, STYLES["bullet_text"]))
        else:
            # paragraph (summary text)
            if bullet_paras:
                # already started bullets — treat as another bullet
                bullet_paras.append(_inline_markup(text, STYLES["bullet_text"]))
            else:
                out.append(_inline_markup(text, STYLES["body"]))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(BULLET_GAP))
    return out


def _render_experience(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        # Try to parse as entry header
        header = _parse_experience_header(items, i)
        if header is not None:
            if header.fingerprint in seen_fp:
                # Duplicate header — skip the lines it consumed
                i += header.consumed
                continue
            seen_fp.add(header.fingerprint)

            if entry_count > 0:
                out.append(_spacer(SUBSECTION_GAP))
            entry_count += 1

            # Row 1: Company (bold) | Location
            out.append(_two_col(
                Paragraph(_escape(header.left_top), STYLES["company_row"]),
                Paragraph(_escape(header.right_top), STYLES["date_right"]),
            ))
            # Row 2: Title|Tools (italic) | Date
            if header.left_bot or header.right_bot:
                out.append(_two_col(
                    Paragraph(_escape(header.left_bot), STYLES["job_title"]),
                    Paragraph(_escape(header.right_bot), STYLES["date_right"]),
                ))

            i += header.consumed

            # Collect bullets for this entry
            bullet_start = i
            while i < len(items) and items[i]["type"] == "bullet":
                fp = _norm(items[i]["text"])
                # Note: bullet dedup is per-entry — duplicates would just be
                # different recommendations, so we don't dedup bullets globally.
                i += 1
            bullet_end = i
            if bullet_end > bullet_start:
                out.extend(_render_bullets(items, bullet_start, bullet_end))
                out.append(_spacer(AFTER_BULLETS))
            continue

        # Stray bullet
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], STYLES["bullet_text"])))
            out.append(_spacer(BULLET_GAP))
            i += 1
            continue

        # Stray paragraph that's NOT a duplicate header — render as body
        text = _strip_md_emphasis(item["text"])
        fp = _norm(text)
        if fp in seen_fp:
            i += 1
            continue
        # If it has a date pattern but didn't parse as a header, skip silently.
        if re.search(r'\b(19|20)\d{2}\b', text) and "|" in text:
            i += 1
            continue
        out.append(_inline_markup(item["text"], STYLES["body"]))
        i += 1

    return out


def _render_education(items: List[Dict]) -> List[Any]:
    """
    Education entries. Supports:
      A) Bullet all-in-one:
           - **Degree** | Institution, Location | Year | GPA: x
      B) Two-line h3 + italic:
           ### Institution | Location
           *Degree | Year – Year* (or with GPA)
      C) h3 + plain-paragraph companion:
           ### Degree | Institution
           Institution line / Year line
    Output: Row1 = Bold Degree (left) | Year (right)
            Row2 = Italic Institution, Location (left) | GPA (right)
    """
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0

    def _emit(degree: str, institution: str, location: str, year: str, gpa: str) -> None:
        nonlocal entry_count
        if not degree:
            return
        fp = _norm(degree + institution + year)
        if fp in seen_fp:
            return
        seen_fp.add(fp)
        if entry_count > 0:
            out.append(_spacer(EDUCATION_GAP))
        entry_count += 1

        out.append(_two_col(
            Paragraph(_escape(degree), STYLES["degree"]),
            Paragraph(_escape(year), STYLES["date_right"]),
        ))
        inst_loc = institution
        if location and location not in institution:
            inst_loc = f"{institution}, {location}" if institution else location
        if inst_loc or gpa:
            out.append(_two_col(
                Paragraph(_escape(inst_loc), STYLES["institution"]),
                Paragraph(_escape(gpa), STYLES["date_right"]),
            ))

    def _extract_year(parts: List[str]) -> str:
        for p in parts:
            if re.search(r'\b(19|20)\d{2}\b', p):
                return p
        return ""

    def _extract_gpa(parts: List[str]) -> str:
        for p in parts:
            if re.match(r'(?i)^\s*(c?gpa)\b', p):
                return p
        return ""

    i = 0
    while i < len(items):
        item = items[i]
        text = _strip_md_emphasis(item["text"]).strip()
        if not text:
            i += 1
            continue

        # Shape B: ### Institution | Location  +  *Degree | Year*
        if (
            item["type"] == "h3"
            and i + 1 < len(items)
            and items[i + 1]["type"] == "paragraph"
            and _is_italic_only_line(items[i + 1]["text"])
        ):
            top_parts = _split_pipes(text)
            bot_text = _strip_md_emphasis(items[i + 1]["text"])
            bot_parts = _split_pipes(bot_text)
            institution = top_parts[0] if top_parts else ""
            location = " | ".join(top_parts[1:]) if len(top_parts) > 1 else ""
            degree = bot_parts[0] if bot_parts else ""
            year = _extract_year(bot_parts[1:]) or (bot_parts[1] if len(bot_parts) > 1 else "")
            gpa = _extract_gpa(bot_parts)
            _emit(degree, institution, location, year, gpa)
            i += 2
            continue

        parts = _split_pipes(text)

        # Shape A: bullet/paragraph all-in-one with year
        if re.search(r'\b(19|20)\d{2}\b', text) and len(parts) >= 2:
            degree = parts[0]
            year = _extract_year(parts[1:])
            gpa = _extract_gpa(parts[1:])
            inst_parts = [
                p for p in parts[1:]
                if p != year and not re.match(r'(?i)^\s*(c?gpa)\b', p)
            ]
            if inst_parts:
                # institution may itself have ", Location"
                first = inst_parts[0]
                if "," in first and len(inst_parts) == 1:
                    seg = [s.strip() for s in first.split(",")]
                    institution = ", ".join(seg[:-1]) if len(seg) > 1 else first
                    location = seg[-1] if len(seg) > 1 else ""
                else:
                    institution = first
                    location = inst_parts[1] if len(inst_parts) > 1 else ""
            else:
                institution = ""
                location = ""
            _emit(degree, institution, location, year, gpa)
            i += 1
            continue

        # Shape C / fallback: try degree/institution split via pipes
        if len(parts) >= 2:
            degree = parts[0]
            institution = parts[1]
            location = parts[2] if len(parts) > 2 else ""
            year = _extract_year(parts[1:])
            gpa = _extract_gpa(parts[1:])
            _emit(degree, institution, location, year, gpa)
            i += 1
            continue

        # Single-token degree line — peek at next item for institution/year
        degree = text
        institution = location = year = gpa = ""
        if i + 1 < len(items):
            nxt = _strip_md_emphasis(items[i + 1]["text"])
            np = _split_pipes(nxt)
            if np and items[i + 1]["type"] != "h3":
                year = _extract_year(np)
                gpa = _extract_gpa(np)
                non_year = [p for p in np if p != year and not re.match(r'(?i)^\s*(c?gpa)\b', p)]
                institution = non_year[0] if non_year else ""
                location = non_year[1] if len(non_year) > 1 else ""
                i += 1
        _emit(degree, institution, location, year, gpa)
        i += 1

    return out


def _render_skills(items: List[Dict]) -> List[Any]:
    """
    Skills bullets, format: - **Category**: items, items, items
    Strip ** markers cleanly so they never appear as literal asterisks.
    """
    out: List[Any] = []
    bullet_paras: List[Paragraph] = []
    pending_cat: Optional[str] = None
    seen_fp: set = set()

    for item in items:
        raw = _strip_md_emphasis(item["text"]).strip()
        if not raw:
            continue
        fp = _norm(raw)
        if fp in seen_fp:
            continue
        seen_fp.add(fp)

        if ":" in raw:
            colon = raw.index(":")
            cat = raw[:colon].strip()
            skills = raw[colon + 1:].strip()
            if skills:
                if pending_cat is not None:
                    pending_cat = None
                bullet_paras.append(Paragraph(
                    f"<b>{_escape(cat)}:</b> {_escape(skills)}",
                    STYLES["bullet_text"],
                ))
            else:
                pending_cat = cat
        else:
            if pending_cat is not None:
                bullet_paras.append(Paragraph(
                    f"<b>{_escape(pending_cat)}:</b> {_escape(raw)}",
                    STYLES["bullet_text"],
                ))
                pending_cat = None
            else:
                bullet_paras.append(_inline_markup(item["text"], STYLES["bullet_text"]))

    if pending_cat is not None:
        bullet_paras.append(Paragraph(
            f"<b>{_escape(pending_cat)}:</b>",
            STYLES["bullet_text"],
        ))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(SKILLS_LINE_GAP))
    return out


def _render_projects(items: List[Dict]) -> List[Any]:
    """
    Project headers may be h3 or bold paragraph. Format:
      ### Name – Subtitle | Tools | Date | URL
    or two-line:
      ### Name – Subtitle | Tools
      *Context | Date | URL*
    Followed by bullets.
    """
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        if item["type"] in ("h3", "paragraph") and "|" in _strip_md_emphasis(item["text"]):
            text = _strip_md_emphasis(item["text"])
            fp = _norm(text)

            # Two-line shape?
            if (
                item["type"] == "h3"
                and i + 1 < len(items)
                and items[i + 1]["type"] == "paragraph"
                and _is_italic_only_line(items[i + 1]["text"])
            ):
                top_parts = _split_pipes(text)
                bot_text = _strip_md_emphasis(items[i + 1]["text"])
                bot_parts = _split_pipes(bot_text)
                fp = _norm(text + bot_text)
                consumed = 2
                left_text = " | ".join(top_parts)
                right_text = " | ".join(bot_parts)
            else:
                parts = _split_pipes(text)
                # Right column: trailing parts that look like a date/URL/short
                # status descriptor
                left_parts = list(parts)
                right_parts: List[str] = []
                while left_parts:
                    last = left_parts[-1]
                    is_date = bool(re.search(r'\b(19|20)\d{2}\b', last))
                    is_url = bool(re.search(r'https?://', last, re.I))
                    is_status = bool(re.match(r'(?i)^(live|production|live production|research|in progress|wip|completed|ongoing)$', last.strip()))
                    if is_date or is_url or is_status:
                        right_parts.insert(0, left_parts.pop())
                    else:
                        break
                consumed = 1
                left_text = " | ".join(left_parts)
                right_text = " | ".join(right_parts)

                # Promote em-dash context from left to right.
                # Match ONLY the em-dash (—, U+2014); preserve en-dashes (–)
                # that appear inside project names. Use the LAST occurrence so
                # nested em-dashes still split correctly.
                em_matches = list(re.finditer(r'\s+—\s+(.+?)$', left_text))
                if em_matches:
                    em = em_matches[-1]
                    ctx = em.group(1).strip()
                    left_text = left_text[:em.start()].strip()
                    right_text = (ctx + (" | " + right_text if right_text else "")).strip(" |")

            if fp in seen_fp:
                i += consumed
                # Still skip bullets that follow? No — bullets follow the
                # FIRST occurrence; the duplicate has none. Just skip header.
                continue
            seen_fp.add(fp)

            if entry_count > 0:
                out.append(_spacer(SUBSECTION_GAP))
            entry_count += 1

            # Build right paragraph: replace any URL with "Link" hyperlink
            url_match = re.search(r'https?://\S+', right_text)
            date_text = re.sub(r'https?://\S+', '', right_text).strip(" |").strip()
            if url_match and date_text:
                right_html = (
                    f'{_escape(date_text)} | '
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>'
                )
                right_para = Paragraph(right_html, STYLES["date_right"])
            elif url_match:
                right_para = Paragraph(
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>',
                    STYLES["date_right"],
                )
            else:
                right_para = Paragraph(_escape(date_text), STYLES["date_right"])

            left_para = Paragraph(_escape(left_text), STYLES["project_name"])
            out.append(_two_col(left_para, right_para))

            i += consumed

            # Bullets
            b_start = i
            while i < len(items) and items[i]["type"] == "bullet":
                i += 1
            if i > b_start:
                out.extend(_render_bullets(items, b_start, i))
                out.append(_spacer(AFTER_BULLETS))
            continue

        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], STYLES["bullet_text"])))
            out.append(_spacer(BULLET_GAP))
            i += 1
            continue

        # Plain paragraph fallback (avoid emitting raw duplicate-looking lines)
        text = _strip_md_emphasis(item["text"])
        fp = _norm(text)
        if fp in seen_fp:
            i += 1
            continue
        out.append(_inline_markup(item["text"], STYLES["body"]))
        i += 1

    return out


def _render_certifications(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    bullets = [it for it in items if it["type"] in ("bullet", "paragraph")]
    seen_fp: set = set()
    rendered: List[Paragraph] = []
    for item in bullets:
        text = item["text"].strip()
        fp = _norm(text)
        if fp in seen_fp or not text:
            continue
        seen_fp.add(fp)
        rendered.append(_inline_markup(text, STYLES["bullet_text"]))
    for j, para in enumerate(rendered):
        out.append(_bullet_row(para))
        if j < len(rendered) - 1:
            out.append(_spacer(BULLET_GAP))
    return out


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
}

_SECTION_ORDER = ["highlights", "experience", "education", "skills", "projects", "certifications"]

_SECTION_LABELS = {
    "highlights":     "Profile",
    "experience":     "Experience",
    "education":      "Education",
    "skills":         "Skills",
    "projects":       "Projects",
    "certifications": "Professional Certifications",
}


def _render_section(stype: str, items: List[Dict]) -> List[Any]:
    if stype == "highlights":     return _render_highlights(items)
    if stype == "experience":     return _render_experience(items)
    if stype == "education":      return _render_education(items)
    if stype == "skills":         return _render_skills(items)
    if stype == "projects":       return _render_projects(items)
    if stype == "certifications": return _render_certifications(items)
    # Generic fallback
    out: List[Any] = []
    for item in items:
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], STYLES["bullet_text"])))
            out.append(_spacer(BULLET_GAP))
        else:
            out.append(_inline_markup(item["text"], STYLES["body"]))
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_pdf_from_markdown(markdown: str) -> bytes:
    """Convert AI-produced tailored CV markdown to PDF bytes."""
    name, contact, sections = _parse_markdown(markdown)

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
    )
    frame = Frame(
        MARGIN, MARGIN,
        USABLE_W, PAGE_H - 2 * MARGIN,
        leftPadding=0, rightPadding=0,
        topPadding=0, bottomPadding=0,
        id="main",
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame])])

    story: List[Any] = []

    if name:
        story.append(Paragraph(_escape(name), STYLES["name"]))
    else:
        story.append(Spacer(1, 24))

    if contact:
        story.extend(_render_contact_line(contact))

    # Bucket sections by canonical type (preserving the AI's title text)
    section_map: Dict[str, Tuple[str, List[Dict]]] = {}
    extras: List[Tuple[str, List[Dict]]] = []
    for title, items in sections:
        key = _SECTION_ALIASES.get(title.lower())
        if key and key not in section_map:
            section_map[key] = (title, items)
        elif key:
            # Same canonical key already populated — extend its items
            existing_title, existing_items = section_map[key]
            section_map[key] = (existing_title, existing_items + items)
        else:
            extras.append((title, items))

    # Render in canonical order
    for stype in _SECTION_ORDER:
        if stype not in section_map:
            continue
        ai_title, items = section_map[stype]
        if not items:
            continue
        # Use the AI's section title verbatim when reasonable; fall back to canonical label
        display_title = ai_title or _SECTION_LABELS[stype]
        story.extend(_section_header(display_title))
        story.extend(_render_section(stype, items))

    # Then unknown sections (preserve original order)
    for title, items in extras:
        if not items:
            continue
        story.extend(_section_header(title))
        story.extend(_render_section("_unknown_", items))

    doc.build(story)
    return buf.getvalue()
