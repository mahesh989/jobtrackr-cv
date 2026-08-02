"""Gate result builders shared by every gate.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------


def _result(name: str, status: str, detail: str) -> Dict[str, Any]:
    return {"name": name, "status": status, "detail": detail}


def _short(text: str, n: int = 50) -> str:
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"
