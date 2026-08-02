"""Shared infrastructure for this package.

The logger name is pinned to the ORIGINAL module path rather than
``__name__`` so log output is byte-identical to the pre-split module.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("app.services.cv.pdf_generator")
