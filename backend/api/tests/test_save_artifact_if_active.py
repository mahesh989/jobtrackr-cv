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

The fake client records every filter call's exact args, not just that
`.eq()`/`.neq()` were called — an earlier version of this file's fake
discarded the args entirely, which meant a mutation that gutted the WHERE
clause (e.g. an UPDATE with no status guard at all, stamping the artifact
onto every row in the table) still passed every test here. Confirmed via
mutation testing on review; asserting on the recorded filters is what
actually pins the security property.
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
    Every call's args are recorded on `client.filter_calls` and
    `client.update_calls` so a test can assert the guard is actually wired
    up, not just that SOME update happened.
    """

    def __init__(self, client, matches: bool, row: dict):
        self._client = client
        self._matches = matches
        self._row = row

    def update(self, patch, *a, **k):
        self._client.update_calls.append(patch)
        return self

    def eq(self, field, value, *a, **k):
        self._client.filter_calls.append(("eq", field, value))
        return self

    def neq(self, field, value, *a, **k):
        self._client.filter_calls.append(("neq", field, value))
        return self

    def execute(self):
        return _Result([self._row] if self._matches else [])


class _FakeClient:
    def __init__(self, matches: bool, row: dict | None = None):
        self._matches = matches
        self._row = row or {"id": "run-1"}
        self.table_calls = []
        self.update_calls = []
        self.filter_calls = []

    def table(self, name):
        self.table_calls.append(name)
        return _Query(self, self._matches, self._row)


def _patch(monkeypatch, client):
    monkeypatch.setattr(progress, "get_supabase", lambda: client)
    return client


def test_active_run_persists_artifact(monkeypatch):
    """Run still active (status not 'failed') — the write takes effect,
    AND the WHERE clause carries both the row-id and the status guard
    (not just any UPDATE that happens to succeed)."""
    client = _patch(monkeypatch, _FakeClient(matches=True))
    result = _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
    assert result is True
    assert client.table_calls == ["analysis_runs"]
    assert client.update_calls == [{"tailored_cv_storage_path": "u1/run-1.md"}]
    assert ("eq", "id", "run-1") in client.filter_calls
    assert ("neq", "status", "failed") in client.filter_calls


def test_already_cancelled_run_does_not_persist(monkeypatch):
    """Run already status='failed' at the moment of the write — the
    conditional UPDATE matches 0 rows, proving the artifact was NOT
    recorded on an already-cancelled/voided run. This is the exact
    scenario from the C3b exploit: cancel races ahead of the writer."""
    client = _patch(monkeypatch, _FakeClient(matches=False))
    result = _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
    assert result is False
    assert client.table_calls == ["analysis_runs"]
    assert ("neq", "status", "failed") in client.filter_calls


def test_db_error_propagates(monkeypatch):
    """A network/DB error must propagate, not be swallowed into a False
    return. save_artifact_if_active used to fail-closed on any exception,
    which the orchestrator's caller treats identically to a genuine
    cancellation (silent no-op — no mark_run_failed, since the row is
    assumed already terminal). For a real infra error that assumption is
    wrong: the run was left stuck at status='running' forever on nothing
    worse than a transient blip, with its just-generated artifact already
    deleted. The caller's normal exception handling (mark_run_failed) is
    the correct response to an error — this function must let it through."""
    class _BoomClient:
        def table(self, name):
            raise ConnectionError("db unreachable")

    _patch(monkeypatch, _BoomClient())
    try:
        _run(progress.save_artifact_if_active("run-1", "tailored_cv_storage_path", "u1/run-1.md"))
        raised = False
    except ConnectionError:
        raised = True
    assert raised, "a DB error must propagate as an exception, not return False"
