"""save_artifact_if_active — the conditional-write guard for finding C3b.

Regression cover for: a user's Stop click (cancelAnalysisRun) sets
analysis_runs.status='failed' via the service-role client at any point
while the tailored-CV writer is still generating/uploading the artifact.
Without this guard, the writer's later, unconditional save would still
record the artifact's storage path on a row whose paid reservation was
already voided by the trigger — leaving a "refunded" CV downloadable.

The guard is a single conditional UPDATE (`status <> 'failed'`), so the
check-and-write is atomic at the database level: there is no separate
read-then-write window for a concurrent cancel to land in between.
"""
import asyncio

import app.services.pipeline.progress as progress


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


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Fluent chain matching table().update().eq().neq().execute().

    `matches` simulates whether the WHERE clause (id + status<>'failed')
    would match a row in a real Postgres UPDATE — the fake's caller decides
    this per-scenario, mirroring how a real conditional UPDATE either
    returns the updated row (representation) or an empty list (no match).
    """

    def __init__(self, matches: bool, row: dict):
        self._matches = matches
        self._row = row

    def update(self, *a, **k):  return self
    def eq(self, *a, **k):      return self
    def neq(self, *a, **k):     return self
    def execute(self):          return _Result([self._row] if self._matches else [])


class _FakeClient:
    def __init__(self, matches: bool, row: dict | None = None):
        self._matches = matches
        self._row = row or {"id": "run-1"}
        self.table_calls = []

    def table(self, name):
        self.table_calls.append(name)
        return _Query(self._matches, self._row)


def _patch(monkeypatch, client):
    monkeypatch.setattr(progress, "get_supabase", lambda: client)
    return client


def test_active_run_persists_artifact(monkeypatch):
    """Run still active (status not 'failed') — the write takes effect."""
    client = _patch(monkeypatch, _FakeClient(matches=True))
    result = _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
    assert result is True
    assert client.table_calls == ["analysis_runs"]


def test_already_cancelled_run_does_not_persist(monkeypatch):
    """Run already status='failed' at the moment of the write — the
    conditional UPDATE matches 0 rows, proving the artifact was NOT
    recorded on an already-cancelled/voided run. This is the exact
    scenario from the C3b exploit: cancel races ahead of the writer."""
    client = _patch(monkeypatch, _FakeClient(matches=False))
    result = _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
    assert result is False
    assert client.table_calls == ["analysis_runs"]


def test_db_error_fails_closed(monkeypatch):
    """A network/DB error must be treated as 'not persisted', not as
    success — same fail-closed principle as the billing meter elsewhere in
    this codebase (test_auto_cover_letter_billing.py): on uncertainty,
    never leave a possibly-unbilled artifact reachable."""
    class _BoomClient:
        def table(self, name):
            raise ConnectionError("db unreachable")

    _patch(monkeypatch, _BoomClient())
    result = _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
    assert result is False
