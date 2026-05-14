"""
Pipeline orchestrator — runs the 7-step CV-tailoring pipeline end-to-end.

Entry point is `run_analysis_pipeline(payload)`, scheduled as a FastAPI
BackgroundTask by /internal/analyze. Receives all needed inputs in the
payload (JD text, CV text, BYOK key) — no DB lookups for inputs.

Writes step state + results back to analysis_runs via Supabase REST.

⚠️ Phase 2 (this commit) — scaffolding only. Just marks the run running +
   completed so we can verify the write path is wired. Actual pipeline steps
   are added back in Phase 5 (step 1) and Phase 6 (steps 2–6.6).
"""
from __future__ import annotations

import logging

from app.schemas.internal import AnalyzeRequest
from app.services.ai.client import AIClientError, make_ai_client
from app.services.pipeline.jd_expiry import detect_jd_expiry
from app.services.pipeline.progress import (
    DEFAULT_STEP_STATUS,
    mark_run_completed,
    mark_run_failed,
    mark_run_running,
    mark_step,
    save_step_result,
)
from app.services.pipeline.steps.jd_analysis import run_jd_analysis

logger = logging.getLogger(__name__)


async def run_analysis_pipeline(payload: AnalyzeRequest) -> None:
    """Top-level pipeline entry. Owns its own error handling — never raises."""
    run_id      = payload.run_id
    step_status = dict(DEFAULT_STEP_STATUS)

    try:
        await mark_run_running(run_id)

        # Early-exit if the JD itself says the role is closed.
        expiry = detect_jd_expiry(payload.jd_text)
        if expiry:
            logger.info("run %s aborted — JD expired: %s", run_id, expiry)
            await mark_run_failed(
                run_id,
                f"Job appears to be closed: {expiry}. "
                "Verify the listing is still accepting applications.",
                step_status,
                failed_step="jd_analysis",
            )
            return

        # Construct the BYOK AI client. Raises AIClientError on invalid input.
        ai_client = make_ai_client(payload.ai_provider, payload.ai_api_key, payload.ai_model)
        logger.info(
            "run %s: starting pipeline (provider=%s model=%s jd_len=%d cv_len=%d)",
            run_id, payload.ai_provider, ai_client.model,
            len(payload.jd_text), len(payload.cv_text),
        )

        # ── Step 1 — JD analysis ───────────────────────────────────────────────
        await mark_step(run_id, step_status, "jd_analysis", "running")
        jd_analysis = await run_jd_analysis(ai_client, payload.jd_text)
        await save_step_result(run_id, "jd_analysis_result", jd_analysis)
        await mark_step(run_id, step_status, "jd_analysis", "completed")

        # ── Phase 6 will add steps 2–6.6 here. For now, end the run after step 1
        #    so Phase 5 can verify the end-to-end flow with Realtime updates.
        await mark_run_completed(run_id)

    except AIClientError as exc:
        await mark_run_failed(run_id, f"AI client: {exc}", step_status)
    except Exception as exc:
        logger.exception("run %s crashed", run_id)
        await mark_run_failed(run_id, f"Internal error: {exc}", step_status)
