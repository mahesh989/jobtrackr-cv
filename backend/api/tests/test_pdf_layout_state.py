"""Guards the one hazard in splitting pdf_generator into a package.

``_active_cfg`` / ``STYLES`` are module-level state written by the render
drivers and read by every primitive and section renderer. A ``global``
statement rebinds the name in the module where the *function* is defined, so
if a writer ever moves out of ``layout_state`` it will silently rebind a
private copy: ``_cfg()`` keeps returning ``DEFAULT_CONFIG``, every PDF renders
with default layout instead of adaptive, and nothing raises.

These tests fail loudly if that regresses.
"""
from __future__ import annotations

import app.services.cv.pdf_generator as pkg
import app.services.cv.pdf_generator.layout_state as layout_state
import app.services.cv.pdf_generator.parsing as parsing
import app.services.cv.pdf_generator.primitives as primitives
import app.services.cv.pdf_generator.sections as sections
import pytest
from app.services.cv.adaptive_layout import DEFAULT_CONFIG, LayoutConfig


@pytest.fixture(autouse=True)
def _restore_default_config():
    """Never leak a non-default config into another test."""
    yield
    layout_state._set_active_config(DEFAULT_CONFIG)


def _alt_config() -> LayoutConfig:
    return LayoutConfig(**{**DEFAULT_CONFIG.__dict__,
                          "body_font_size": 7.5, "margin": 21.0})


def test_set_active_config_is_visible_from_every_reader_module():
    alt = _alt_config()
    layout_state._set_active_config(alt)

    # Each module resolves _cfg in its OWN namespace — that is the point.
    assert layout_state._cfg() is alt
    assert primitives._cfg() is alt
    assert sections._cfg() is alt


def test_set_active_config_rebuilds_the_style_table():
    layout_state._set_active_config(_alt_config())
    assert layout_state._styles()["body"].fontSize == pytest.approx(7.5)
    assert sections._styles()["body"].fontSize == pytest.approx(7.5)


def test_config_is_restored_after_a_render():
    """generate_pdf_from_markdown restores defaults in its finally block."""
    layout_state._set_active_config(_alt_config())
    pkg.generate_pdf_from_markdown("# Jane Doe\njane@example.com\n")
    assert layout_state._cfg() is DEFAULT_CONFIG
    assert sections._cfg() is DEFAULT_CONFIG


def test_layout_state_is_the_only_writer():
    """No module outside layout_state may rebind _active_cfg / STYLES.

    Enforcing this statically is what keeps the package split safe — a `global`
    in any other module would target a private copy.
    """
    import ast
    import pathlib

    pkg_dir = pathlib.Path(pkg.__file__).parent
    offenders = []
    for path in sorted(pkg_dir.glob("*.py")):
        if path.name == "layout_state.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Global):
                bad = {n for n in node.names if n in {"_active_cfg", "STYLES"}}
                if bad:
                    offenders.append(f"{path.name}: global {', '.join(sorted(bad))}")
    assert not offenders, (
        "these modules rebind layout state they do not own: " + "; ".join(offenders)
    )


def test_package_still_renders_end_to_end():
    pdf = pkg.generate_pdf_from_markdown(
        "# Jane Doe\njane@example.com | 0400 000 000\n\n"
        "## Experience\n**Acme** — Sydney\n*Nurse* | 2020 - 2023\n"
        "- Delivered care to residents.\n\n"
        "## Education\n**Cert III** — TAFE | 2019\n"
    )
    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 1000


def test_public_entry_point_still_importable_from_the_old_path():
    """The package must keep the pre-split import surface intact."""
    from app.services.cv.pdf_generator import (  # noqa: F401
        _AWARD_TRAILING_DATE_RE,
        _measure_fill,
        _parse_markdown,
        _render_awards,
        _render_pdf_with_config,
        generate_pdf_from_markdown,
    )
    assert parsing._parse_markdown is _parse_markdown
