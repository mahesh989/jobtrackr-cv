"""Tailoring report + quality-flag persistence — extracted from writers._impl.

Diagnostics only: emits the per-run tailoring report and persists quality
flags. Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple
from app.enums import CATEGORY_KEYS
import uuid

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# End-of-tailoring report
# ---------------------------------------------------------------------------

def _log_tailoring_report(
    *,
    family_id: str,
    feasibility: Optional[Dict[str, Any]],
    matching: Optional[Dict[str, Any]],
    tailored_md: str,
) -> None:
    """One-line summary of where keywords ended up. Used for post-hoc debugging.

    Reports: role family / feasibility-bucket counts / # honest gaps /
    Skills-section length / first few honest gaps verbatim. The full landings
    can always be reconstructed by reading tailored_md; this exists so
    "why did keyword X go missing?" doesn't require grepping 10 per-pass logs.
    """
    plan = (feasibility or {}).get("feasibility_plan") or {}
    direct = len(plan.get("inject_directly") or [])
    ext    = len(plan.get("inject_as_extension") or [])
    inf    = len(plan.get("inject_with_inference") or [])
    gaps   = (feasibility or {}).get("summary", {}).get("honest_gaps") or []

    # Count keywords surfaced in the Skills section (rough: sum of comma-separated
    # entries across all category lines).
    skills_entries = 0
    in_skills = False
    for line in tailored_md.split("\n"):
        if line.strip() == "## Skills":
            in_skills = True
            continue
        if in_skills and line.startswith("## "):
            break
        if in_skills and "**" in line and ":" in line:
            after_colon = line.split(":", 1)[1]
            skills_entries += len([s for s in after_colon.split(",") if s.strip()])

    counts = (matching or {}).get("counts") or {}
    req = counts.get("required") or {}
    req_matched = sum(int((req.get(c) or {}).get("matched") or 0) for c in CATEGORY_KEYS)
    req_total = sum(int((req.get(c) or {}).get("total") or 0) for c in CATEGORY_KEYS)

    logger.info(
        "tailoring report: family=%s | req_matched=%d/%d | feasibility direct=%d ext=%d inf=%d gaps=%d | "
        "skills_entries=%d | first_gaps=%s",
        family_id, req_matched, req_total, direct, ext, inf, len(gaps),
        skills_entries, ", ".join(gaps[:5]) or "—",
    )

def _persist_quality_flags(run_id: uuid.UUID, result: "WriterResult") -> None:
    """Write the honesty_guard notes + dropped roles + risk flag to the
    analysis_runs row. Tolerates the column being missing (older deployments
    before migration 057 has been applied) — logs and moves on."""
    extras = result.extras or {}
    flags = {
        "honesty_guard_notes": extras.get("honesty_guard_notes") or [],
        "pre_filter_dropped_roles": extras.get("pre_filter_dropped_roles") or [],
        "honesty_risk": extras.get("honesty_risk") or {},
    }
    try:
        from app.database import get_supabase
        from app.database import ANALYSIS_RUNS
        sb = get_supabase()
        sb.table(ANALYSIS_RUNS).update({"quality_flags": flags}).eq("id", str(run_id)).execute()
    except Exception as e:
        msg = str(e)
        if "quality_flags" in msg or "column" in msg.lower():
            logger.info("quality_flags column missing — skipping persistence (apply migration 057)")
        else:
            logger.warning("quality_flags persist failed: %s", e)
