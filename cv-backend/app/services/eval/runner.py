"""
Eval runner — executes ONE (writer × scorer) run on a CV+JD.

Two paths:

  • compute_eval(...)            -> pure computation, returns the result dict
                                    (no DB writes). Used by tests / CLI / sync.

  • run_eval_background(id, ...) -> awaitable that calls compute_eval then
                                    UPDATEs the eval_runs row by id with the
                                    result (status='completed') or the error
                                    (status='failed'). Scheduled by the
                                    /internal/analyze-eval endpoint via
                                    FastAPI BackgroundTasks so the HTTP call
                                    returns immediately (no Vercel timeout).

  • create_placeholder(...)      -> INSERT a 'running' row up-front and return
                                    its id, so the web can poll for the
                                    result while the background task runs.
"""
from __future__ import annotations

import logging
import time
import traceback
from typing import Any, Dict, Optional

from app.database import get_supabase
from app.services.ai.client import AIClient, AIClientError
from app.services.eval.grounding import compute_grounding
from app.services.eval.scorers import get_scorer
from app.services.eval.writers import get_writer
from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
from app.services.pipeline.steps.tailored_structural_validation import (
    run_tailored_structural_validation,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pure compute
# ---------------------------------------------------------------------------


async def compute_eval(
    *,
    client: AIClient,
    cv_text: str,
    jd_text: str,
    writer_variant: str,
    scorer_variant: str,
    contact_details: Optional[Dict[str, Any]] = None,
    vertical: Optional[str] = None,
) -> Dict[str, Any]:
    """Compute one eval; never touches the DB. Raises ValueError / AIClientError."""
    writer = get_writer(writer_variant)
    scorer = get_scorer(scorer_variant)

    t0 = time.perf_counter()
    wr = await writer(client, cv_text, jd_text, contact_details, vertical=vertical)
    t_writer = time.perf_counter() - t0

    rescore = run_tailored_rescoring(
        wr.tailored_md, wr.jd_analysis, wr.matching, wr.feasibility,
        wr.initial_ats_internal,
    )
    tailored_matching = rescore["tailored_matching"]

    t1 = time.perf_counter()
    initial_ats = scorer(cv_text, wr.jd_analysis, wr.matching)
    # For the TAILORED score we hand the scorer the original CV so grounding-
    # aware scorers (S2) can verify each matched keyword is CV-traceable.
    # S1 ignores this kwarg.
    final_ats = scorer(
        wr.tailored_md, wr.jd_analysis, tailored_matching,
        original_cv_text=cv_text,
    )
    t_scorer = time.perf_counter() - t1

    initial_score = int(initial_ats.get("overall_score") or 0)
    final_score = int(final_ats.get("overall_score") or 0)
    ats_lift = final_score - initial_score

    structural = run_tailored_structural_validation(
        wr.tailored_md, cv_text, jd_analysis=wr.jd_analysis
    )
    grounding = compute_grounding(wr.tailored_md, cv_text)

    rescore_report = {
        "injected_keywords":     rescore.get("injected_keywords") or [],
        "failed_to_inject":      rescore.get("failed_to_inject") or [],
        "filtered_as_non_skill": rescore.get("filtered_as_non_skill") or [],
        "honest_gaps":           rescore.get("honest_gaps") or [],
        "fabricated_keywords":   rescore.get("fabricated_keywords") or [],
    }

    timings_ms = {
        "writer": round(t_writer * 1000),
        "scorer": round(t_scorer * 1000),
        "total": round((time.perf_counter() - t0) * 1000),
    }

    auto_metrics = {
        "structural_fail": structural.get("summary", {}).get("fail", 0),
        "structural_warn": structural.get("summary", {}).get("warn", 0),
        "ungrounded_count": grounding.get("ungrounded_count", 0),
        "fabricated_count": len(rescore_report["fabricated_keywords"]),
        "injected_count": len(rescore_report["injected_keywords"]),
        "failed_to_inject_count": len(rescore_report["failed_to_inject"]),
        "honest_gaps_count": len(rescore_report["honest_gaps"]),
        "tailored_word_count": len((wr.tailored_md or "").split()),
        "job_title": wr.jd_analysis.get("job_title"),
        "seniority_level": wr.jd_analysis.get("seniority_level"),
    }

    return {
        "writer_variant": writer_variant,
        "scorer_variant": scorer_variant,
        "model": client.model,
        "tailored_md": wr.tailored_md,
        "initial_ats": initial_score,
        "final_ats": final_score,
        "ats_lift": ats_lift,
        "structural_summary": structural,
        "grounding_report": grounding,
        "rescore_report": rescore_report,
        "auto_metrics": auto_metrics,
        "timings_ms": timings_ms,
    }


# ---------------------------------------------------------------------------
# Persistence — placeholder + background completion
# ---------------------------------------------------------------------------


def create_placeholder(
    *,
    writer_variant: str,
    scorer_variant: str,
    jd_label: Optional[str] = None,
    vertical: Optional[str] = None,
    cv_source: Optional[str] = None,
    experiment_id: Optional[str] = None,
    iteration: int = 1,
    model: Optional[str] = None,
) -> str:
    """INSERT a 'running' eval_runs row and return its id."""
    row = {
        "writer_variant": writer_variant,
        "scorer_variant": scorer_variant,
        "jd_label": jd_label,
        "vertical": vertical,
        "cv_source": cv_source,
        "experiment_id": experiment_id,
        "iteration": iteration,
        "model": model,
        "status": "running",
    }
    res = get_supabase().table("eval_runs").insert(row).execute()
    if not res.data:
        raise RuntimeError("Failed to create eval_runs placeholder row")
    return res.data[0]["id"]


def _update_row(eval_run_id: str, patch: Dict[str, Any]) -> None:
    try:
        get_supabase().table("eval_runs").update(patch).eq("id", eval_run_id).execute()
    except Exception as exc:  # noqa: BLE001 — best-effort persistence
        logger.warning("eval_runs update failed for %s: %s", eval_run_id, exc)


async def run_eval_background(
    eval_run_id: str,
    *,
    client: AIClient,
    cv_text: str,
    jd_text: str,
    writer_variant: str,
    scorer_variant: str,
    contact_details: Optional[Dict[str, Any]] = None,
    vertical: Optional[str] = None,
) -> None:
    """
    Background task: compute one eval, then UPDATE its eval_runs row with the
    result (status='completed') or the error (status='failed'). Never raises —
    the FastAPI BackgroundTask shouldn't terminate the worker on failure.
    """
    try:
        result = await compute_eval(
            client=client,
            cv_text=cv_text,
            jd_text=jd_text,
            writer_variant=writer_variant,
            scorer_variant=scorer_variant,
            contact_details=contact_details,
            vertical=vertical,
        )
        _update_row(eval_run_id, {**result, "status": "completed"})
        logger.info(
            "eval %s done: writer=%s initial=%s final=%s lift=%s fab=%s ungrounded=%s",
            eval_run_id, writer_variant,
            result["initial_ats"], result["final_ats"], result["ats_lift"],
            result["auto_metrics"]["fabricated_count"],
            result["auto_metrics"]["ungrounded_count"],
        )
    except (AIClientError, ValueError) as exc:
        logger.exception("eval %s failed: %s", eval_run_id, exc)
        _update_row(eval_run_id, {"status": "failed", "error": str(exc)})
    except Exception as exc:  # noqa: BLE001 — never crash the worker
        logger.exception("eval %s crashed: %s", eval_run_id, exc)
        _update_row(eval_run_id, {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[:1000]}",
        })
