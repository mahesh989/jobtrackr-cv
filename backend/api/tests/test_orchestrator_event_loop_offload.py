"""C67: orchestrator.py called 4 synchronous, CPU-bound deterministic
scorers/validators (run_ats_scoring, run_input_recommendations,
run_tailored_rescoring, run_tailored_structural_validation) directly on
the event loop instead of via asyncio.to_thread — each call blocked every
other concurrent pipeline run and API request this process was serving
for its full duration. Pins the wiring via source inspection (a real
concurrency regression is hard to assert reliably in a unit test; this at
least locks in that a future edit can't silently drop the offload).
"""
from __future__ import annotations

import inspect

import app.services.pipeline.orchestrator as orch


def test_ats_scoring_is_offloaded_to_a_thread():
    src = inspect.getsource(orch)
    assert "await asyncio.to_thread(run_ats_scoring," in src


def test_input_recommendations_is_offloaded_to_a_thread():
    src = inspect.getsource(orch)
    assert "run_input_recommendations, payload.cv_text" in src
    idx = src.index("run_input_recommendations, payload.cv_text")
    assert "asyncio.to_thread(" in src[max(0, idx - 40):idx]


def test_tailored_rescoring_is_offloaded_to_a_thread():
    src = inspect.getsource(orch)
    assert "run_tailored_rescoring, tailored_md" in src
    idx = src.index("run_tailored_rescoring, tailored_md")
    assert "asyncio.to_thread(" in src[max(0, idx - 40):idx]


def test_structural_validation_is_offloaded_to_a_thread():
    src = inspect.getsource(orch)
    assert "run_tailored_structural_validation, tailored_md" in src
    idx = src.index("run_tailored_structural_validation, tailored_md")
    assert "asyncio.to_thread(" in src[max(0, idx - 40):idx]
