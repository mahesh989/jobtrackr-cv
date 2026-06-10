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
from app.services.automation.auto_cover_letter import auto_generate_cover_letter
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


class _CancelledByUser(Exception):
    """Raised when the user clicked Stop on the analysis run page.

    The web action marks analysis_runs.status='failed' with error='Cancelled
    by user'. We poll this row before each AI-heavy step and raise this
    exception to short-circuit the pipeline. The outer except handler is a
    no-op because the row is already in its terminal state.
    """


async def _check_cancelled(run_id) -> None:
    """Raise _CancelledByUser if the run row was marked failed by the user.

    Called before each expensive step. Cheap (single indexed read) — adds
    well under 50 ms but saves the cost of an entire downstream AI call.
    """
    def _do() -> dict:
        resp = (
            get_supabase()
            .table("analysis_runs")
            .select("status, error_message")
            .eq("id", str(run_id))
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else {}

    try:
        row = await asyncio.to_thread(_do)
    except Exception:  # noqa: BLE001 — DB blip shouldn't kill a paying user's run
        return
    if row.get("status") == "failed" and (row.get("error_message") or "").lower().startswith("cancelled"):
        logger.info("run %s — stop requested by user; aborting pipeline", run_id)
        raise _CancelledByUser()


async def _load_cached_results(run_id) -> dict:
    """Fetch the already-saved early-step outputs for a resume.

    Returns the run row's jd_analysis_result / cv_jd_matching_result /
    ats_scoring_result / match_score. Missing or null values are simply
    absent from the dict, so the caller recomputes that step defensively.
    """
    def _do() -> dict:
        resp = (
            get_supabase()
            .table("analysis_runs")
            .select("jd_analysis_result, cv_jd_matching_result, ats_scoring_result, match_score")
            .eq("id", str(run_id))
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else {}

    raw = await asyncio.to_thread(_do)
    return {k: v for k, v in raw.items() if v is not None}


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
        # Attach user_id + run_id so every complete() call is attributed in
        # the ai_calls observability table without threading context through
        # every prompt call site.
        ai_client = make_ai_client(payload.ai_provider, payload.ai_api_key, payload.ai_model)
        ai_client.user_id   = str(payload.user_id)
        ai_client.run_id    = str(run_id)
        logger.info(
            "run %s: starting pipeline (provider=%s model=%s jd_len=%d cv_len=%d)",
            run_id, payload.ai_provider, ai_client.model,
            len(payload.jd_text), len(payload.cv_text),
        )

        # On resume, reuse the early-step outputs already saved on the run so
        # the user isn't charged again for the JD analysis + CV↔JD matching AI
        # calls. Missing values fall through to a recompute (defensive).
        cached = await _load_cached_results(run_id) if payload.resume else {}

        # ── Step 1 — JD analysis ───────────────────────────────────────────────
        jd_analysis = cached.get("jd_analysis_result")
        if jd_analysis is not None:
            logger.info("run %s: reusing cached JD analysis (resume)", run_id)
            await mark_step(run_id, step_status, "jd_analysis", "completed")
        else:
            await mark_step(run_id, step_status, "jd_analysis", "running")
            jd_analysis = await run_jd_analysis(ai_client, payload.jd_text)
            await save_step_result(run_id, "jd_analysis_result", jd_analysis)
            await mark_step(run_id, step_status, "jd_analysis", "completed")

        # Attach the resolved role family + family-aware category labels so every
        # downstream step and the UI render category-1 as "Clinical Skills"
        # (nursing) / "Technical Skills" (tech) / "Core Skills" (manual) instead
        # of the IT-default "Technical". Rides in the jd_analysis_result JSON, so
        # no migration. Idempotent — recomputes only when absent (handles old
        # cached analyses on resume).
        # Keyed on category_order so a resume of a run enriched by an older
        # label scheme recomputes against the current one.
        if not jd_analysis.get("category_order"):
            from app.services.eval.role_families import (
                category_labels, category_order, resolve_role_family,
            )
            _rf = resolve_role_family(None, jd_analysis)
            jd_analysis["role_family"] = _rf.id
            jd_analysis["category_labels"] = category_labels(_rf)
            jd_analysis["category_order"] = category_order(_rf)
            await save_step_result(run_id, "jd_analysis_result", jd_analysis)

        # Lexicon post-process — re-classify the LLM's raw skill buckets via
        # the curated per-vertical lexicon. Drops universal noise (credentials,
        # eligibility statements, framework/value phrases) from skill buckets,
        # moves mis-bucketed skills to their canonical category, dedupes by
        # canonical form. Unknown phrases stay in the LLM-assigned bucket (safe
        # fallback). The sidecar (lexicon_meta) holds the dropped/moved items
        # for downstream routing (credentials → Registration & Licences) and
        # diagnostics. Idempotent — keyed on the presence of `lexicon_meta`.
        if "lexicon_meta" not in jd_analysis:
            # JD-body lexicon scan — surface canonical domain_knowledge skills
            # the IT-centric JD analysis prompt missed in prose-heavy
            # responsibilities. Closes the ATS-score variance caused by an
            # empty domain bucket triggering presence-aware redistribution.
            # Runs BEFORE post_process_jd_analysis so injected canonicals flow
            # through the same dedup / sidecar path as LLM-extracted ones.
            from app.services.skills import (
                enrich_required_skills_from_jd_body,
                post_process_jd_analysis,
            )
            jd_analysis = enrich_required_skills_from_jd_body(
                jd_analysis,
                payload.jd_text,
                role_family_id=str(jd_analysis.get("role_family") or "master"),
            )
            jd_analysis = post_process_jd_analysis(
                jd_analysis,
                role_family_id=str(jd_analysis.get("role_family") or "master"),
            )
            await save_step_result(run_id, "jd_analysis_result", jd_analysis)

        # ── Step 2 — CV ↔ JD matching ──────────────────────────────────────────
        matching = cached.get("cv_jd_matching_result")
        if matching is not None:
            logger.info("run %s: reusing cached CV↔JD matching (resume)", run_id)
            await mark_step(run_id, step_status, "cv_jd_matching", "completed")
        else:
            await mark_step(run_id, step_status, "cv_jd_matching", "running")
            matching = await run_cv_jd_matching(
                ai_client, payload.cv_text, jd_analysis,
                contact_details=payload.contact_details,
            )
            await save_step_result(run_id, "cv_jd_matching_result", matching)
            await mark_step(run_id, step_status, "cv_jd_matching", "completed")

        # ── Step 3 — ATS scoring (deterministic) ───────────────────────────────
        ats = cached.get("ats_scoring_result")
        if ats is not None:
            await mark_step(run_id, step_status, "ats_scoring", "completed")
        else:
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
        if passed_initial_gate is False and not (payload.skip_initial_gate or payload.resume):
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
        await _check_cancelled(run_id)
        await mark_step(run_id, step_status, "keyword_feasibility", "running")
        feasibility = await run_keyword_feasibility(
            ai_client, payload.cv_text, jd_analysis, matching, input_recs,
            contact_details=payload.contact_details,
        )
        await save_step_result(run_id, "keyword_feasibility", feasibility)
        await mark_step(run_id, step_status, "keyword_feasibility", "completed")

        # ── Step 5 — AI recommendations (markdown) ─────────────────────────────
        # The w8_verified writer composes from the feasibility plan directly and
        # never consumes these recommendations, so skip the AI call entirely on
        # that path — it keeps the per-run call count at legacy parity and avoids
        # showing "Will Be Applied" advice the writer doesn't actually apply.
        use_w8 = get_settings().TAILORED_CV_WRITER == "w8_verified"
        recs_md = ""
        if use_w8:
            step_status["ai_recommendations"] = "skipped"
            await save_step_result(run_id, "step_status", step_status)
        else:
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
        await _check_cancelled(run_id)
        await mark_step(run_id, step_status, "tailored_cv", "running")
        if use_w8:
            # Validated beta writer (role-family composition + deterministic
            # enforce + entailment verify). Reuses the upstream artifacts above
            # so it adds only the composition + verify calls. Same storage path
            # and (markdown, storage_path) contract as the legacy writer.
            logger.info("run %s: tailoring via w8_verified writer", run_id)
            from app.services.eval.writers import run_tailored_cv_w8_verified
            tailored_md, tailored_storage_path = await run_tailored_cv_w8_verified(
                ai_client, payload.user_id, run_id, payload.cv_text, payload.jd_text,
                jd_analysis, matching, ats, input_recs, feasibility,
                contact_details=payload.contact_details,
            )
        else:
            logger.info("run %s: tailoring via legacy writer", run_id)
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

        # ── Step 6.5 — Tailored-CV scoring (deterministic, consistent) ────────
        # Score the tailored CV with the SAME deterministic scorer and the SAME
        # baseline as the original (Step 3). Tailoring changes only keyword
        # coverage — measured by literal presence, exactly what an ATS keys on —
        # while the experience signal is held constant (honest tailoring
        # surfaces keywords, it does not add experience) and formatting is
        # floored at the original's. This makes the comparison apples-to-apples
        # and the lift monotonic: a genuinely improved CV can never score below
        # the original. (Replaces a prior AI re-match whose fresh,
        # non-deterministic call could push the tailored score BELOW the
        # original — the "bizarre regression" bug.) Identical to the beta
        # /analyze-eval harness, so beta and production agree exactly.
        rescore = run_tailored_rescoring(
            tailored_md, jd_analysis, matching, feasibility, ats,
        )
        tailored_ats_scored = rescore["tailored_ats_scoring_result"]
        tailored_score = rescore["tailored_match_score"]

        original_score = int((ats or {}).get("overall_score") or 0)
        tailored_score_int = int(tailored_score) if tailored_score is not None else None
        ats_lift_real = rescore["ats_lift"]
        logger.info(
            "run %s: tailored score — original=%s tailored=%s lift=%s",
            run_id, original_score, tailored_score_int, ats_lift_real,
        )

        # ── Step 6.6 — Deterministic structural validation ─────────────────────
        structural_report = run_tailored_structural_validation(
            tailored_md, payload.cv_text, jd_analysis=jd_analysis,
        )
        tailored_ats_payload = dict(tailored_ats_scored)
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
        await save_step_result(run_id, "tailored_match_score", tailored_score_int)
        await save_step_result(run_id, "ats_lift", ats_lift_real)

        # ── Final-ATS gate (Phase C-2 — record only, no early-stop) ───────────
        # Phase E will use this to decide whether to run cover-letter
        # generation; for now the cover-letter step is always user-triggered
        # so this is information-only.
        final_score = tailored_score_int
        if final_score is not None:
            await save_step_result(
                run_id, "passed_final_gate",
                final_score >= payload.min_final_ats,
            )
        await save_step_result(run_id, "injected_keywords", {
            "injected":              rescore["injected_keywords"],
            "failed_to_inject":      rescore["failed_to_inject"],
            "filtered_as_non_skill": rescore.get("filtered_as_non_skill") or [],
            "honest_gaps":           rescore["honest_gaps"],
            "fabricated":            rescore.get("fabricated_keywords") or [],
        })
        await mark_step(run_id, step_status, "tailored_cv", "completed")

        await mark_run_completed(run_id)
        logger.info("run %s: pipeline completed (score=%s tailored=%s lift=%s)",
                    run_id, ats.get("overall_score"), tailored_score_int, ats_lift_real)

        # ── Auto cover letter ────────────────────────────────────────────────
        # Triggered when the tailored score clears the user's final gate.
        # AWAITED (not fire-and-forget) so the outcome is recorded on the
        # analysis_run row before this function returns — see
        # auto_generate_cover_letter for the cover_letter_status state
        # machine. The 3-pass generation pipeline IS still detached as a
        # background task inside that function; only the trigger + INSERT
        # are awaited here (~200ms overhead, predictable).
        if final_score is not None and final_score >= payload.min_final_ats:
            logger.info(
                "auto-cover-letter: run %s — tailored score %s >= final gate %s — triggering",
                run_id, final_score, payload.min_final_ats,
            )
            jd_meta = payload.jd_meta or {}
            await auto_generate_cover_letter(
                run_id=       str(payload.run_id),
                user_id=      str(payload.user_id),
                jd_text=      payload.jd_text,
                job_title=    jd_meta.get("title", ""),
                company_name= jd_meta.get("company", ""),
                cv_text=      payload.cv_text,
                ai_provider=  payload.ai_provider,
                ai_api_key=   payload.ai_api_key,
                ai_model=     payload.ai_model,
            )
        else:
            # Visible reason recorded on the run so the UI can show
            # "Cover letter skipped: below threshold (62 < 70)" instead of
            # silent absence. NOTE: the gate compares the TAILORED score
            # (not the initial/displayed one).
            logger.info(
                "auto-cover-letter: run %s — NO letter: tailored score %s below final gate %s "
                "(gate uses the tailored score, not the initial ATS score)",
                run_id, final_score, payload.min_final_ats,
            )
            try:
                get_supabase().table("analysis_runs").update(
                    {"cover_letter_status": "skipped:below_gate"}
                ).eq("id", run_id).execute()
            except Exception as exc:  # noqa: BLE001 — best effort
                logger.warning("orchestrator: could not record below_gate outcome on run %s: %s", run_id, exc)

    except _CancelledByUser:
        # User clicked Stop on the analysis run page; the row was already
        # marked failed with "Cancelled by user" by the web action. Don't
        # overwrite that with mark_run_failed — just log and exit cleanly.
        logger.info("run %s: pipeline stopped by user", run_id)
    except AIClientError as exc:
        await mark_run_failed(run_id, f"AI client: {exc}", step_status)
    except Exception as exc:
        logger.exception("run %s crashed", run_id)
        await mark_run_failed(run_id, f"Internal error: {exc}", step_status)
