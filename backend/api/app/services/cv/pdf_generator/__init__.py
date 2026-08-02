"""CV PDF generator — converts the AI-produced markdown tailored CV to a
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

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from app.services.cv.pdf_generator._common import logger  # noqa: F401
from app.services.cv.pdf_generator.theme import (  # noqa: F401
    AFTER_BULLETS,
    BULLET_COL_W,
    BULLET_GAP,
    C_BODY,
    C_HEADER,
    C_LINK,
    C_RULE,
    EDUCATION_GAP,
    F_BOLD,
    F_BOLDITALIC,
    F_ITALIC,
    F_REGULAR,
    LEFT_COL_W,
    LINE_AFTER_SECTION,
    MARGIN,
    PAGE_H,
    PAGE_W,
    RIGHT_COL_W,
    RULE_TITLE_SPACER,
    SECTION_ABOVE,
    SKILLS_LINE_GAP,
    SUBSECTION_GAP,
    TEXT_COL_W,
    USABLE_W,
)
from app.services.cv.pdf_generator.layout_state import (  # noqa: F401
    STYLES,
    _active_cfg,
    _cfg,
    _cfg_lock,
    _make_styles,
    _set_active_config,
    _style_counter,
    _styles,
)
from app.services.cv.pdf_generator.primitives import (  # noqa: F401
    _NO_PAD_TABLE,
    _bullet_row,
    _ensure_https,
    _escape,
    _hr,
    _inline_markup,
    _is_italic_only_line,
    _norm,
    _section_header,
    _spacer,
    _split_pipes,
    _strip_md_emphasis,
    _two_col,
)
from app.services.cv.pdf_generator.parsing import (  # noqa: F401
    _DOMAIN_LABELS,
    _EntryHeader,
    _SECTION_ALIASES,
    _SECTION_LABELS,
    _SECTION_ORDER,
    _contact_label,
    _parse_experience_header,
    _parse_markdown,
)
from app.services.cv.pdf_generator.sections import (  # noqa: F401
    _AWARD_DATE_TAIL_RE,
    _AWARD_TRAILING_DATE_RE,
    _BOLD_CATEGORY_RE,
    _build_story,
    _render_awards,
    _render_bullets,
    _render_certifications,
    _render_contact_line,
    _render_education,
    _render_experience,
    _render_highlights,
    _render_projects,
    _render_references,
    _render_section,
    _render_skills,
    _split_compound_skills_item,
)
from app.services.cv.pdf_generator.render import (  # noqa: F401
    _measure_fill,
    _render_pdf_with_config,
    generate_pdf_from_markdown,
)

__all__ = [
    "AFTER_BULLETS",
    "BULLET_COL_W",
    "BULLET_GAP",
    "C_BODY",
    "C_HEADER",
    "C_LINK",
    "C_RULE",
    "EDUCATION_GAP",
    "F_BOLD",
    "F_BOLDITALIC",
    "F_ITALIC",
    "F_REGULAR",
    "LEFT_COL_W",
    "LINE_AFTER_SECTION",
    "MARGIN",
    "PAGE_H",
    "PAGE_W",
    "RIGHT_COL_W",
    "RULE_TITLE_SPACER",
    "SECTION_ABOVE",
    "SKILLS_LINE_GAP",
    "STYLES",
    "SUBSECTION_GAP",
    "TEXT_COL_W",
    "USABLE_W",
    "generate_pdf_from_markdown",
]
