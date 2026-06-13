"""
Deterministic research quality scorer — Phase 10.3.

Computes research_quality_score (float 0.0–1.0) from three observable
signals without making any AI calls. Called by researcher.py before
writing the CompanyResearch row to Supabase.

Score formula:
  source_contrib   = min(sources_found / 5, 1.0) * 0.40
  sample_contrib   = min(len(sample_text) / 400, 1.0) * 0.30
  recency_contrib  = (events_within_6_months / max(total_events, 1)) * 0.30

Total = source_contrib + sample_contrib + recency_contrib  (capped at 1.0)

Calibration note (OPS-TODO): weights were chosen at design time. Evaluate
against real data once 20+ company_research rows exist; tune if needed.
"""
from __future__ import annotations

from datetime import datetime, timezone


def compute_quality_score(
    sources_found: int,
    sample_text: str,
    recent_events: list[dict],
) -> float:
    """
    Parameters
    ----------
    sources_found : int
        Number of Tavily search results returned (0 if search was skipped).
    sample_text : str
        The voice_signals.sample_text scraped from the company's site.
    recent_events : list[dict]
        Raw list of recent_event dicts from the model response.
        Each may have a 'date' key (ISO string, optional).

    Returns
    -------
    float in [0.0, 1.0]
    """
    source_contrib = min(sources_found / 5, 1.0) * 0.40
    sample_contrib = min(len(sample_text) / 400, 1.0) * 0.30

    recency_contrib = 0.0
    if recent_events:
        now = datetime.now(timezone.utc)
        within_6_months = 0
        for evt in recent_events:
            date_str = evt.get("date") or ""
            if date_str:
                try:
                    # Accept YYYY-MM-DD or YYYY-MM or YYYY
                    parts = date_str.split("-")
                    year = int(parts[0])
                    month = int(parts[1]) if len(parts) > 1 else 1
                    day = int(parts[2]) if len(parts) > 2 else 1
                    evt_dt = datetime(year, month, day, tzinfo=timezone.utc)
                    months_ago = (now - evt_dt).days / 30.0
                    if months_ago <= 6:
                        within_6_months += 1
                except (ValueError, IndexError):
                    pass
        recency_contrib = (within_6_months / len(recent_events)) * 0.30

    return round(min(source_contrib + sample_contrib + recency_contrib, 1.0), 4)
