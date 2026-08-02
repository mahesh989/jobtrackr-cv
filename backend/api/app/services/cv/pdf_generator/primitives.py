"""Low-level flowable and inline-markup primitives.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
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
from reportlab.lib.styles import ParagraphStyle
import re
from .layout_state import (
    _cfg,
    _styles,
)
from .theme import (
    C_LINK,
    C_RULE,
)

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
