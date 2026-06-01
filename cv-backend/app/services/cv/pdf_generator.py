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
# Adaptive layout — config-backed constants
# ---------------------------------------------------------------------------
import threading
from app.services.cv.adaptive_layout import (
    DEFAULT_CONFIG,
    LayoutConfig,
    FillMetrics,
    find_optimal_config,
)

PAGE_W, PAGE_H = A4              # 595.28 × 841.89 pt

# Thread-safe active config for the current render pass.
_cfg_lock = threading.Lock()
_active_cfg: LayoutConfig = DEFAULT_CONFIG

def _cfg() -> LayoutConfig:
    return _active_cfg

# Legacy constant names — now read from the active config so every helper
# keeps working without signature changes. These are accessed as module-level
# names, so we use a proxy pattern: helpers that need them call the name
# which is now a function or property access.
# For the handful of helpers that use them at TABLE CREATION time (not import
# time), we swap to reading _cfg() at call sites below.

# These remain true constants (not config-tuned):
MARGIN = 0.5 * inch              # default; overridden by _cfg().margin at render
USABLE_W = PAGE_W - 2 * MARGIN   # default; overridden by _cfg().usable_w at render
RIGHT_COL_W = 1.8 * inch         # default
LEFT_COL_W = USABLE_W - RIGHT_COL_W
BULLET_COL_W = 16
TEXT_COL_W = USABLE_W - BULLET_COL_W

# Colours (not config-tuned)
C_BODY = colors.HexColor("#000000")
C_HEADER = colors.HexColor("#1a1a1a")
C_LINK = colors.HexColor("#000080")
C_RULE = colors.HexColor("#000000")

# Spacing defaults — helpers below now read from _cfg() instead
SECTION_ABOVE = 14
SUBSECTION_GAP = 10
BULLET_GAP = 2.5
SKILLS_LINE_GAP = BULLET_GAP + 2
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
# Paragraph styles — rebuilt per config so font sizes adapt
# ---------------------------------------------------------------------------

_style_counter = 0  # ensures unique ReportLab style names per rebuild

def _make_styles(cfg: LayoutConfig) -> Dict[str, ParagraphStyle]:
    """Build a STYLES dict from the given LayoutConfig."""
    global _style_counter
    _style_counter += 1
    tag = f"_v{_style_counter}"

    def _ps(name: str, **kwargs) -> ParagraphStyle:
        defaults = {
            "fontName": F_REGULAR,
            "fontSize": cfg.body_font_size,
            "leading": cfg.body_leading,
            "textColor": C_BODY,
            "spaceAfter": 0,
            "spaceBefore": 0,
            "leftIndent": 0,
            "rightIndent": 0,
            "firstLineIndent": 0,
            "wordWrap": "LTR",
        }
        defaults.update(kwargs)
        return ParagraphStyle(name + tag, **defaults)

    return {
        "name":         _ps("name", fontName=F_BOLD,
                            fontSize=cfg.name_font_size,
                            leading=cfg.name_leading,
                            alignment=1, textColor=C_HEADER),
        "contact":      _ps("contact", alignment=1),
        "section":      _ps("section", fontName=F_BOLD,
                            fontSize=cfg.section_font_size,
                            textColor=C_HEADER),
        "body":         _ps("body", alignment=4),
        "bullet_sym":   _ps("bullet_sym"),
        "bullet_text":  _ps("bullet_text", alignment=4),
        "company_row":  _ps("company_row", fontName=F_BOLD, textColor=C_HEADER),
        "job_title":    _ps("job_title", fontName=F_ITALIC, textColor=C_HEADER),
        "date_right":   _ps("date_right", alignment=2),
        "degree":       _ps("degree", fontName=F_BOLD, textColor=C_HEADER),
        "institution":  _ps("institution", fontName=F_ITALIC),
        "project_name": _ps("project_name", fontName=F_BOLD, textColor=C_HEADER),
        "project_meta": _ps("project_meta", fontName=F_ITALIC),
    }

# Default styles (used when _active_cfg == DEFAULT_CONFIG)
STYLES: Dict[str, ParagraphStyle] = _make_styles(DEFAULT_CONFIG)

def _styles() -> Dict[str, ParagraphStyle]:
    """Return the styles dict for the active config."""
    return STYLES

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
    w = _cfg().usable_w
    hr = HRFlowable(width=w, thickness=0.5, color=C_RULE, hAlign="LEFT")
    t = Table([[hr]], colWidths=[w])
    t.setStyle(_NO_PAD_TABLE)
    return t


def _section_header(title: str) -> List[Any]:
    c = _cfg()
    w = c.usable_w
    p = Paragraph(title.upper(), _styles()["section"])
    t = Table([[p]], colWidths=[w])
    t.setStyle(_NO_PAD_TABLE)
    return [
        _spacer(c.section_above),
        t,
        _spacer(c.rule_title_spacer),
        _hr(),
        _spacer(c.line_after_section),
    ]


def _two_col(left: Paragraph, right: Paragraph) -> Table:
    c = _cfg()
    t = Table([[left, right]], colWidths=[c.left_col_w, c.right_col_w])
    t.setStyle(_NO_PAD_TABLE)
    return t


def _bullet_row(text_para: Paragraph) -> Table:
    c = _cfg()
    sym = Paragraph("•", _styles()["bullet_sym"])
    t = Table([[sym, text_para]], colWidths=[c.bullet_col_w, c.text_col_w])
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
    return [Paragraph(" | ".join(fragments), _styles()["contact"])]


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
        para = _inline_markup(item["text"], _styles()["bullet_text"])
        out.append(_bullet_row(para))
        if j < end - 1:
            out.append(_spacer(_cfg().bullet_gap))
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
                    _styles()["bullet_text"],
                ))
            else:
                bullet_paras.append(_inline_markup(text, _styles()["bullet_text"]))
        else:
            # paragraph (summary text)
            if bullet_paras:
                # already started bullets — treat as another bullet
                bullet_paras.append(_inline_markup(text, _styles()["bullet_text"]))
            else:
                out.append(_inline_markup(text, _styles()["body"]))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(_cfg().bullet_gap))
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
                out.append(_spacer(_cfg().subsection_gap))
            entry_count += 1

            # Row 1: Company (bold) | Location
            out.append(_two_col(
                Paragraph(_escape(header.left_top), _styles()["company_row"]),
                Paragraph(_escape(header.right_top), _styles()["date_right"]),
            ))
            # Row 2: Title|Tools (italic) | Date
            if header.left_bot or header.right_bot:
                out.append(_two_col(
                    Paragraph(_escape(header.left_bot), _styles()["job_title"]),
                    Paragraph(_escape(header.right_bot), _styles()["date_right"]),
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
                out.append(_spacer(_cfg().after_bullets))
            continue

        # Stray bullet
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
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
        out.append(_inline_markup(item["text"], _styles()["body"]))
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
            out.append(_spacer(_cfg().education_gap))
        entry_count += 1

        out.append(_two_col(
            Paragraph(_escape(degree), _styles()["degree"]),
            Paragraph(_escape(year), _styles()["date_right"]),
        ))
        inst_loc = institution
        if location and location not in institution:
            inst_loc = f"{institution}, {location}" if institution else location
        if inst_loc or gpa:
            out.append(_two_col(
                Paragraph(_escape(inst_loc), _styles()["institution"]),
                Paragraph(_escape(gpa), _styles()["date_right"]),
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


# Matches category markers embedded mid-bullet by the LLM writer. Two
# alternatives, bold tried first: a bold '**Category:**' marker, OR a BARE
# '<Word> Skills:' / '<Word> Knowledge:' label (the unbolded form the writer
# sometimes emits, which mashes all three categories onto one line).
# Example: 'Care Skills: x, y Soft Skills: a, b Other Skills: z'
_BOLD_CATEGORY_RE = re.compile(
    r'(\*\*[A-Z][^*:]+:\*\*\s*'
    r'|[A-Z][a-zA-Z]*\s+(?:Skills|Knowledge)\s*:\s*)'
)


def _split_compound_skills_item(original_text: str) -> List[str]:
    """
    Split a compound skills bullet that folds several categories into one line.

    LLM output patterns (bold or bare):
        'Care Skills: x, y **Soft Skills:** a, b **Other Skills:** z'
        'Care Skills: x, y Soft Skills: a, b Other Skills: z'
    both become:
        ['**Care Skills:** x, y', '**Soft Skills:** a, b', '**Other Skills:** z']

    Markers are normalised to the bold form so _strip_md_emphasis handles them
    downstream. If no category markers are found the text is returned unchanged.
    """
    parts = _BOLD_CATEGORY_RE.split(original_text)
    if len(parts) <= 1:
        return [original_text]     # no embedded categories — leave as-is

    result: List[str] = []
    # parts[0] = text before the first marker (empty when the line starts
    # with a category; non-empty only for stray leading prose).
    first = parts[0].strip()
    if first:
        result.append(first)

    # parts[1], parts[2], … = marker, items, marker, items, …
    for i in range(1, len(parts), 2):
        cat_name = parts[i].strip().strip("*").strip().rstrip(":").strip()
        items_text = parts[i + 1].strip().lstrip(",").strip() if i + 1 < len(parts) else ""
        result.append(f"**{cat_name}:** {items_text}" if items_text else f"**{cat_name}:**")

    return [r for r in result if r]


def _render_skills(items: List[Dict]) -> List[Any]:
    """
    Skills bullets, format: - **Category**: items, items, items
    Strip ** markers cleanly so they never appear as literal asterisks.

    Also handles compound bullets where the LLM writer folds multiple categories
    into one bullet using bold markers, e.g.:
        'Care Skills: x, y **Soft Skills:** a, b **Other Skills:** z'
    Each bold-marked category is expanded into its own bullet line.
    """
    out: List[Any] = []
    bullet_paras: List[Paragraph] = []
    pending_cat: Optional[str] = None
    seen_fp: set = set()

    # Pre-pass: expand compound items on the ORIGINAL text (before emphasis
    # strip) so the **Category:** markers are still present for detection.
    expanded: List[Dict] = []
    for item in items:
        original = item["text"].strip()
        sub_texts = _split_compound_skills_item(original)
        if len(sub_texts) > 1:
            for s in sub_texts:
                expanded.append({"type": item["type"], "text": s})
        else:
            expanded.append(item)

    for item in expanded:
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
                    _styles()["bullet_text"],
                ))
            else:
                pending_cat = cat
        else:
            if pending_cat is not None:
                bullet_paras.append(Paragraph(
                    f"<b>{_escape(pending_cat)}:</b> {_escape(raw)}",
                    _styles()["bullet_text"],
                ))
                pending_cat = None
            else:
                bullet_paras.append(_inline_markup(item["text"], _styles()["bullet_text"]))

    if pending_cat is not None:
        bullet_paras.append(Paragraph(
            f"<b>{_escape(pending_cat)}:</b>",
            _styles()["bullet_text"],
        ))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(_cfg().skills_line_gap))
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
                out.append(_spacer(_cfg().subsection_gap))
            entry_count += 1

            # Build right paragraph: replace any URL with "Link" hyperlink
            url_match = re.search(r'https?://\S+', right_text)
            date_text = re.sub(r'https?://\S+', '', right_text).strip(" |").strip()
            if url_match and date_text:
                right_html = (
                    f'{_escape(date_text)} | '
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>'
                )
                right_para = Paragraph(right_html, _styles()["date_right"])
            elif url_match:
                right_para = Paragraph(
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>',
                    _styles()["date_right"],
                )
            else:
                right_para = Paragraph(_escape(date_text), _styles()["date_right"])

            left_para = Paragraph(_escape(left_text), _styles()["project_name"])
            out.append(_two_col(left_para, right_para))

            i += consumed

            # Bullets
            b_start = i
            while i < len(items) and items[i]["type"] == "bullet":
                i += 1
            if i > b_start:
                out.extend(_render_bullets(items, b_start, i))
                out.append(_spacer(_cfg().after_bullets))
            continue

        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
            i += 1
            continue

        # Plain paragraph fallback (avoid emitting raw duplicate-looking lines)
        text = _strip_md_emphasis(item["text"])
        fp = _norm(text)
        if fp in seen_fp:
            i += 1
            continue
        out.append(_inline_markup(item["text"], _styles()["body"]))
        i += 1

    return out


def _render_awards(items: List[Dict]) -> List[Any]:
    """
    Awards entries — compact two-row layout:
      Row 1: Award Name (bold, left)         |  Organisation (right)
      Row 2: Description (body, left)        |  Date (right)

    Markdown shape produced by _normalise_awards_entries:
      ### Staff Excellence Award | August 2025
      *Jesmond Miranda Nursing Home*
      Recognised for hard work, caring nature, and positive attitude.

    Parsed as:  name = h3 left of "|", date = h3 right of "|",
                org  = the italic line, desc = the plain line.
    Org missing → row 1 right is blank. Desc missing → row 2 omitted.
    """
    out: List[Any] = []
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        if item["type"] != "h3":
            # Stray line before any h3 — render as body.
            if item["text"].strip():
                out.append(_inline_markup(item["text"], _styles()["body"]))
            i += 1
            continue

        # Parse the h3: "Award Name | Date" or just "Award Name".
        raw = _strip_md_emphasis(item["text"])
        if "|" in raw:
            name_part, date_part = raw.split("|", 1)
            award_name = name_part.strip()
            award_date = date_part.strip()
        else:
            award_name = raw.strip()
            award_date = ""
        i += 1

        # Optional italic line → organisation.
        award_org = ""
        if (i < len(items)
                and items[i]["type"] == "paragraph"
                and _is_italic_only_line(items[i]["text"])):
            award_org = _strip_md_emphasis(items[i]["text"])
            i += 1

        # Optional plain line → description.
        award_desc = ""
        if (i < len(items)
                and items[i]["type"] == "paragraph"
                and not _is_italic_only_line(items[i]["text"])):
            award_desc = items[i]["text"].strip()
            i += 1

        if entry_count > 0:
            out.append(_spacer(_cfg().subsection_gap))
        entry_count += 1

        # Row 1: Award Name (bold, left) | Organisation (right).
        out.append(_two_col(
            Paragraph(_escape(award_name), _styles()["company_row"]),
            Paragraph(_escape(award_org), _styles()["date_right"]),
        ))

        # Row 2: Description (body, left) | Date (right).
        # Only emitted when there's at least a description OR a date —
        # nothing renders an empty row.
        if award_desc or award_date:
            out.append(_two_col(
                Paragraph(_escape(award_desc), _styles()["bullet_text"]),
                Paragraph(_escape(award_date), _styles()["date_right"]),
            ))

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
        rendered.append(_inline_markup(text, _styles()["bullet_text"]))
    for j, para in enumerate(rendered):
        out.append(_bullet_row(para))
        if j < len(rendered) - 1:
            out.append(_spacer(_cfg().bullet_gap))
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
    "awards":                       "awards",
    "recognition":                  "awards",
    "honours":                      "awards",
    "honors":                       "awards",
}

_SECTION_ORDER = ["highlights", "experience", "education", "skills", "projects", "certifications", "awards"]

_SECTION_LABELS = {
    "highlights":     "Profile",
    "experience":     "Experience",
    "education":      "Education",
    "skills":         "Skills",
    "projects":       "Projects",
    "certifications": "Professional Certifications",
    "awards":         "Awards",
}


def _render_section(stype: str, items: List[Dict]) -> List[Any]:
    if stype == "highlights":     return _render_highlights(items)
    if stype == "experience":     return _render_experience(items)
    if stype == "education":      return _render_education(items)
    if stype == "skills":         return _render_skills(items)
    if stype == "projects":       return _render_projects(items)
    if stype == "certifications": return _render_certifications(items)
    if stype == "awards":         return _render_awards(items)
    # Generic fallback
    out: List[Any] = []
    for item in items:
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
        else:
            out.append(_inline_markup(item["text"], _styles()["body"]))
    return out


# ---------------------------------------------------------------------------
# Public API — adaptive layout engine
# ---------------------------------------------------------------------------

def _build_story(
    name: Optional[str],
    contact: Optional[str],
    sections: List[Tuple[str, List[Dict]]],
) -> List[Any]:
    """Build the ReportLab story list using the currently active config/styles."""
    story: List[Any] = []

    if name:
        story.append(Paragraph(_escape(name), _styles()["name"]))
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
        display_title = ai_title or _SECTION_LABELS[stype]
        story.extend(_section_header(display_title))
        story.extend(_render_section(stype, items))

    # Then unknown sections (preserve original order)
    for title, items in extras:
        if not items:
            continue
        story.extend(_section_header(title))
        story.extend(_render_section("_unknown_", items))

    return story


def _measure_fill(cfg: LayoutConfig, name, contact, sections) -> FillMetrics:
    """Build story with the given config and simulate frame packing to measure fill.

    Uses a greedy frame-packing simulation (matching ReportLab's own placement
    logic) rather than a naive height sum.  The naive sum under-counts pages
    because Tables — used for every two-col row, bullet, and HR — don't split
    across frame boundaries; a table that straddles a page break is pushed whole
    to the next page, leaving whitespace the sum ignores.
    """
    global _active_cfg, STYLES

    _active_cfg = cfg
    STYLES = _make_styles(cfg)

    story = _build_story(name, contact, sections)

    usable_w = cfg.usable_w
    usable_h = cfg.usable_h

    # Greedy simulation: place each flowable; if it won't fit on the current
    # page, start a new page first.
    current_page_used = 0.0
    pages = 1
    for flowable in story:
        _, h = flowable.wrap(usable_w, usable_h)
        if current_page_used + h > usable_h and current_page_used > 0:
            pages += 1
            current_page_used = h
        else:
            current_page_used += h

    last_page_used = min(current_page_used, usable_h)
    last_page_remaining = usable_h - last_page_used
    fill_pct = (last_page_used / usable_h) * 100.0
    total_h = (pages - 1) * usable_h + last_page_used

    return FillMetrics(
        total_content_height_pt=round(total_h, 1),
        usable_height_pt=round(usable_h, 1),
        pages=pages,
        last_page_used_pt=round(last_page_used, 1),
        last_page_remaining_pt=round(last_page_remaining, 1),
        fill_pct=round(fill_pct, 1),
        overall_fill_ratio=round(total_h / (pages * usable_h), 3) if pages else 0,
    )


def _render_pdf_with_config(
    cfg: LayoutConfig,
    name: Optional[str],
    contact: Optional[str],
    sections: List[Tuple[str, List[Dict]]],
) -> bytes:
    """Render the final PDF with the given config."""
    global _active_cfg, STYLES

    _active_cfg = cfg
    STYLES = _make_styles(cfg)

    story = _build_story(name, contact, sections)

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=cfg.margin,
        rightMargin=cfg.margin,
        topMargin=cfg.margin,
        bottomMargin=cfg.margin,
    )
    frame = Frame(
        cfg.margin, cfg.margin,
        cfg.usable_w, cfg.usable_h,
        leftPadding=0, rightPadding=0,
        topPadding=0, bottomPadding=0,
        id="main",
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame])])
    doc.build(story)
    return buf.getvalue()


def generate_pdf_from_markdown(markdown: str) -> bytes:
    """
    Convert AI-produced tailored CV markdown to PDF bytes.

    Adaptive layout engine — automatically adjusts font size, margins, and
    spacing so the CV fills exactly 1 or 2 pages with professional density:
      - Sparse content → larger fonts, wider margins, more breathing room
      - Dense content → tight layout that fits cleanly
      - 1.5 page overflow → relaxes to fill 2 full pages
    """
    name, contact, sections = _parse_markdown(markdown)

    with _cfg_lock:
        try:
            def measure(cfg: LayoutConfig) -> FillMetrics:
                return _measure_fill(cfg, name, contact, sections)

            optimal_cfg = find_optimal_config(measure)

            logger.info(
                "adaptive-layout: rendering with font=%.1f margin=%.0f",
                optimal_cfg.body_font_size, optimal_cfg.margin,
            )

            pdf_bytes = _render_pdf_with_config(optimal_cfg, name, contact, sections)
        finally:
            # Always restore defaults so globals are clean for the next caller.
            global _active_cfg, STYLES
            _active_cfg = DEFAULT_CONFIG
            STYLES = _make_styles(DEFAULT_CONFIG)

    return pdf_bytes

