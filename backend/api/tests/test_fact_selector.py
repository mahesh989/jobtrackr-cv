"""C67: RecentEvent.stale is injected by researcher.py (event date >12
months old, or no parseable date at all) specifically so a stale event
doesn't get featured as a "recent" company fact in a cover letter. Before
this fix, fact_selector.py's _expand_facts never read the flag — a stale
event was scored and selectable exactly like a genuinely recent one.
"""
from __future__ import annotations

from app.schemas.company import CompanyFacts, RecentEvent
from app.services.company.fact_selector import select_facts


def _facts(**overrides) -> CompanyFacts:
    base = dict(
        description_short="A care provider.",
        industry="Aged Care",
        size="mid",
        headquarters="Sydney, Australia",
    )
    base.update(overrides)
    return CompanyFacts(**base)


def test_stale_event_is_excluded_from_selectable_facts():
    facts = _facts(
        recent_events=[
            RecentEvent(
                date="2020-01-01", event="Won regional care excellence award",
                relevance_to_applicants="Reflects strong care culture applicants can expect.",
                stale=True,
            ),
        ],
    )
    scored = select_facts("aged care assistant in nursing role", "", facts)
    source_fields = [s["source_field"] for s in scored]
    assert "recent_events[0]" not in source_fields, "a stale event must never be a selectable fact"


def test_non_stale_event_remains_selectable():
    facts = _facts(
        recent_events=[
            RecentEvent(
                date="2026-06-01", event="Opened new nursing home wing",
                relevance_to_applicants="More nursing roles becoming available.",
                stale=False,
            ),
        ],
    )
    scored = select_facts("nursing home wing opening", "", facts)
    source_fields = [s["source_field"] for s in scored]
    assert "recent_events[0]" in source_fields


def test_stale_and_fresh_events_mixed_only_fresh_survives():
    facts = _facts(
        recent_events=[
            RecentEvent(
                date="2019-01-01", event="Old merger announcement",
                relevance_to_applicants="Historical context only.",
                stale=True,
            ),
            RecentEvent(
                date="2026-05-01", event="Expanded nursing home network",
                relevance_to_applicants="More nursing roles becoming available.",
                stale=False,
            ),
        ],
    )
    scored = select_facts("nursing home network expansion", "", facts)
    source_fields = [s["source_field"] for s in scored]
    assert "recent_events[0]" not in source_fields
    assert "recent_events[1]" in source_fields
