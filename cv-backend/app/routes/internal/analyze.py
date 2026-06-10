from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, status

from app.database import get_supabase
from app.schemas.internal import (
    AnalyzeEvalRequest,
    AnalyzeEvalResponse,
    AnalyzeRequest,
    AnalyzeResponse,
    EvalRunResponse,
)
from app.services.ai.client import AIClientError, make_ai_client
from app.services.pipeline.orchestrator import run_analysis_pipeline
from app.services.eval.runner import create_placeholder, run_eval_background

logger = logging.getLogger(__name__)

router = APIRouter()

# ── /internal/analyze ─────────────────────────────────────────────────────────

@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze(
    body: AnalyzeRequest,
    background_tasks: BackgroundTasks,
) -> AnalyzeResponse:
    """
    Accept a pipeline trigger. Returns 202 immediately; the pipeline runs as a
    FastAPI BackgroundTask and writes step results to analysis_runs.{run_id}
    via Supabase service-role.
    """
    logger.info(
        "received run %s (user=%s provider=%s jd_len=%d cv_len=%d)",
        body.run_id, body.user_id, body.ai_provider,
        len(body.jd_text), len(body.cv_text),
    )
    background_tasks.add_task(run_analysis_pipeline, body)
    return AnalyzeResponse(run_id=body.run_id)


# ── /internal/analyze-eval (beta A/B/C/D harness) ─────────────────────────────

@router.post(
    "/analyze-eval",
    response_model=AnalyzeEvalResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_eval(
    body: AnalyzeEvalRequest,
    background_tasks: BackgroundTasks,
) -> AnalyzeEvalResponse:
    """
    Trigger ONE writer×scorer variant on a pasted CV+JD. Returns 202 + the
    eval_run_id immediately; the run executes as a BackgroundTask and the row
    is UPDATEd with the result (status='completed') or the error
    (status='failed'). Web polls GET /internal/eval-run/{id} until done.

    Founder-only beta tool — results go to the isolated eval_runs table,
    never to analysis_runs.

    NOTE: cv_text / jd_text are PII-adjacent — only lengths are logged.
    """
    logger.info(
        "analyze-eval: writer=%s scorer=%s vertical=%s provider=%s jd_len=%d cv_len=%d",
        body.writer_variant, body.scorer_variant, body.vertical,
        body.ai_provider, len(body.jd_text), len(body.cv_text),
    )

    try:
        ai_client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid AI client configuration: {exc}",
        ) from exc

    try:
        eval_run_id = create_placeholder(
            writer_variant=body.writer_variant,
            scorer_variant=body.scorer_variant,
            jd_label=body.jd_label,
            vertical=body.vertical,
            cv_source=body.cv_source,
            experiment_id=body.experiment_id,
            iteration=body.iteration,
            model=ai_client.model,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not create eval_runs row: {exc}",
        ) from exc

    background_tasks.add_task(
        run_eval_background,
        eval_run_id,
        client=ai_client,
        cv_text=body.cv_text,
        jd_text=body.jd_text,
        writer_variant=body.writer_variant,
        scorer_variant=body.scorer_variant,
        contact_details=body.contact_details,
        vertical=body.vertical,
    )

    return AnalyzeEvalResponse(eval_run_id=eval_run_id)


@router.get(
    "/eval-run/{eval_run_id}",
    response_model=EvalRunResponse,
    status_code=status.HTTP_200_OK,
)
async def get_eval_run(eval_run_id: str) -> EvalRunResponse:
    """
    Fetch a single eval_runs row by id. Polled by the web beta screen until
    status flips to 'completed' or 'failed'.
    """
    try:
        res = (
            get_supabase()
            .table("eval_runs")
            .select(
                "id, status, error, writer_variant, scorer_variant, model, "
                "jd_label, vertical, cv_source, experiment_id, iteration, "
                "tailored_md, initial_ats, final_ats, ats_lift, "
                "structural_summary, grounding_report, rescore_report, "
                "auto_metrics, timings_ms, created_at"
            )
            .eq("id", eval_run_id)
            .single()
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"eval_runs row not found: {exc}",
        ) from exc

    if not res.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="eval_runs row not found",
        )

    row = dict(res.data)
    # Supabase returns created_at as a datetime string; coerce to str if needed.
    if row.get("created_at") is not None:
        row["created_at"] = str(row["created_at"])
    return EvalRunResponse(**row)


# ── /internal/extract-cv-text ────────────────────────────────────────────────


