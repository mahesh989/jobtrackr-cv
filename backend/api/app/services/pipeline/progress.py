"""
Pipeline state writers — update the analysis_runs row via Supabase service-role.

Each update commits, which causes Supabase Realtime to broadcast the change
to subscribed browser clients in near-real-time. The browser uses this to
animate step cards on /jobs/[id]/analyze/[run_id].

These functions are intentionally thin REST calls — no SQLAlchemy session,
no models, no in-memory row caching. The orchestrator keeps the step_status
dict locally and passes it to mark_step.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from app.database import get_supabase

logger = logging.getLogger(__name__)

StepName = Literal[
    "jd_analysis",
    "cv_jd_matching",
    "ats_scoring",
    "input_recommendations",
    "keyword_feasibility",
    "ai_recommendations",
    "tailored_cv",
]
StepState = Literal["pending", "running", "completed", "failed", "skipped"]

DEFAULT_STEP_STATUS: Dict[str, str] = {
    "jd_analysis":           "pending",
    "cv_jd_matching":        "pending",
    "ats_scoring":           "pending",
    "input_recommendations": "pending",
    "keyword_feasibility":   "pending",
    "ai_recommendations":    "pending",
    "tailored_cv":           "pending",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_UPDATE_MAX_ATTEMPTS = 4
_UPDATE_BASE_DELAY_S = 0.5   # backoff doubles: 0.5s, 1s, 2s


async def _update(run_id: uuid.UUID, patch: Dict[str, Any]) -> None:
    """Run a Supabase UPDATE in a worker thread (supabase-py is sync).

    Resilient to transient network blips (e.g. an h2 ConnectionTerminated to
    PostgREST): retries with backoff and NEVER raises. A status/step write must
    not crash a run whose real work already succeeded — the same class of bug
    that was failing cover letters. The next successful write reconciles the row.
    """
    def _do() -> None:
        get_supabase().table("analysis_runs").update(patch).eq("id", str(run_id)).execute()
    for i in range(_UPDATE_MAX_ATTEMPTS):
        try:
            await asyncio.to_thread(_do)
            return
        except Exception as exc:  # noqa: BLE001 — a status write must never crash the run
            if i < _UPDATE_MAX_ATTEMPTS - 1:
                await asyncio.sleep(_UPDATE_BASE_DELAY_S * (2 ** i))
                continue
            logger.warning(
                "run %s: _update failed after %d attempts (%s) — continuing",
                run_id, _UPDATE_MAX_ATTEMPTS, exc,
            )


async def mark_run_running(run_id: uuid.UUID) -> None:
    await _update(run_id, {"status": "running", "started_at": _now_iso()})
    logger.info("run %s → running", run_id)


async def mark_run_completed(run_id: uuid.UUID) -> None:
    await _update(run_id, {"status": "completed", "completed_at": _now_iso()})
    logger.info("run %s → completed", run_id)


async def mark_run_failed(
    run_id:      uuid.UUID,
    error:       str,
    step_status: Dict[str, str],
    failed_step: Optional[StepName] = None,
) -> None:
    """Set status=failed + reconcile step_status (failed steps stay 'failed')."""
    if failed_step:
        step_status[failed_step] = "failed"
    else:
        for k, v in list(step_status.items()):
            if v == "running":
                step_status[k] = "failed"
    await _update(run_id, {
        "status":        "failed",
        "error_message": error[:2000],
        "completed_at":  _now_iso(),
        "step_status":   step_status,
    })
    logger.info("run %s → failed (%s)", run_id, error[:120])


async def mark_step(
    run_id:      uuid.UUID,
    step_status: Dict[str, str],
    step:        StepName,
    state:       StepState,
) -> None:
    """Mutate the local step_status dict and persist it. Realtime fires."""
    step_status[step] = state
    await _update(run_id, {"step_status": step_status})
    logger.info("run %s: %s → %s", run_id, step, state)


async def save_step_result(
    run_id: uuid.UUID,
    column: str,
    value:  Any,
) -> None:
    """Persist a step's output to its dedicated column on analysis_runs."""
    await _update(run_id, {column: value})
