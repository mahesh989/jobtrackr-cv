"""Nursing-specific pipeline hooks.

These callables implement nursing-only logic that would otherwise
pollute shared modules.  The registry wires them in via VerticalPack.hooks
so shared code can call ``pack.hooks.nursing_subtype(jd_analysis)`` without
an ``if rf.id == "nursing"`` guard in multiple places.

Phase D will move the full implementations here from role_families.py.
Until then, this module re-exports the existing functions from role_families
so the registry already resolves to the right callables without duplicating
logic.
"""
from __future__ import annotations

# Re-export from the shim until Phase D moves the implementations.
from app.services.eval.role_families import (  # noqa: F401
    _nursing_subtype as nursing_subtype,
    _apply_nursing_subtype as apply_nursing_subtype,
)
