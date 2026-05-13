"""
Helpers for updating analysis-run state during pipeline execution.

Each call commits the session so that Supabase Realtime broadcasts the change
to subscribed frontend clients in near-real-time.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.models.analysis_run import AnalysisRun

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
StepState = Literal["pending", "running", "completed", "failed"]


async def get_run(db: AsyncSession, run_id) -> AnalysisRun:  # type: ignore[no-untyped-def]
    result = await db.execute(select(AnalysisRun).where(AnalysisRun.id == run_id))
    run = result.scalar_one()
    return run


async def mark_step(
    db: AsyncSession,
    run: AnalysisRun,
    step: StepName,
    state: StepState,
) -> None:
    """Update step_status[step] and commit so Realtime fires."""
    status = dict(run.step_status or {})
    status[step] = state
    run.step_status = status
    flag_modified(run, "step_status")
    await db.commit()
    logger.info("Run %s: step %s → %s", run.id, step, state)


async def mark_run_running(db: AsyncSession, run: AnalysisRun) -> None:
    run.status = "running"
    run.started_at = datetime.now(timezone.utc)
    await db.commit()


async def mark_run_completed(db: AsyncSession, run: AnalysisRun) -> None:
    run.status = "completed"
    run.completed_at = datetime.now(timezone.utc)
    await db.commit()


async def mark_run_failed(
    db: AsyncSession, run: AnalysisRun, error: str, failed_step: Optional[StepName] = None
) -> None:
    run.status = "failed"
    run.error_message = error[:2000]  # cap length
    run.completed_at = datetime.now(timezone.utc)

    # Always reconcile step_status so the frontend doesn't render a step
    # spinner for a step that will never complete. If the caller named the
    # failed step, mark it as failed; otherwise auto-detect any step in
    # "running" or "pending" state and mark them as failed.
    status = dict(run.step_status or {})
    if failed_step:
        status[failed_step] = "failed"
    else:
        for step_name, step_state in list(status.items()):
            if step_state == "running":
                status[step_name] = "failed"
    run.step_status = status
    flag_modified(run, "step_status")
    await db.commit()


async def save_step_result(
    db: AsyncSession,
    run: AnalysisRun,
    column: str,
    value: Any,
) -> None:
    """Set a result column (e.g. jd_analysis_result) and commit."""
    setattr(run, column, value)
    if isinstance(value, (dict, list)):
        flag_modified(run, column)
    await db.commit()
