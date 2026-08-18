"""C67: the reserve → link/release billing lifecycle in auto_cover_letter.py
had zero coverage. reserve_cover_letter() puts a PENDING usage_event on the
meter before any DB row exists; the contract is that it must ALWAYS be
resolved — link_letter_usage_event() on a successful INSERT (so the
cover_letters status trigger can commit/void it later), or
release_letter_usage_event() immediately if the INSERT never happens. A gap
here either double-counts a failed attempt against the user's cap (never
released) or lets a completed letter's usage go uncommitted (never linked).

These test the orchestration in auto_generate_cover_letter() directly — real
reserve_cover_letter() cap-math is already covered by
test_auto_cover_letter_billing.py.
"""
from __future__ import annotations

import asyncio

import pytest
from postgrest.exceptions import APIError

import app.services.automation.auto_cover_letter as acl
from app.services.automation.billing import LetterReservation


# ── Fake Supabase client — dispatches by (table, verb) ─────────────────────

class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table_name, harness):
        self._table = table_name
        self._harness = harness
        self._verb = None
        self._payload = None

    def select(self, *a, **k):
        self._verb = "select"
        return self

    def insert(self, payload, *a, **k):
        self._verb = "insert"
        self._payload = payload
        return self

    def update(self, payload=None, *a, **k):
        self._verb = "update"
        self._payload = payload
        return self

    def eq(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def single(self):
        self._single = True
        return self

    def execute(self):
        return self._harness._execute(self._table, self._verb, self._payload)


class _FakeSupabase:
    """`selects` maps table name -> canned .data for a select/single call.
    `insert_error` is (table_name, exception) — raised on insert to that
    table, simulating an INSERT failure after a successful reservation."""

    def __init__(self, selects: dict, insert_error=None):
        self.selects = selects
        self.insert_error = insert_error
        self.insert_calls: list = []
        self.update_calls: list = []

    def table(self, name):
        return _Query(name, self)

    def _execute(self, table, verb, payload):
        if verb == "insert":
            self.insert_calls.append((table, payload))
            if self.insert_error and self.insert_error[0] == table:
                raise self.insert_error[1]
            return _Result(payload)
        if verb == "update":
            self.update_calls.append(table)
            return _Result([{}])
        return _Result(self.selects.get(table, []))


def _base_selects(existing_letters=None):
    return {
        acl._ANALYSIS_RUNS: {"job_id": "job-1"},
        acl._COVER_LETTERS: existing_letters if existing_letters is not None else [],
        "voice_profiles": [{"fingerprint": "fp", "voice_sample_raw": "sample text"}],
        "stories": [],
        "company_research_facts": [],
    }


@pytest.fixture(autouse=True)
def _no_real_pipeline(monkeypatch):
    """Step 7 fires the actual 3-pass AI generation as a detached
    asyncio.create_task — never awaited by the function under test. Stub it
    so the background task is a fast no-op instead of hitting real AI/DB."""
    async def _noop_pipeline(payload):
        return None
    monkeypatch.setattr(acl, "run_cover_letter_pipeline", _noop_pipeline)


async def _drain_background_tasks():
    """Let any asyncio.create_task() the function scheduled actually run to
    completion, so pending-task warnings don't leak between tests."""
    tasks = [t for t in acl._PENDING_TASKS]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


class TestReserveLinkReleaseLifecycle:
    @pytest.mark.asyncio
    async def test_insert_success_links_the_reservation(self, monkeypatch):
        fake = _FakeSupabase(_base_selects())
        monkeypatch.setattr(acl, "get_supabase", lambda: fake)

        reserve_calls = []
        link_calls = []
        release_calls = []

        async def _reserve(user_id, job_id):
            reserve_calls.append((user_id, job_id))
            return LetterReservation(allowed=True, reason=None, event_id="evt-1")

        async def _link(event_id, letter_id):
            link_calls.append((event_id, letter_id))

        async def _release(event_id):
            release_calls.append(event_id)

        monkeypatch.setattr(acl, "reserve_cover_letter", _reserve)
        monkeypatch.setattr(acl, "link_letter_usage_event", _link)
        monkeypatch.setattr(acl, "release_letter_usage_event", _release)

        await acl.auto_generate_cover_letter(
            run_id="run-1", user_id="user-1", jd_text="jd", job_title="Nurse",
            company_name="Acme", cv_text="cv", ai_provider="anthropic",
            ai_api_key="key", ai_model=None,
        )
        await _drain_background_tasks()

        assert reserve_calls == [("user-1", "job-1")]
        assert len(link_calls) == 1
        assert link_calls[0][0] == "evt-1"
        assert release_calls == [], "a successful insert must never release its own reservation"
        insert_tables = [t for t, _ in fake.insert_calls]
        assert acl._COVER_LETTERS in insert_tables

    @pytest.mark.asyncio
    async def test_insert_failure_releases_the_reservation(self, monkeypatch):
        insert_error = (acl._COVER_LETTERS, APIError({"message": "boom", "code": "23505"}))
        fake = _FakeSupabase(_base_selects(), insert_error=insert_error)
        monkeypatch.setattr(acl, "get_supabase", lambda: fake)

        link_calls = []
        release_calls = []

        async def _reserve(user_id, job_id):
            return LetterReservation(allowed=True, reason=None, event_id="evt-2")

        async def _link(event_id, letter_id):
            link_calls.append((event_id, letter_id))

        async def _release(event_id):
            release_calls.append(event_id)

        monkeypatch.setattr(acl, "reserve_cover_letter", _reserve)
        monkeypatch.setattr(acl, "link_letter_usage_event", _link)
        monkeypatch.setattr(acl, "release_letter_usage_event", _release)

        await acl.auto_generate_cover_letter(
            run_id="run-2", user_id="user-1", jd_text="jd", job_title="Nurse",
            company_name="Acme", cv_text="cv", ai_provider="anthropic",
            ai_api_key="key", ai_model=None,
        )
        await _drain_background_tasks()

        assert release_calls == ["evt-2"], (
            "a reservation must be released when the letter row never comes into "
            "existence, or it dangles until the 1h pending self-heal"
        )
        assert link_calls == [], "a failed insert must never link a reservation to a non-existent row"

    @pytest.mark.asyncio
    async def test_reservation_denied_never_inserts_or_releases(self, monkeypatch):
        """event_id is None when the billing gate denies — there is nothing
        to release, and no letter row should be created at all."""
        fake = _FakeSupabase(_base_selects())
        monkeypatch.setattr(acl, "get_supabase", lambda: fake)

        release_calls = []

        async def _reserve(user_id, job_id):
            return LetterReservation(allowed=False, reason="over_cap", event_id=None)

        async def _release(event_id):
            release_calls.append(event_id)

        monkeypatch.setattr(acl, "reserve_cover_letter", _reserve)
        monkeypatch.setattr(acl, "release_letter_usage_event", _release)

        await acl.auto_generate_cover_letter(
            run_id="run-3", user_id="user-1", jd_text="jd", job_title="Nurse",
            company_name="Acme", cv_text="cv", ai_provider="anthropic",
            ai_api_key="key", ai_model=None,
        )
        await _drain_background_tasks()

        assert release_calls == []
        assert fake.insert_calls == []

    @pytest.mark.asyncio
    async def test_bypassed_meter_event_id_none_skips_link(self, monkeypatch):
        """Unlimited/admin users reserve with event_id=None — the insert
        still happens, but there's nothing to link since nothing was metered."""
        fake = _FakeSupabase(_base_selects())
        monkeypatch.setattr(acl, "get_supabase", lambda: fake)

        link_calls = []

        async def _reserve(user_id, job_id):
            return LetterReservation(allowed=True, reason=None, event_id=None)

        async def _link(event_id, letter_id):
            link_calls.append((event_id, letter_id))

        monkeypatch.setattr(acl, "reserve_cover_letter", _reserve)
        monkeypatch.setattr(acl, "link_letter_usage_event", _link)

        await acl.auto_generate_cover_letter(
            run_id="run-4", user_id="user-1", jd_text="jd", job_title="Nurse",
            company_name="Acme", cv_text="cv", ai_provider="anthropic",
            ai_api_key="key", ai_model=None,
        )
        await _drain_background_tasks()

        assert link_calls == []
        insert_tables = [t for t, _ in fake.insert_calls]
        assert acl._COVER_LETTERS in insert_tables
