"""Orchestrator × C3b — cancel racing ahead of artifact persistence.

Regression cover for: a Stop click can land while the tailored-CV writer or
PDF renderer is still in flight. Before this fix, the pipeline persisted
the artifact's storage path unconditionally right after generating it —
so even though the Stop click's trigger already voided the paid
reservation, the artifact still ended up recorded (and downloadable) on
the row. These tests drive `_run_analysis_pipeline_inner` end-to-end with
every AI/DB call faked, and assert on the OBSERVABLE contract: does an
already-cancelled run ever end up with a persisted artifact path, does it
ever reach mark_run_completed, does it ever trigger auto-cover-letter
generation, and is the already-uploaded object cleaned up.

`save_artifact_if_active`'s own correctness (the conditional UPDATE) is
covered by test_save_artifact_if_active.py — these tests only cover the
orchestrator's REACTION to what it returns, so it's faked directly here
rather than simulating Supabase's conditional-update semantics again.
"""
import asyncio
import types

import app.services.pipeline.orchestrator as orch


def _run(coro):
    # Reuse the shared loop — matches test_pipeline_concurrency.py and the
    # documented convention in test_summary_anchor_retry.py's _await:
    # asyncio.run() closes/unsets the global loop and breaks other tests
    # that rely on asyncio.get_event_loop().run_until_complete().
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _fake_payload(**overrides):
    defaults = dict(
        run_id="run-1", user_id="user-1", cv_version_id="cvv-1",
        jd_text="a job description", jd_source_url=None, jd_meta={"title": "Nurse", "company": "Acme"},
        cv_text="a cv", contact_details=None,
        min_initial_ats=50, min_final_ats=70, skip_initial_gate=False,
        resume=False, automation=False, target_vertical="general",
        ai_provider="anthropic", ai_api_key="key", ai_model="claude-x",
    )
    defaults.update(overrides)
    return types.SimpleNamespace(**defaults)


def _install_common_mocks(monkeypatch, calls):
    """Stub every pipeline dependency to a fast, deterministic fake, and
    record ordering/args in `calls` (a dict of lists) for assertions.
    Forces the legacy (non-w8) writer branch so the writer + AI-recs calls
    stay module-level imports (patchable), avoiding the w8_verified writer's
    local import inside the function body."""

    class _FakeSettings:
        TAILORED_CV_WRITER = "legacy"
        SUPABASE_TAILORED_CV_BUCKET = "tailored-cvs"

    monkeypatch.setattr(orch, "get_settings", lambda: _FakeSettings())
    monkeypatch.setattr(orch, "detect_jd_expiry", lambda _text: None)

    class _FakeAiClient:
        model = "fake-model"

    monkeypatch.setattr(orch, "make_ai_client", lambda *a, **k: _FakeAiClient())
    monkeypatch.setattr(orch, "_check_cancelled", _record_async("check_cancelled", calls))
    monkeypatch.setattr(orch, "clean_jd_text", lambda text: (text, {}))
    monkeypatch.setattr(orch, "build_boilerplate_blob", lambda _m: "")
    monkeypatch.setattr(orch, "attach_role_family_labels", lambda jd, vertical: False)
    monkeypatch.setattr(orch, "enrich_jd_analysis", lambda jd, **k: {**jd, "lexicon_meta": {}})

    async def _fake_jd_analysis(*a, **k):
        return {"overall_score": 0}
    monkeypatch.setattr(orch, "run_jd_analysis", _fake_jd_analysis)

    async def _fake_matching(*a, **k):
        return {}
    monkeypatch.setattr(orch, "run_cv_jd_matching", _fake_matching)

    # High enough to clear min_initial_ats (50) — reach the tailoring steps.
    monkeypatch.setattr(orch, "run_ats_scoring", lambda *a, **k: {"overall_score": 90})
    monkeypatch.setattr(orch, "run_input_recommendations", lambda *a, **k: {})

    async def _fake_feasibility(*a, **k):
        return {}
    monkeypatch.setattr(orch, "run_keyword_feasibility", _fake_feasibility)

    async def _fake_ai_recs(*a, **k):
        return "recs"
    monkeypatch.setattr(orch, "run_ai_recommendations", _fake_ai_recs)

    async def _fake_writer(*a, **k):
        return "# Tailored CV markdown", "user-1/run-1.md"
    monkeypatch.setattr(orch, "run_tailored_cv", _fake_writer)

    async def _fake_pdf(*a, **k):
        return "user-1/run-1.pdf"
    monkeypatch.setattr(orch, "render_and_upload_tailored_pdf", _fake_pdf)

    monkeypatch.setattr(orch, "run_tailored_rescoring", lambda *a, **k: {
        "tailored_ats_scoring_result": {}, "tailored_match_score": 95, "ats_lift": 5,
        "injected_keywords": [], "failed_to_inject": [], "honest_gaps": [],
        "fabricated_keywords": [],
    })
    monkeypatch.setattr(orch, "run_tailored_structural_validation",
                         lambda *a, **k: {"summary": {"fail": 0, "warn": 0, "pass": 1}})

    async def _fake_auto_cover_letter(**k):
        calls["auto_cover_letter"].append(k)
    monkeypatch.setattr(orch, "auto_generate_cover_letter", _fake_auto_cover_letter)

    for name in ("mark_run_running", "mark_run_completed", "mark_step", "save_step_result"):
        monkeypatch.setattr(orch, name, _record_async(name, calls))

    async def _fake_mark_failed(run_id, error, step_status, failed_step=None):
        calls["mark_run_failed"].append((run_id, error))
    monkeypatch.setattr(orch, "mark_run_failed", _fake_mark_failed)

    monkeypatch.setattr(orch, "delete_storage_object",
                         lambda bucket, path: calls["delete_storage_object"].append((bucket, path)))


def _record_async(name, calls):
    async def _fn(*a, **k):
        calls[name].append((a, k))
    return _fn


def _new_calls():
    from collections import defaultdict
    return defaultdict(list)


def test_happy_path_no_cancellation_persists_and_completes(monkeypatch):
    """Sanity check: with no cancellation, both artifacts persist, the run
    completes, and auto-cover-letter fires (tailored score 95 >= gate 70)."""
    calls = _new_calls()
    _install_common_mocks(monkeypatch, calls)

    async def _always_active(run_id, column, value):
        calls["save_artifact_if_active"].append((run_id, column, value))
        return True
    monkeypatch.setattr(orch, "save_artifact_if_active", _always_active)

    _run(orch._run_analysis_pipeline_inner(_fake_payload()))

    persisted_columns = [c for (_rid, c, _v) in calls["save_artifact_if_active"]]
    assert persisted_columns == ["tailored_cv_storage_path", "tailored_pdf_storage_path"]
    assert len(calls["mark_run_completed"]) == 1
    assert len(calls["auto_cover_letter"]) == 1
    assert calls["delete_storage_object"] == []
    assert calls["mark_run_failed"] == []


def test_cancel_races_ahead_of_markdown_persist(monkeypatch):
    """Stop lands while the writer is still generating — the FIRST
    save_artifact_if_active call (markdown) returns False. The pipeline
    must: discard the artifact (delete the uploaded object), never reach
    the PDF render, never call mark_run_completed, never trigger the
    auto-cover-letter generation. This is the exact C3b exploit sequence."""
    calls = _new_calls()
    _install_common_mocks(monkeypatch, calls)

    async def _cancelled_at_markdown(run_id, column, value):
        calls["save_artifact_if_active"].append((run_id, column, value))
        return False  # already cancelled by the time we try to persist
    monkeypatch.setattr(orch, "save_artifact_if_active", _cancelled_at_markdown)

    _run(orch._run_analysis_pipeline_inner(_fake_payload()))

    # Exactly one save attempt (markdown) — PDF render never reached.
    assert len(calls["save_artifact_if_active"]) == 1
    assert calls["save_artifact_if_active"][0][1] == "tailored_cv_storage_path"

    # The already-uploaded markdown was deleted, not left orphaned+billed.
    assert calls["delete_storage_object"] == [("tailored-cvs", "user-1/run-1.md")]

    # Never reached completion or cover-letter generation — pipeline
    # actually stopped, it didn't just skip billing while finishing anyway.
    assert calls["mark_run_completed"] == []
    assert calls["auto_cover_letter"] == []
    # _CancelledByUser is caught silently (row is already 'failed' from the
    # Stop click itself) — must NOT be reported as a crash.
    assert calls["mark_run_failed"] == []


def test_cancel_races_ahead_of_pdf_persist(monkeypatch):
    """Markdown persists fine (run still active at that point), but Stop
    lands during the PDF render — the SECOND save_artifact_if_active call
    returns False. Must delete the PDF, stop, and — critically — the
    _CancelledByUser must escape the try/except around the PDF render that
    otherwise treats failures as non-fatal (a real bug-prone spot: without
    `except _CancelledByUser: raise`, this would have been silently
    swallowed as "PDF failed, continue with markdown-only", and the
    pipeline would have run to completion and billed anyway)."""
    calls = _new_calls()
    _install_common_mocks(monkeypatch, calls)

    responses = [True, False]  # markdown persists, PDF does not

    async def _cancelled_at_pdf(run_id, column, value):
        calls["save_artifact_if_active"].append((run_id, column, value))
        return responses.pop(0)
    monkeypatch.setattr(orch, "save_artifact_if_active", _cancelled_at_pdf)

    _run(orch._run_analysis_pipeline_inner(_fake_payload()))

    assert [c for (_r, c, _v) in calls["save_artifact_if_active"]] == [
        "tailored_cv_storage_path", "tailored_pdf_storage_path",
    ]
    assert calls["delete_storage_object"] == [("tailored-cvs", "user-1/run-1.pdf")]
    assert calls["mark_run_completed"] == []
    assert calls["auto_cover_letter"] == []
    assert calls["mark_run_failed"] == []
