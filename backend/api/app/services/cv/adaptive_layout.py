"""
Adaptive layout engine — measures PDF content density and computes optimal
layout parameters so a CV fills exactly 1 or 2 pages with professional spacing.

Bounded range:
  FLOOR (t=0) — today's tight production layout (never goes below this)
  CEILING (t=1) — the maximum relaxation allowed (never goes above this)

The optimiser interpolates between floor ↔ ceiling (t ∈ [0, 1]) using binary
search to hit the target fill percentage.  Content that already fills well at
floor stays there; sparse content gets larger fonts / wider margins / more
breathing room — but never exceeds ceiling.

Decision logic:
  - Content ≤ 110% of 1 page at floor  →  target = 1 page
  - Content > 110% of 1 page at floor   →  target = 2 pages
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from reportlab.lib.pagesizes import A4

logger = logging.getLogger(__name__)

PAGE_W, PAGE_H = A4  # 595.28 × 841.89 pt


# ---------------------------------------------------------------------------
# Layout configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LayoutConfig:
    """All tuneable parameters for the PDF layout engine."""

    # Font sizes (pt)
    body_font_size: float = 10.0
    body_leading: float = 11.0
    name_font_size: float = 20.0
    name_leading: float = 22.0
    section_font_size: float = 10.0

    # Page margins (pt) — uniform all four sides
    margin: float = 36.0          # 0.5 inch

    # Spacing between elements (pt)
    section_above: float = 14.0
    subsection_gap: float = 10.0
    bullet_gap: float = 2.5
    after_bullets: float = 8.0
    education_gap: float = 4.0
    skills_line_gap: float = 4.5
    rule_title_spacer: float = 2.0
    line_after_section: float = 4.0

    # Column widths (pt)
    right_col_w: float = 129.6    # 1.8 inch
    bullet_col_w: float = 16.0

    # Derived (computed at access time)
    @property
    def usable_w(self) -> float:
        return PAGE_W - 2 * self.margin

    @property
    def usable_h(self) -> float:
        return PAGE_H - 2 * self.margin

    @property
    def left_col_w(self) -> float:
        return self.usable_w - self.right_col_w

    @property
    def text_col_w(self) -> float:
        return self.usable_w - self.bullet_col_w


# ---------------------------------------------------------------------------
# Bounded range: FLOOR ↔ CEILING
# ---------------------------------------------------------------------------

# FLOOR — today's tight production layout.  The engine never goes below this.
# This is also DEFAULT_CONFIG used when no adaptation is needed.
DEFAULT_CONFIG = LayoutConfig()

# CEILING — the maximum relaxation allowed.  The engine never exceeds this.
#                                            ┌─ FLOOR ─┐  ┌─ CEILING ─┐
#   body_font_size                              10.0 pt     11.5 pt
#   body_leading                                11.0 pt     14.0 pt
#   name_font_size                              20.0 pt     26.0 pt
#   margin                                      36.0 pt     54.0 pt  (0.5" → 0.75")
#   section_above                               14.0 pt     20.0 pt
#   subsection_gap                              10.0 pt     14.0 pt
#   bullet_gap                                   2.5 pt      4.0 pt
#   after_bullets                                8.0 pt     12.0 pt
MAX_CONFIG = LayoutConfig(
    body_font_size=11.5,
    body_leading=14.0,
    name_font_size=26.0,
    name_leading=28.0,
    section_font_size=11.5,
    margin=54.0,            # 0.75 inch
    section_above=20.0,
    subsection_gap=14.0,
    bullet_gap=4.0,
    after_bullets=12.0,
    education_gap=8.0,
    skills_line_gap=7.5,
    rule_title_spacer=3.5,
    line_after_section=7.0,
    right_col_w=140.0,
    bullet_col_w=16.0,
)


# ---------------------------------------------------------------------------
# Interpolation (always clamped to [0, 1] → floor ↔ ceiling)
# ---------------------------------------------------------------------------

def _lerp(a: float, b: float, t: float) -> float:
    """Linear interpolate: t=0 → a, t=1 → b."""
    return a + (b - a) * t


def interpolate_config(t: float) -> LayoutConfig:
    """
    Blend between FLOOR (t=0) and CEILING (t=1).

    t is clamped to [0, 1] — the result is always within the bounded range.
    """
    t = max(0.0, min(1.0, t))
    if t == 0.0:
        return DEFAULT_CONFIG
    if t == 1.0:
        return MAX_CONFIG
    lo, hi = DEFAULT_CONFIG, MAX_CONFIG
    return LayoutConfig(
        body_font_size=_lerp(lo.body_font_size, hi.body_font_size, t),
        body_leading=_lerp(lo.body_leading, hi.body_leading, t),
        name_font_size=_lerp(lo.name_font_size, hi.name_font_size, t),
        name_leading=_lerp(lo.name_leading, hi.name_leading, t),
        section_font_size=_lerp(lo.section_font_size, hi.section_font_size, t),
        margin=_lerp(lo.margin, hi.margin, t),
        section_above=_lerp(lo.section_above, hi.section_above, t),
        subsection_gap=_lerp(lo.subsection_gap, hi.subsection_gap, t),
        bullet_gap=_lerp(lo.bullet_gap, hi.bullet_gap, t),
        after_bullets=_lerp(lo.after_bullets, hi.after_bullets, t),
        education_gap=_lerp(lo.education_gap, hi.education_gap, t),
        skills_line_gap=_lerp(lo.skills_line_gap, hi.skills_line_gap, t),
        rule_title_spacer=_lerp(lo.rule_title_spacer, hi.rule_title_spacer, t),
        line_after_section=_lerp(lo.line_after_section, hi.line_after_section, t),
        right_col_w=_lerp(lo.right_col_w, hi.right_col_w, t),
        bullet_col_w=_lerp(lo.bullet_col_w, hi.bullet_col_w, t),
    )


# ---------------------------------------------------------------------------
# Measurement result
# ---------------------------------------------------------------------------

@dataclass
class FillMetrics:
    """Result of measuring how content fills the page(s)."""
    total_content_height_pt: float
    usable_height_pt: float
    pages: int
    last_page_used_pt: float
    last_page_remaining_pt: float
    fill_pct: float                 # % of last page filled
    overall_fill_ratio: float       # total_h / (pages * usable_h)

    @property
    def is_optimal(self) -> bool:
        """True if the fill is good enough — no further tuning needed."""
        if self.pages == 1:
            # Require ≥ 90% fill on a single page before stopping.
            return self.fill_pct >= 90.0
        # Multi-page: last page should be ≥ 75% full
        return self.fill_pct >= 75.0


# ---------------------------------------------------------------------------
# Smart config finder
# ---------------------------------------------------------------------------

def find_optimal_config(
    measure_fn,     # Callable[[LayoutConfig], FillMetrics]
    target_pages: Optional[int] = None,
    max_iterations: int = 8,
) -> LayoutConfig:
    """
    Binary-search between FLOOR (t=0) and CEILING (t=1) to find the config
    that best fills the target page count.

    Guarantees:
      - Never goes below DEFAULT_CONFIG (floor)
      - Never goes above MAX_CONFIG (ceiling)
      - Always returns a config within the bounded range

    Parameters
    ----------
    measure_fn : callable
        Takes a LayoutConfig, builds the story, measures it, returns FillMetrics.
    target_pages : int or None
        If None, auto-detect from floor measurement.
    max_iterations : int
        Max binary-search refinements.
    """
    # Step 1: measure at floor (today's tight layout)
    floor_metrics = measure_fn(DEFAULT_CONFIG)
    logger.info(
        "adaptive-layout: floor measurement — %.1f pt content, %.1f pt usable, "
        "%.1f%% fill, %d page(s)",
        floor_metrics.total_content_height_pt,
        floor_metrics.usable_height_pt,
        floor_metrics.fill_pct,
        floor_metrics.pages,
    )

    # Step 2: decide target page count from the floor measurement
    if target_pages is None:
        ratio = floor_metrics.total_content_height_pt / floor_metrics.usable_height_pt
        if ratio <= 1.10:
            target_pages = 1
        else:
            target_pages = 2

    # Step 3: floor already optimal → use it (the common dense-CV fast path)
    if floor_metrics.pages == target_pages and floor_metrics.is_optimal:
        logger.info(
            "adaptive-layout: floor is optimal (%.1f%% fill) → no adaptation",
            floor_metrics.fill_pct,
        )
        return DEFAULT_CONFIG

    # Step 4: measure at ceiling to know the full range
    ceiling_metrics = measure_fn(MAX_CONFIG)
    logger.info(
        "adaptive-layout: ceiling measurement — %.1f%% fill, %d page(s); target=%d",
        ceiling_metrics.fill_pct, ceiling_metrics.pages, target_pages,
    )

    # Edge case: floor already overflows (dense 2-page CV) — stay at floor
    if target_pages == 1 and floor_metrics.pages > 1:
        logger.info("adaptive-layout: content overflows at floor → using floor")
        return DEFAULT_CONFIG

    # Edge case: even ceiling doesn't reach 2 pages — use ceiling for best fill
    if target_pages == 2 and ceiling_metrics.pages < 2:
        logger.info("adaptive-layout: ceiling still 1 page → using ceiling")
        return MAX_CONFIG

    # Step 5: binary search  t ∈ [0, 1]  between floor ↔ ceiling
    # Aim high so a sparse CV is pushed close to the 2-page cliff and the page
    # ends up comfortably full — NOT just past the 90% is_optimal floor (which
    # bails far too early and leaves visible bottom whitespace).
    target_fill = 0.95 if target_pages == 1 else 0.85

    # Seed best with whichever endpoint is closer to target
    best_t = 0.0
    best_config = DEFAULT_CONFIG
    best_distance = abs(floor_metrics.fill_pct / 100.0 - target_fill)

    if ceiling_metrics.pages == target_pages:
        ceil_dist = abs(ceiling_metrics.fill_pct / 100.0 - target_fill)
        if ceil_dist < best_distance:
            best_t = 1.0
            best_config = MAX_CONFIG
            best_distance = ceil_dist

    lo_t, hi_t = 0.0, 1.0

    for i in range(max_iterations):
        mid_t = (lo_t + hi_t) / 2.0
        candidate = interpolate_config(mid_t)
        m = measure_fn(candidate)

        if m.pages != target_pages:
            # Wrong page count — steer binary search
            if m.pages > target_pages:
                hi_t = mid_t   # too big → go tighter (towards floor)
            else:
                lo_t = mid_t   # too small → go spacious (towards ceiling)
            continue

        fill_ratio = m.fill_pct / 100.0
        distance = abs(fill_ratio - target_fill)

        logger.debug(
            "adaptive-layout: iter %d — t=%.3f fill=%.1f%% distance=%.3f",
            i, mid_t, m.fill_pct, distance,
        )

        if distance < best_distance:
            best_distance = distance
            best_config = candidate
            best_t = mid_t

        # Early exit when fill is genuinely close to target.  For a single page
        # we require near-target fill (within 2 pts) rather than is_optimal's
        # 90% floor — otherwise the search stops the moment it crosses 90% and
        # never reaches the fuller one-page configs that sit just below the
        # 2-page cliff.  The 2-page path keeps the looser is_optimal criterion.
        near_target = abs(fill_ratio - target_fill) <= 0.02
        if (target_pages == 1 and near_target) or (target_pages == 2 and m.is_optimal):
            logger.info(
                "adaptive-layout: converged at iter %d (%.1f%% fill, t=%.3f, "
                "font=%.1f, margin=%.0f)",
                i, m.fill_pct, mid_t,
                candidate.body_font_size, candidate.margin,
            )
            return candidate

        # Steer
        if fill_ratio < target_fill:
            lo_t = mid_t   # need more space → towards ceiling
        else:
            hi_t = mid_t   # too full → towards floor

    logger.info(
        "adaptive-layout: settled after %d iterations (t=%.3f, fill_dist=%.3f, "
        "font=%.1f, margin=%.0f)",
        max_iterations, best_t, best_distance,
        best_config.body_font_size, best_config.margin,
    )
    return best_config
