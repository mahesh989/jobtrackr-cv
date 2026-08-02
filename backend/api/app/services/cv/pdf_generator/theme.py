"""Page geometry, colours, spacing and font constants.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import inch

PAGE_W, PAGE_H = A4              # 595.28 × 841.89 pt

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
