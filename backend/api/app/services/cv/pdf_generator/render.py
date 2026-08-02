"""PDF render drivers — fill measurement and the adaptive render loop.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from reportlab.lib.pagesizes import A4
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
from app.services.cv.adaptive_layout import (
    DEFAULT_CONFIG,
    LayoutConfig,
    FillMetrics,
    find_optimal_config,
)
from typing import Any, Dict, List, Optional, Tuple
import io
from ._common import logger
from .layout_state import (
    _cfg_lock,
    _set_active_config,
)
from .parsing import _parse_markdown
from .sections import _build_story

def _measure_fill(cfg: LayoutConfig, name, contact, sections) -> FillMetrics:
    """Build story with the given config and simulate frame packing to measure fill.

    Uses a greedy frame-packing simulation (matching ReportLab's own placement
    logic) rather than a naive height sum.  The naive sum under-counts pages
    because Tables — used for every two-col row, bullet, and HR — don't split
    across frame boundaries; a table that straddles a page break is pushed whole
    to the next page, leaving whitespace the sum ignores.
    """
    _set_active_config(cfg)

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
    _set_active_config(cfg)

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
            _set_active_config(DEFAULT_CONFIG)

    return pdf_bytes
