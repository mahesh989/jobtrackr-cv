"""
Pipeline orchestrator. Runs the 6-step analysis end-to-end.

Each step:
  1. Marks step_status[name] = "running" (commit → Realtime fires)
  2. Executes (AI or deterministic compute)
  3. Saves the result column (commit → Realtime fires)
  4. Marks step_status[name] = "completed" (commit → Realtime fires)

On failure: marks failed step + run.status = "failed" + error_message,
and exits early.
"""
from __future__ import annotations

import logging
import uuid

from app.database import AsyncSessionLocal
from app.models.company import Company
from app.models.user import User
from app.models.user_preference import UserPreference
from sqlalchemy import select

from app.core.quota import increment_quota
from app.services.ai.client import AIClientError, get_ai_client_for_user
from app.services.notifications.email import send_analysis_complete
from app.services.pipeline.cv_resolver import CVResolutionError, resolve_cv_text
from app.services.pipeline.jd_expiry import detect_jd_expiry
from app.services.pipeline.progress import (
    get_run,
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


async def run_analysis_pipeline(run_id: uuid.UUID) -> None:
    """Top-level entry point. Opens its own DB session (background-task safe)."""
    async with AsyncSessionLocal() as db:
        try:
            run = await get_run(db, run_id)
        except Exception:
            logger.exception("Pipeline: cannot load run %s", run_id)
            return

        try:
            await mark_run_running(db, run)

            # ----------------------------------------------------------------
            # Resolve CV text + AI client + JD text
            # ----------------------------------------------------------------
            cv_text = await resolve_cv_text(db, run)

            company_result = await db.execute(
                select(Company).where(Company.id == run.company_id)
            )
            company = company_result.scalar_one()
            jd_text = company.jd_text or ""
            if not jd_text.strip():
                raise ValueError("Company has no JD text")

            # Early-exit: if the JD itself says the role is closed /
            # expired / filled, abort before spending any AI tokens.
            expiry_reason = detect_jd_expiry(jd_text)
            if expiry_reason:
                logger.info(
                    "Pipeline %s aborted — JD expired: %s", run_id, expiry_reason,
                )
                await mark_run_failed(
                    db, run,
                    f"Job appears to be closed: {expiry_reason} "
                    "Please verify the listing is still accepting applications "
                    "before re-running the analysis.",
                    failed_step="jd_analysis",
                )
                return

            ai_client = await get_ai_client_for_user(run.user_id, db)

            # Saved contact details (if any) — used to stamp a clean contact
            # line onto the tailored CV.
            pref_result = await db.execute(
                select(UserPreference).where(UserPreference.user_id == run.user_id)
            )
            pref_row = pref_result.scalar_one_or_none()
            contact_details = pref_row.contact_details if pref_row else None

            # ----------------------------------------------------------------
            # Step 1 — JD Analysis
            # ----------------------------------------------------------------
            await mark_step(db, run, "jd_analysis", "running")
            jd_analysis = await run_jd_analysis(ai_client, jd_text)
            await save_step_result(db, run, "jd_analysis_result", jd_analysis)
            await mark_step(db, run, "jd_analysis", "completed")

            # ----------------------------------------------------------------
            # Step 2 — CV-JD Matching
            # ----------------------------------------------------------------
            await mark_step(db, run, "cv_jd_matching", "running")
            matching = await run_cv_jd_matching(ai_client, cv_text, jd_analysis)
            await save_step_result(db, run, "cv_jd_matching_result", matching)
            await mark_step(db, run, "cv_jd_matching", "completed")

            # ----------------------------------------------------------------
            # Step 3 — ATS Scoring (deterministic)
            # ----------------------------------------------------------------
            await mark_step(db, run, "ats_scoring", "running")
            ats = run_ats_scoring(cv_text, jd_analysis, matching)
            await save_step_result(db, run, "ats_scoring_result", ats)
            run.match_score = ats.get("overall_score")
            await db.commit()
            await mark_step(db, run, "ats_scoring", "completed")

            # ----------------------------------------------------------------
            # Step 4 — Input Recommendations (deterministic)
            # ----------------------------------------------------------------
            await mark_step(db, run, "input_recommendations", "running")
            input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)
            await save_step_result(db, run, "input_recommendations", input_recs)
            await mark_step(db, run, "input_recommendations", "completed")

            # ----------------------------------------------------------------
            # Step 4.5 — Keyword Feasibility Classifier
            # Decides which missed JD keywords can be legitimately surfaced
            # in the tailored CV, and which are honest gaps. The downstream
            # tailored-CV writer is allowed to inject only the entries this
            # step puts in inject_directly / inject_as_extension.
            # ----------------------------------------------------------------
            await mark_step(db, run, "keyword_feasibility", "running")
            feasibility = await run_keyword_feasibility(
                ai_client, cv_text, jd_analysis, matching, input_recs
            )
            await save_step_result(db, run, "keyword_feasibility", feasibility)
            await mark_step(db, run, "keyword_feasibility", "completed")

            # ----------------------------------------------------------------
            # Step 5 — AI Recommendations (markdown)
            # ----------------------------------------------------------------
            await mark_step(db, run, "ai_recommendations", "running")
            recs_md = await run_ai_recommendations(
                ai_client, cv_text, jd_analysis, matching, input_recs,
                feasibility,
            )
            await save_step_result(db, run, "ai_recommendations", recs_md)
            await mark_step(db, run, "ai_recommendations", "completed")

            # ----------------------------------------------------------------
            # Step 6 — Tailored CV (consumes feasibility plan as authoritative)
            # ----------------------------------------------------------------
            await mark_step(db, run, "tailored_cv", "running")
            tailored_md, storage_path = await run_tailored_cv(
                ai_client, run.user_id, run.id, cv_text,
                jd_analysis, recs_md, feasibility,
                contact_details=contact_details,
            )
            await save_step_result(db, run, "tailored_cv_storage_path", storage_path)

            # ----------------------------------------------------------------
            # Step 6.5 — Deterministic re-score of the tailored CV.
            # Verifies which approved keywords actually appear in the tailored
            # markdown and computes the honest ATS lift. No AI call.
            # ----------------------------------------------------------------
            rescore = run_tailored_rescoring(
                tailored_md, jd_analysis, matching, feasibility, ats
            )

            # Step 6.6 — Deterministic structural validation. Pure code,
            # no AI call. Attach the report to the rescore result before
            # saving so we can stash it in the same JSON column without
            # a schema change.
            structural_report = run_tailored_structural_validation(
                tailored_md, cv_text, jd_analysis=jd_analysis,
            )
            tailored_ats_payload = dict(rescore["tailored_ats_scoring_result"])
            tailored_ats_payload["structural_report"] = structural_report
            if structural_report.get("summary", {}).get("fail"):
                logger.info(
                    "Tailored CV structural validation: %d fail, %d warn, %d pass",
                    structural_report["summary"]["fail"],
                    structural_report["summary"]["warn"],
                    structural_report["summary"]["pass"],
                )

            await save_step_result(
                db, run, "tailored_ats_scoring_result",
                tailored_ats_payload,
            )
            run.tailored_match_score = rescore["tailored_match_score"]
            run.ats_lift = rescore["ats_lift"]
            await save_step_result(
                db, run, "injected_keywords",
                {
                    "injected":        rescore["injected_keywords"],
                    "failed_to_inject": rescore["failed_to_inject"],
                    "honest_gaps":     rescore["honest_gaps"],
                    "fabricated":      rescore.get("fabricated_keywords") or [],
                },
            )
            await db.commit()
            await mark_step(db, run, "tailored_cv", "completed")

            # Charge a quota credit only on successful completion of the
            # full pipeline (tailored CV produced).  Failed runs are free.
            try:
                await increment_quota(run.user_id, db)
                await db.commit()
            except Exception:
                logger.exception("Failed to increment quota for run %s", run.id)

            await mark_run_completed(db, run)
            logger.info("Pipeline completed for run %s (score=%s)", run.id, run.match_score)

            # ----------------------------------------------------------------
            # Best-effort completion email — never raises
            # ----------------------------------------------------------------
            try:
                await _maybe_send_completion_email(db, run, company)
            except Exception:
                logger.exception("Failed to dispatch completion email for run %s", run.id)

        except CVResolutionError as exc:
            await mark_run_failed(db, run, f"CV resolution: {exc}")
        except AIClientError as exc:
            await mark_run_failed(db, run, f"AI client: {exc}")
        except ValueError as exc:
            await mark_run_failed(db, run, str(exc))
        except Exception as exc:
            logger.exception("Pipeline crashed for run %s", run_id)
            await mark_run_failed(db, run, f"Internal error: {exc}")


async def _maybe_send_completion_email(db, run, company: Company) -> None:
    """Send completion email if the user opted in (preference defaults to true)."""
    pref_result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == run.user_id)
    )
    pref = pref_result.scalar_one_or_none()
    if pref is not None and not pref.email_on_complete:
        return

    user_result = await db.execute(select(User).where(User.id == run.user_id))
    user = user_result.scalar_one_or_none()
    if user is None or not user.email:
        return

    await send_analysis_complete(
        to_email=user.email,
        full_name=user.full_name,
        company_name=company.display_name,
        job_title=company.job_title,
        match_score=run.match_score,
        run_id=str(run.id),
    )
