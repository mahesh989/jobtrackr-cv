"""Adaptive-layout state: the active LayoutConfig and its style table.

    _set_active_config() is the ONLY writer of _active_cfg / STYLES. Keeping the
    state and its mutation in one module is what lets the render drivers live
    elsewhere: a `global` statement rebinds the name in the module where the
    function is defined, so a writer in another module would silently update a
    private copy and leave every reader pinned to DEFAULT_CONFIG.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from app.services.cv.adaptive_layout import (
    DEFAULT_CONFIG,
    LayoutConfig,
    FillMetrics,
    find_optimal_config,
)
from typing import Any, Dict, List, Optional, Tuple
from reportlab.lib.styles import ParagraphStyle
import threading
from .theme import (
    C_BODY,
    C_HEADER,
    F_BOLD,
    F_ITALIC,
    F_REGULAR,
)

# Thread-safe active config for the current render pass.
_cfg_lock = threading.Lock()
_active_cfg: LayoutConfig = DEFAULT_CONFIG

def _cfg() -> LayoutConfig:
    return _active_cfg

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

def _set_active_config(cfg: LayoutConfig) -> None:
    """Swap the active layout config and rebuild the style table.

    The only writer of ``_active_cfg`` / ``STYLES``. Callers used to inline
    ``global _active_cfg, STYLES`` themselves, which pinned every writer to this
    module: a ``global`` statement rebinds the name in the module where the
    FUNCTION is defined, so moving a writer elsewhere would silently rebind a
    private copy and leave every reader stuck on DEFAULT_CONFIG. Funnelling the
    write through here keeps the state and its mutation co-located, so the
    render drivers are free to live in another module.
    """
    global _active_cfg, STYLES

    _active_cfg = cfg
    STYLES = _make_styles(cfg)
