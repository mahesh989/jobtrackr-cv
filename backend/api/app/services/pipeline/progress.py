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
    ok = await supabase_update(ANALYSIS_RUNS, run_id, {"status": RunStatus.RUNNING, "started_at": utcnow_iso()})
    if not ok:
        raise RuntimeError(f"mark_run_running: DB write failed for run {run_id} after retries")
    logger.info("run %s → running", run_id)


async def mark_run_completed(run_id: uuid.UUID) -> None:
    ok = await supabase_update(ANALYSIS_RUNS, run_id, {"status": RunStatus.COMPLETED, "completed_at": utcnow_iso()})
    if not ok:
        # Do NOT log "→ completed" — that was the exact lie this fix closes.
        # Raise instead of swallowing: the orchestrator's own catch-all
        # already exists to call mark_run_failed on any internal error, so
        # this run gets an honest terminal status instead of being stranded
        # at status='running' forever with a live Realtime spinner and no
        # visible error (#6 audit).
        raise RuntimeError(f"mark_run_completed: DB write failed for run {run_id} after retries")
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
    # Deliberately does NOT raise on failure here (unlike the other writers
    # below) — this IS the pipeline's own last-resort error handler
    # (orchestrator.py's catch-all calls it), so it must never itself throw
    # an unhandled exception. If its own write fails, log that honestly
    # instead of the misleading "→ failed" — the row is then genuinely
    # stuck at whatever status it had before, same failure class as #6, but
    # with nowhere further to escalate to.
    ok = await supabase_update(ANALYSIS_RUNS, run_id, {
        "status":        RunStatus.FAILED,
        "error_message": error[:2000],
        "completed_at":  utcnow_iso(),
        "step_status":   step_status,
    })
    if ok:
        logger.info("run %s → failed (%s)", run_id, error[:120])
    else:
        logger.error(
            "run %s: mark_run_failed's own DB write failed after retries — "
            "run status was NOT updated to 'failed' (intended error: %s)",
            run_id, error[:120],
        )


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
    """Persist a step's output to its dedicated column on analysis_runs.

    Raises on a persistent write failure instead of silently continuing —
    a swallowed failure here previously let the run reach mark_run_completed
    with this column still NULL and no error surfaced anywhere (#7 audit).
    The orchestrator's catch-all routes this into mark_run_failed.
    """
    ok = await supabase_update(ANALYSIS_RUNS, run_id, {column: value})
    if not ok:
        raise RuntimeError(
            f"save_step_result: DB write of column '{column}' failed for run {run_id} after retries"
        )


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
    only when the conditional UPDATE genuinely matched zero rows — i.e. the
    run had already been marked failed/cancelled by the time this call
    landed. Deliberately does NOT catch exceptions: a DB/network error here
    must propagate to the orchestrator's own exception handling
    (mark_run_failed), the same as it did before this function existed. An
    earlier version of this function swallowed errors and returned False,
    which the orchestrator's caller treats identically to a genuine
    cancellation (silent no-op, no mark_run_failed — the row is assumed
    already terminal). For a real infra error that assumption is false: the
    run was left stuck at status='running' forever, its already-generated
    artifact deleted, on nothing worse than a transient blip. Correctness
    on ambiguity (did the write actually land server-side despite a lost
    response?) is handled downstream by the DB trigger itself
    (migration 006), which decides commit-vs-void from the column's actual
    persisted state — not from what this function inferred about why it
    couldn't confirm the write.
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

    return await asyncio.to_thread(_do)
