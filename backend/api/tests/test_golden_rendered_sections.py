"""Golden rendered-CV regression tests.

Asserts the deterministic post-processing chain (everything after the LLM
call in run_tailored_cv) produces byte-identical per-section output to the
committed snapshots.

Phase A gate (jd-analysis-fix-plan.md):
  - Professional Summary / Career Highlights: MUST remain unchanged unless
    the active phase explicitly declares a summary diff.
  - Skills section: may change in Phases C/D/E per declared diffs.
  - All other sections: must remain unchanged by default.

To update snapshots after an intentional change:
  cd backend/api
  python tests/golden/rendered_harness.py --record
"""
from __future__ import annotations

import pytest

from tests.golden.rendered_harness import CORPUS_IDS, DiffResult, evaluate, load_snapshot


def _is_summary_section(name: str) -> bool:
    lc = name.lower()
    return "highlight" in lc or "summary" in lc


# ---------------------------------------------------------------------------
# Compute results once per session
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def session_results() -> dict[str, DiffResult]:
    return {jd_id: evaluate(jd_id) for jd_id in CORPUS_IDS}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("jd_id", CORPUS_IDS)
class TestRenderedSections:
    def test_snapshot_exists(self, jd_id: str, session_results: dict) -> None:
        snap = load_snapshot(jd_id)
        assert snap is not None, (
            f"No snapshot for {jd_id}. Run:\n"
            f"  cd backend/api && python tests/golden/rendered_harness.py --record"
        )

    def test_professional_summary_unchanged(self, jd_id: str, session_results: dict) -> None:
        """HARD gate: Professional Summary / Career Highlights must not change
        unless the active fix phase explicitly declares a summary diff."""
        result = session_results[jd_id]
        if result.is_new:
            pytest.skip(f"{jd_id}: new snapshot just recorded — re-run to assert")
        summary_changes = [
            (sec, old, new)
            for sec, old, new in result.changed
            if _is_summary_section(sec)
        ]
        assert not summary_changes, (
            f"{jd_id}: Professional Summary changed unexpectedly.\n"
            + "\n".join(
                f"  [{sec}]\n  WAS: {old[:300]!r}\n  NOW: {new[:300]!r}"
                for sec, old, new in summary_changes
            )
        )

    def test_no_section_changed(self, jd_id: str, session_results: dict) -> None:
        """Full-snapshot gate: no section should change from the committed
        snapshot. Phases that intentionally change a section must update
        the snapshot and document the expected diff in the phase notes."""
        result = session_results[jd_id]
        if result.is_new:
            pytest.skip(f"{jd_id}: new snapshot just recorded — re-run to assert")
        assert not result.changed, (
            f"{jd_id}: {len(result.changed)} section(s) changed unexpectedly:\n"
            + "\n".join(
                f"  [{sec}]\n  WAS: {old[:200]!r}\n  NOW: {new[:200]!r}"
                for sec, old, new in result.changed
            )
        )


class TestMissingSnapshotDoesNotSilentlyRecord:
    """C67: evaluate()'s default path (record=False, what the pytest suite
    always uses via session_results) previously auto-wrote a new snapshot
    to disk the moment it found none — so a snapshot that went missing
    (accidental deletion, a bad merge, a new corpus id added without
    running --record) would silently self-heal on the very next test run,
    writing whatever the current (possibly broken) output was as the new
    ground truth, with zero human review. Fixed: only the explicit
    --record CLI path (record=True) writes."""

    def test_missing_snapshot_is_not_written_by_default(self, tmp_path, monkeypatch):
        import tests.golden.rendered_harness as rh

        monkeypatch.setattr(rh, "SNAPSHOTS_DIR", tmp_path / "snapshots")
        jd_id = rh.CORPUS_IDS[0]

        result = rh.evaluate(jd_id)  # record defaults to False

        assert result.is_new is True
        assert not (tmp_path / "snapshots" / f"{jd_id}.json").exists(), (
            "evaluate() must not write a snapshot when record=False"
        )

    def test_missing_snapshot_is_written_only_with_explicit_record(self, tmp_path, monkeypatch):
        import tests.golden.rendered_harness as rh

        monkeypatch.setattr(rh, "SNAPSHOTS_DIR", tmp_path / "snapshots")
        jd_id = rh.CORPUS_IDS[0]

        result = rh.evaluate(jd_id, record=True)

        assert result.is_new is True
        assert (tmp_path / "snapshots" / f"{jd_id}.json").exists()
