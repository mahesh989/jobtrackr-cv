"""
Parity guard (audit, execution chunk C41d): see the sibling test in
frontend/web/src/lib/billing/plans.test.ts for the full rationale — plan
limits are hand-maintained in 4 places (DB seed, web plans.ts, worker
billing.ts, this file's target `_PLAN_LETTER_LIMITS`), each with a "keep in
sync" comment but no automated cross-check before this chunk.

GROUND_TRUTH's letter-dimension values must be updated by hand whenever
shared/supabase/migrations/003_seed.sql's plan values change.
"""
import pytest

from app.services.automation.billing import _PLAN_LETTER_LIMITS

GROUND_TRUTH = {
    "trial":     {"unique": 3,    "total": 3},
    "weekly":    {"unique": 50,   "total": 75},
    "monthly":   {"unique": 250,  "total": 375},
    "unlimited": {"unique": None, "total": None},
    "comp":      {"unique": None, "total": None},
}


@pytest.mark.parametrize("plan_id", sorted(GROUND_TRUTH))
def test_plan_letter_limits_matches_the_db_seed(plan_id):
    assert _PLAN_LETTER_LIMITS[plan_id] == GROUND_TRUTH[plan_id]


def test_covers_every_plan_id_the_seed_defines_no_plan_silently_unchecked():
    assert sorted(_PLAN_LETTER_LIMITS) == sorted(GROUND_TRUTH)
