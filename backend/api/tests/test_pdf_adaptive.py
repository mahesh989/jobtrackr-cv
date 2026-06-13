"""
Tests for the adaptive PDF layout engine (adaptive_layout.py + pdf_generator.py).

Run from backend/api/:
    PYTHONPATH=. python -m pytest tests/test_pdf_adaptive.py -v

Gates verified:
  1. Dense CV → floor is optimal → fast path, text content matches direct render
  2. Sparse CV → relaxed config (larger font, wider margins)
  3. 2-page CV (ratio > 1.10) → renders as 2 pages and fills them well
  4. Clamp behaviour: interpolate_config outside [0,1]
  5. DEFAULT_CONFIG values match the pre-refactor module constants exactly
  6. Measured page count matches actual rendered page count (frame-packing fix)
"""
from __future__ import annotations

import io
import sys
import os

# Ensure we can import from cv-backend root when running pytest from that dir.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pypdf
import pytest

from app.services.cv.adaptive_layout import (
    DEFAULT_CONFIG,
    MAX_CONFIG,
    LayoutConfig,
    FillMetrics,
    find_optimal_config,
    interpolate_config,
    PAGE_W,
    PAGE_H,
)
from app.services.cv.pdf_generator import (
    _measure_fill,
    _parse_markdown,
    _render_pdf_with_config,
    generate_pdf_from_markdown,
)

from reportlab.lib.units import inch

# ---------------------------------------------------------------------------
# Fixtures — synthetic CVs with known fill characteristics
# ---------------------------------------------------------------------------

def _role(n: int, y1: int, y2: int, n_bullets: int = 4) -> str:
    bullets = "\n".join(
        f"- Delivered measurable outcome {i + 1} exceeding stakeholder expectations and quarterly targets"
        for i in range(n_bullets)
    )
    return (
        f"### Employer {n} | Sydney, NSW\n"
        f"*Software Engineer | Python, AWS | {y1}–{y2}*\n"
        f"{bullets}\n\n"
    )


# ~30% fill at DEFAULT — always 1 page, very sparse
SPARSE_MD = """\
# Jane Smith
jane@example.com | Sydney NSW

## Professional Experience

### Acme Corp | Sydney, NSW
*Software Engineer | Python | Jan 2022 – Present*
- Built REST APIs using FastAPI
- Wrote unit tests with pytest
- Deployed services to AWS

## Education

### University of Sydney | Sydney, NSW
*Bachelor of Science (Computer Science) | 2021*

## Skills

- **Technical:** Python, FastAPI, AWS, Docker
"""

# ~92% fill at DEFAULT — triggers is_optimal, fast path returns DEFAULT_CONFIG
_DENSE_HEADER = """\
# Alex Kim
alex@test.com | Sydney NSW

## Career Highlights

- Key achievement one demonstrating expertise and measurable impact on business outcomes
- Key achievement two showing leadership and technical depth across multiple product domains
- Key achievement three with quantified results and team collaboration

## Professional Experience

"""
_DENSE_FOOTER = """\
## Education

- **Bachelor of Engineering** | UNSW | 2019
- **Graduate Diploma** | UTS | 2017

## Skills

- **Technical:** Python, FastAPI, Django, AWS, Docker, Kubernetes, PostgreSQL, Redis, Terraform, CI/CD
- **Soft Skills:** Leadership, Communication, Problem Solving, Stakeholder Management, Agile
- **Domain Knowledge:** Fintech, Healthcare, SaaS, Platform Engineering, Data Engineering

## Professional Certifications

- AWS Solutions Architect – Professional | Amazon Web Services | 2023
- Certified Kubernetes Administrator (CKA) | CNCF | 2022
- Google Professional Data Engineer | Google Cloud | 2021
"""

DENSE_MD = _DENSE_HEADER + "".join(_role(i + 1, 2023 - i, 2024 - i) for i in range(4)) + _DENSE_FOOTER

# ~ratio 1.25 at DEFAULT (content > 1.1 pages) — target=2 pages, should fill well
TWO_PAGE_MD = (
    _DENSE_HEADER
    + "".join(_role(i + 1, 2023 - i, 2024 - i) for i in range(8))
    + _DENSE_FOOTER
)

# "Tweener" — floors ~81% (1 page) but a small relaxation tips it to 2 pages,
# so the engine must fill the single page as much as it can WITHOUT overflowing.
# Mirrors the real nursing CV that exposed the early-bail bug: the search must
# push toward the 2-page cliff, not stop at the 90% is_optimal floor.
TWEENER_MD = (
    _DENSE_HEADER
    + "".join(_role(i + 1, 2023 - i, 2024 - i) for i in range(3))
    + _DENSE_FOOTER
)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _pdf_pages(pdf_bytes: bytes) -> int:
    return len(pypdf.PdfReader(io.BytesIO(pdf_bytes)).pages)


def _pdf_text(pdf_bytes: bytes) -> list[str]:
    r = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    return [page.extract_text() for page in r.pages]


def _measure(md: str, cfg: LayoutConfig = DEFAULT_CONFIG) -> FillMetrics:
    name, contact, sections = _parse_markdown(md)
    return _measure_fill(cfg, name, contact, sections)


# ---------------------------------------------------------------------------
# 1. DEFAULT_CONFIG values must match pre-refactor module constants exactly
# ---------------------------------------------------------------------------

class TestDefaultConfigMatchesOldConstants:
    def test_margin(self):
        assert DEFAULT_CONFIG.margin == pytest.approx(0.5 * inch, abs=0.01)

    def test_right_col_w(self):
        assert DEFAULT_CONFIG.right_col_w == pytest.approx(1.8 * inch, abs=0.01)

    def test_bullet_col_w(self):
        assert DEFAULT_CONFIG.bullet_col_w == 16.0

    def test_body_font_size(self):
        assert DEFAULT_CONFIG.body_font_size == 10.0

    def test_body_leading(self):
        assert DEFAULT_CONFIG.body_leading == 11.0

    def test_name_font_size(self):
        assert DEFAULT_CONFIG.name_font_size == 20.0

    def test_name_leading(self):
        assert DEFAULT_CONFIG.name_leading == 22.0

    def test_section_font_size(self):
        assert DEFAULT_CONFIG.section_font_size == 10.0

    def test_section_above(self):
        assert DEFAULT_CONFIG.section_above == 14.0

    def test_subsection_gap(self):
        assert DEFAULT_CONFIG.subsection_gap == 10.0

    def test_bullet_gap(self):
        assert DEFAULT_CONFIG.bullet_gap == 2.5

    def test_after_bullets(self):
        assert DEFAULT_CONFIG.after_bullets == 8.0

    def test_education_gap(self):
        assert DEFAULT_CONFIG.education_gap == 4.0

    def test_skills_line_gap(self):
        # Old code: SKILLS_LINE_GAP = BULLET_GAP + 2 = 4.5
        assert DEFAULT_CONFIG.skills_line_gap == pytest.approx(4.5, abs=0.01)

    def test_rule_title_spacer(self):
        assert DEFAULT_CONFIG.rule_title_spacer == 2.0

    def test_line_after_section(self):
        assert DEFAULT_CONFIG.line_after_section == 4.0

    def test_usable_w(self):
        # 523.28 pt = PAGE_W - 2 * 36
        assert DEFAULT_CONFIG.usable_w == pytest.approx(PAGE_W - 2 * 0.5 * inch, abs=0.01)

    def test_usable_h(self):
        assert DEFAULT_CONFIG.usable_h == pytest.approx(PAGE_H - 2 * 0.5 * inch, abs=0.01)


# ---------------------------------------------------------------------------
# 2. interpolate_config — clamp behaviour
# ---------------------------------------------------------------------------

class TestInterpolateConfig:
    def test_t0_returns_default(self):
        assert interpolate_config(0.0) is DEFAULT_CONFIG

    def test_t1_returns_max(self):
        assert interpolate_config(1.0) is MAX_CONFIG

    def test_negative_clamped_to_floor(self):
        assert interpolate_config(-99.0) is DEFAULT_CONFIG

    def test_above_one_clamped_to_ceiling(self):
        assert interpolate_config(99.0) is MAX_CONFIG

    def test_midpoint_values_between_floor_and_ceiling(self):
        mid = interpolate_config(0.5)
        assert DEFAULT_CONFIG.body_font_size < mid.body_font_size < MAX_CONFIG.body_font_size
        assert DEFAULT_CONFIG.margin < mid.margin < MAX_CONFIG.margin

    def test_result_never_below_floor(self):
        for t in [-1.0, 0.0, 0.25, 0.5, 0.75, 1.0, 2.0]:
            cfg = interpolate_config(t)
            assert cfg.body_font_size >= DEFAULT_CONFIG.body_font_size
            assert cfg.margin >= DEFAULT_CONFIG.margin

    def test_result_never_above_ceiling(self):
        for t in [-1.0, 0.0, 0.25, 0.5, 0.75, 1.0, 2.0]:
            cfg = interpolate_config(t)
            assert cfg.body_font_size <= MAX_CONFIG.body_font_size
            assert cfg.margin <= MAX_CONFIG.margin


# ---------------------------------------------------------------------------
# 3. Dense CV — fast path: floor is optimal, rendered text matches direct render
# ---------------------------------------------------------------------------

class TestDenseCvFastPath:
    def test_floor_is_optimal_for_dense_cv(self):
        m = _measure(DENSE_MD)
        assert m.pages == 1
        assert m.fill_pct >= 90.0
        assert m.is_optimal

    def test_fast_path_returns_default_config(self):
        name, contact, sections = _parse_markdown(DENSE_MD)

        def measure(cfg):
            return _measure_fill(cfg, name, contact, sections)

        result = find_optimal_config(measure)
        assert result is DEFAULT_CONFIG

    def test_dense_cv_renders_as_one_page(self):
        pdf = generate_pdf_from_markdown(DENSE_MD)
        assert _pdf_pages(pdf) == 1

    def test_adaptive_text_matches_direct_render(self):
        """Text content from adaptive render equals direct DEFAULT_CONFIG render."""
        name, contact, sections = _parse_markdown(DENSE_MD)
        pdf_direct = _render_pdf_with_config(DEFAULT_CONFIG, name, contact, sections)
        pdf_adaptive = generate_pdf_from_markdown(DENSE_MD)
        assert _pdf_text(pdf_adaptive) == _pdf_text(pdf_direct)


# ---------------------------------------------------------------------------
# 4. Sparse CV — config relaxes (larger font, wider margins)
# ---------------------------------------------------------------------------

class TestSparseCvRelaxes:
    def test_floor_not_optimal_for_sparse_cv(self):
        m = _measure(SPARSE_MD)
        assert m.pages == 1
        assert not m.is_optimal  # < 90% fill

    def test_sparse_cv_renders_as_one_page(self):
        pdf = generate_pdf_from_markdown(SPARSE_MD)
        assert _pdf_pages(pdf) == 1

    def test_sparse_cv_gets_relaxed_config(self):
        name, contact, sections = _parse_markdown(SPARSE_MD)

        def measure(cfg):
            return _measure_fill(cfg, name, contact, sections)

        result = find_optimal_config(measure)
        # Must relax beyond floor
        assert result.body_font_size > DEFAULT_CONFIG.body_font_size
        assert result.margin >= DEFAULT_CONFIG.margin

    def test_sparse_cv_config_stays_within_ceiling(self):
        name, contact, sections = _parse_markdown(SPARSE_MD)

        def measure(cfg):
            return _measure_fill(cfg, name, contact, sections)

        result = find_optimal_config(measure)
        assert result.body_font_size <= MAX_CONFIG.body_font_size
        assert result.margin <= MAX_CONFIG.margin

    def test_tweener_cv_fills_close_to_target(self):
        """Regression: a tweener one-page CV (floors ~81%, tips to 2 pages with
        a small relaxation) must be pushed close to the 95% target, NOT bailed
        the moment it crosses the 90% is_optimal floor.

        Before the fix the engine stopped at ~90% — an imperceptible relaxation
        over the production floor — even though fuller one-page configs sat just
        below the 2-page cliff.
        """
        name, contact, sections = _parse_markdown(TWEENER_MD)

        def measure(cfg):
            return _measure_fill(cfg, name, contact, sections)

        floor = measure(DEFAULT_CONFIG)
        assert floor.pages == 1 and floor.fill_pct < 90.0  # genuinely sparse

        result = find_optimal_config(measure)
        m = measure(result)
        assert m.pages == 1
        # Must comfortably clear the old 90% bail-out, on a single page.
        assert m.fill_pct >= 92.0, f"only filled {m.fill_pct}%"


# ---------------------------------------------------------------------------
# 5. 2-page CV — targets 2 pages and fills them well
# ---------------------------------------------------------------------------

class TestTwoPageCv:
    def test_floor_measurement_gives_2_pages(self):
        m = _measure(TWO_PAGE_MD)
        assert m.pages == 2

    def test_floor_ratio_exceeds_110_percent(self):
        m = _measure(TWO_PAGE_MD)
        ratio = m.total_content_height_pt / m.usable_height_pt
        assert ratio > 1.10

    def test_two_page_cv_renders_as_2_pages(self):
        pdf = generate_pdf_from_markdown(TWO_PAGE_MD)
        assert _pdf_pages(pdf) == 2

    def test_two_page_cv_fills_last_page_well(self):
        """Adaptive engine should fill the last page to ≥ 75%."""
        name, contact, sections = _parse_markdown(TWO_PAGE_MD)

        def measure(cfg):
            return _measure_fill(cfg, name, contact, sections)

        # Find optimal config and measure its fill
        result = find_optimal_config(measure)
        m = measure(result)
        assert m.pages == 2
        assert m.fill_pct >= 75.0

    def test_two_page_cv_never_overflows_to_3_pages(self):
        """Result must stay at exactly 2 pages — never spill to 3."""
        pdf = generate_pdf_from_markdown(TWO_PAGE_MD)
        assert _pdf_pages(pdf) <= 2


# ---------------------------------------------------------------------------
# 6. Measured page count matches actual rendered page count
# ---------------------------------------------------------------------------

class TestMeasuredVsActualPages:
    """Frame-packing simulation should agree with ReportLab's actual render."""

    @pytest.mark.parametrize("md,label", [
        (SPARSE_MD, "sparse"),
        (DENSE_MD, "dense_1page"),
        (TWO_PAGE_MD, "two_page"),
    ])
    def test_measured_pages_match_actual(self, md, label):
        name, contact, sections = _parse_markdown(md)
        m = _measure_fill(DEFAULT_CONFIG, name, contact, sections)
        pdf = _render_pdf_with_config(DEFAULT_CONFIG, name, contact, sections)
        actual = _pdf_pages(pdf)
        assert m.pages == actual, (
            f"{label}: measured {m.pages} pages but ReportLab rendered {actual}"
        )


# ---------------------------------------------------------------------------
# 7. FillMetrics.is_optimal thresholds
# ---------------------------------------------------------------------------

class TestFillMetricsIsOptimal:
    def _metrics(self, fill_pct: float, pages: int) -> FillMetrics:
        usable = 769.9
        used = usable * fill_pct / 100
        return FillMetrics(
            total_content_height_pt=used,
            usable_height_pt=usable,
            pages=pages,
            last_page_used_pt=used,
            last_page_remaining_pt=usable - used,
            fill_pct=fill_pct,
            overall_fill_ratio=fill_pct / 100,
        )

    def test_single_page_optimal_at_90(self):
        assert self._metrics(90.0, 1).is_optimal

    def test_single_page_not_optimal_below_90(self):
        assert not self._metrics(89.9, 1).is_optimal

    def test_multi_page_optimal_at_75(self):
        assert self._metrics(75.0, 2).is_optimal

    def test_multi_page_not_optimal_below_75(self):
        assert not self._metrics(74.9, 2).is_optimal
