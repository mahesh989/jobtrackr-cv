"""C67: ``_render_contact_line`` hardcoded ``color="#000080"`` twice (email
and URL fragments) instead of using the shared ``C_LINK`` theme constant
already imported into this module and already used correctly by every
other link-colouring call site in the package (``primitives.py``,
``sections.py``'s own inline-URL-in-bullet renderer). Same value today, but
a future theme change to ``C_LINK`` would silently NOT reach these two
duplicated literals — locking in that both fragment kinds now derive their
colour from the shared constant.
"""
from __future__ import annotations

import app.services.cv.pdf_generator.sections as sections
from app.services.cv.pdf_generator.theme import C_LINK


def test_email_fragment_uses_the_shared_link_colour_constant():
    result = sections._render_contact_line("jane@example.com")
    markup = result[0].text
    assert f'color="{C_LINK.hexval()}"' in markup
    assert "#000080" not in markup


def test_url_fragment_uses_the_shared_link_colour_constant():
    result = sections._render_contact_line("linkedin.com/in/jane")
    markup = result[0].text
    assert f'color="{C_LINK.hexval()}"' in markup
    assert "#000080" not in markup
