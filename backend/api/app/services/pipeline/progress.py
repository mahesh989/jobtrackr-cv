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
from typing import Any, Dict, Optional

from app.database import ANALYSIS_RUNS, get_supabase, supabase_update, utcnow_iso
from app.enums import RunStatus, StepName, StepState

logger = logging.getLogger(__name__)

# Re-export for callers that import from this module.
StepName = StepName  # noqa: PLW0127
StepState = StepState  # noqa: PLW0127

DEFAULT_STEP_STATUS: Dict[str, str] = {s.value: StepState.PENDING for s in StepName}


async def mark_run_running(run_id: uuid.UUID) -> None:
    await supabase_update(ANALYSIS_RUNS, run_id, {"status": RunStatus.RUNNING, "started_at": utcnow_iso()})
    logger.info("run %s → running", run_id)


async def mark_run_completed(run_id: uuid.UUID) -> None:
    await supabase_update(ANALYSIS_RUNS, run_id, {"status": RunStatus.COMPLETED, "completed_at": utcnow_iso()})
    logger.info("run %s → completed", run_id)


async def mark_run_failed(
    run_id:      uuid.UUID,
    error:       str,
    step_status: Dict[str, str],
    failed_step: Optional[StepName] = None,
) -> None:
    """Set status=failed + reconcile step_status (failed steps stay 'failed')."""
    if failed_step:
        step_status[failed_step] = StepState.FAILED
    else:
        for k, v in list(step_status.items()):
            if v == StepState.RUNNING:
                step_status[k] = StepState.FAILED
    await supabase_update(ANALYSIS_RUNS, run_id, {
        "status":        RunStatus.FAILED,
        "error_message": error[:2000],
        "completed_at":  utcnow_iso(),
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
    await supabase_update(ANALYSIS_RUNS, run_id, {"step_status": step_status})
    logger.info("run %s: %s → %s", run_id, step, state)


async def save_step_result(
    run_id: uuid.UUID,
    column: str,
    value:  Any,
) -> None:
    """Persist a step's output to its dedicated column on analysis_runs."""
    await supabase_update(ANALYSIS_RUNS, run_id, {column: value})


async def save_artifact_if_active(run_id: uuid.UUID, column: str, value: Any) -> bool:
    """Persist a billable artifact's storage path — but ONLY if the run
    hasn't already been marked failed.

    Closes finding C3b: a user's Stop click (cancelAnalysisRun) can land
    while the tailored-CV writer or PDF renderer is still in flight — an
    in-flight AI/render call can't be aborted mid-request. Without this
    guard, the already-uploaded artifact gets recorded on a row whose paid
    reservation the Stop click's DB trigger already voided, leaving it
    downloadable via the user's own SELECT + storage policies despite the
    refund. The conditional UPDATE (`status <> 'failed'`) makes the check
    and the write atomic at the database level — no separate read-then-write
    race window.

    Returns True if the write took effect (run was still active), False
    otherwise. A network/DB error is treated as False — fail closed, same
    principle as this codebase's billing meter (see
    test_auto_cover_letter_billing.py): on uncertainty, don't leave a
    possibly-unbilled artifact reachable.
    """
    def _do() -> bool:
        resp = (
            get_supabase()
            .table(ANALYSIS_RUNS)
            .update({column: value})
            .eq("id", str(run_id))
            .neq("status", RunStatus.FAILED)
            .execute()
        )
        return bool(resp.data)

    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001 — fail closed, see docstring
        logger.warning(
            "save_artifact_if_active(%s, %s): update failed (%s) — treating as cancelled",
            run_id, column, exc,
        )
        return False
