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

import asyncio

from app.config import get_settings
from app.database import get_supabase
from app.schemas.internal import AnalyzeRequest
from app.services.ai.client import AIClientError, make_ai_client
from app.services.cv.pdf_generator import generate_pdf_from_markdown
from app.services.pipeline.jd_expiry import detect_jd_expiry
from app.services.pipeline.progress import (
    DEFAULT_STEP_STATUS,
    mark_run_completed,
    mark_run_failed,
    mark_run_running,
    mark_step,
    save_step_result,
)
from app.services.pipeline.steps.ai_recommendations import run_ai_recommendations
from app.services.pipeline.steps.ats_scoring import run_ats_scoring
from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
from app.services.pipeline.steps.input_recommendations import run_input_recommendations
from app.services.pipeline.steps.jd_analysis import run_jd_analysis
from app.services.pipeline.steps.keyword_feasibility import run_keyword_feasibility
from app.services.pipeline.steps.tailored_cv import run_tailored_cv
from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
from app.services.pipeline.steps.tailored_structural_validation import (
    run_tailored_structural_validation,
)

logger = logging.getLogger(__name__)


async def run_analysis_pipeline(payload: AnalyzeRequest) -> None:
    """Top-level pipeline entry. Owns its own error handling — never raises."""
    run_id      = payload.run_id
    step_status = dict(DEFAULT_STEP_STATUS)

    try:
        await mark_run_running(run_id)
        # Phase E-1 — record the run provenance (manual vs automated worker).
        # Recorded once at the very start so the row reflects the trigger
        # even when the pipeline early-stops at a gate later on.
        if payload.automation:
            await save_step_result(run_id, "automation", True)

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

        # ── Step 2 — CV ↔ JD matching ──────────────────────────────────────────
        await mark_step(run_id, step_status, "cv_jd_matching", "running")
        matching = await run_cv_jd_matching(ai_client, payload.cv_text, jd_analysis)
        await save_step_result(run_id, "cv_jd_matching_result", matching)
        await mark_step(run_id, step_status, "cv_jd_matching", "completed")

        # ── Step 3 — ATS scoring (deterministic) ───────────────────────────────
        await mark_step(run_id, step_status, "ats_scoring", "running")
        ats = run_ats_scoring(payload.cv_text, jd_analysis, matching)
        await save_step_result(run_id, "ats_scoring_result", ats)
        await save_step_result(run_id, "match_score", ats.get("overall_score"))

        # ── Initial-ATS gate (Phase C-2 record + Phase C-3 early-stop) ────────
        # Mirror match_score into initial_ats_score so Phase B's UI doesn't
        # need to know the synonym. passed_initial_gate is recorded regardless.
        initial_score = ats.get("overall_score")
        passed_initial_gate: Optional[bool] = None
        if initial_score is not None:
            passed_initial_gate = initial_score >= payload.min_initial_ats
            await save_step_result(run_id, "initial_ats_score", initial_score)
            await save_step_result(run_id, "passed_initial_gate", passed_initial_gate)
        await mark_step(run_id, step_status, "ats_scoring", "completed")

        # ── Phase C-3 early-stop: gate failed AND no override ─────────────────
        # Saves the tailored-CV + downstream AI calls (~3 calls per job).
        # Manual override path: the web layer sets skip_initial_gate=True
        # when the user clicks "Force tailoring anyway".
        if passed_initial_gate is False and not payload.skip_initial_gate:
            logger.info(
                "run %s: initial gate failed (%s < %s) — stopping before tailoring "
                "(skip_initial_gate=false). Saves ~3 AI calls.",
                run_id, initial_score, payload.min_initial_ats,
            )
            # Mark downstream steps as 'skipped' so the UI can distinguish
            # a deliberate skip from a pending/failed state.
            for skipped_step in (
                "input_recommendations",
                "keyword_feasibility",
                "ai_recommendations",
                "tailored_cv",
            ):
                step_status[skipped_step] = "skipped"
            await save_step_result(run_id, "step_status", step_status)
            await mark_run_completed(run_id)
            return

        # ── Step 4 — Input recommendations (deterministic) ─────────────────────
        await mark_step(run_id, step_status, "input_recommendations", "running")
        input_recs = run_input_recommendations(payload.cv_text, jd_analysis, matching, ats)
        await save_step_result(run_id, "input_recommendations", input_recs)
        await mark_step(run_id, step_status, "input_recommendations", "completed")

        # ── Step 4.5 — Keyword feasibility classifier ──────────────────────────
        # Decides which missed JD keywords can be legitimately surfaced in the
        # tailored CV vs which are honest gaps. The tailored-CV writer below
        # only injects entries this step approves.
        await mark_step(run_id, step_status, "keyword_feasibility", "running")
        feasibility = await run_keyword_feasibility(
            ai_client, payload.cv_text, jd_analysis, matching, input_recs,
        )
        await save_step_result(run_id, "keyword_feasibility", feasibility)
        await mark_step(run_id, step_status, "keyword_feasibility", "completed")

        # ── Step 5 — AI recommendations (markdown) ─────────────────────────────
        await mark_step(run_id, step_status, "ai_recommendations", "running")
        recs_md = await run_ai_recommendations(
            ai_client, payload.cv_text, jd_analysis, matching, input_recs, feasibility,
        )
        await save_step_result(run_id, "ai_recommendations", recs_md)
        await mark_step(run_id, step_status, "ai_recommendations", "completed")

        # ── Step 6 — Tailored CV (markdown + PDF render) ───────────────────────
        # contact_details (when present) stamps the user's canonical contact
        # info onto the H1's contact line — name, phone, email, profile links,
        # portfolio URL. The 'projects' sub-array is already merged into
        # cv_text upstream by JobTrackr's analyze route.
        await mark_step(run_id, step_status, "tailored_cv", "running")
        tailored_md, tailored_storage_path = await run_tailored_cv(
            ai_client, payload.user_id, run_id, payload.cv_text,
            jd_analysis, recs_md, feasibility,
            contact_details=payload.contact_details,
        )
        await save_step_result(run_id, "tailored_cv_storage_path", tailored_storage_path)

        # ── Step 6 (PDF) — render markdown → PDF, upload alongside the .md ─────
        # ReportLab is CPU-bound, so wrap in asyncio.to_thread to keep the event
        # loop free. Non-fatal — if PDF render fails we keep the markdown only;
        # user can still copy the markdown out of the UI.
        try:
            settings = get_settings()
            supabase = get_supabase()
            pdf_path = f"{payload.user_id}/{run_id}.pdf"

            def _render_and_upload() -> None:
                pdf_bytes = generate_pdf_from_markdown(tailored_md)
                bucket = settings.SUPABASE_TAILORED_CV_BUCKET
                try:
                    supabase.storage.from_(bucket).upload(
                        path=pdf_path,
                        file=pdf_bytes,
                        file_options={"content-type": "application/pdf", "upsert": "true"},
                    )
                except Exception as exc:
                    # Object may exist from a previous run id collision — retry as update.
                    logger.warning("Tailored PDF upload failed (%s) — retrying via update()", exc)
                    supabase.storage.from_(bucket).update(
                        path=pdf_path,
                        file=pdf_bytes,
                        file_options={"content-type": "application/pdf"},
                    )

            await asyncio.to_thread(_render_and_upload)
            await save_step_result(run_id, "tailored_pdf_storage_path", pdf_path)
            logger.info("run %s: tailored PDF rendered → %s", run_id, pdf_path)
        except Exception as exc:
            logger.exception("run %s: tailored PDF render failed (non-fatal): %s", run_id, exc)

        # ── Step 6.5 — Deterministic re-score of the tailored CV ───────────────
        rescore = run_tailored_rescoring(
            tailored_md, jd_analysis, matching, feasibility, ats,
        )

        # ── Step 6.6 — Deterministic structural validation ─────────────────────
        structural_report = run_tailored_structural_validation(
            tailored_md, payload.cv_text, jd_analysis=jd_analysis,
        )
        tailored_ats_payload = dict(rescore["tailored_ats_scoring_result"])
        tailored_ats_payload["structural_report"] = structural_report
        if structural_report.get("summary", {}).get("fail"):
            logger.info(
                "run %s: tailored CV structural validation — %d fail, %d warn, %d pass",
                run_id,
                structural_report["summary"]["fail"],
                structural_report["summary"]["warn"],
                structural_report["summary"]["pass"],
            )

        await save_step_result(run_id, "tailored_ats_scoring_result", tailored_ats_payload)
        await save_step_result(run_id, "tailored_match_score", rescore["tailored_match_score"])
        await save_step_result(run_id, "ats_lift", rescore["ats_lift"])

        # ── Final-ATS gate (Phase C-2 — record only, no early-stop) ───────────
        # Phase E will use this to decide whether to run cover-letter
        # generation; for now the cover-letter step is always user-triggered
        # so this is information-only.
        final_score = rescore["tailored_match_score"]
        if final_score is not None:
            await save_step_result(
                run_id, "passed_final_gate",
                final_score >= payload.min_final_ats,
            )
        await save_step_result(run_id, "injected_keywords", {
            "injected":         rescore["injected_keywords"],
            "failed_to_inject": rescore["failed_to_inject"],
            "honest_gaps":      rescore["honest_gaps"],
            "fabricated":       rescore.get("fabricated_keywords") or [],
        })
        await mark_step(run_id, step_status, "tailored_cv", "completed")

        await mark_run_completed(run_id)
        logger.info("run %s: pipeline completed (score=%s lift=%s)",
                    run_id, ats.get("overall_score"), rescore["ats_lift"])

    except AIClientError as exc:
        await mark_run_failed(run_id, f"AI client: {exc}", step_status)
    except Exception as exc:
        logger.exception("run %s crashed", run_id)
        await mark_run_failed(run_id, f"Internal error: {exc}", step_status)
