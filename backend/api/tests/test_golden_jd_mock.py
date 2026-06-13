"""Phase 4 — golden-JD regression test (mock mode).

Runs every JD in ``tests/golden/jds/`` through the deterministic
post-process chain using its recorded LLM-output fixture and asserts:

  • per-JD precision and recall meet a hard threshold;
  • aggregate precision/recall meet a higher threshold;
  • there are NO hallucinations on a re-run (post-process is deterministic
    over a frozen fixture — anything that surfaces must have been added
    to the lexicon or to a recogniser).

When this test fails, it's because either:
  (a) the lexicon / chain changed and a recorded JD now produces a
      different canonical set → update the expected list in the JD's
      frontmatter (it's a snapshot of the contract);
  (b) the fixture is stale relative to a prompt change → re-record the
      fixture from a live run (out of scope for this test); or
  (c) a real regression — something started silently dropping/hallucinating.

The CLI ``scripts/golden_jd_eval.py`` runs the same evaluation with
``--mock`` (same data) or ``--live`` (real AI). Use the CLI when adding
JDs or re-recording fixtures.
"""
from __future__ import annotations

import pytest

from tests.golden.harness import evaluate_all_mock, load_corpus


# Pinned thresholds — keep these tight to act as a regression alarm.
#
# Precision must be perfect on the recorded set: every actual canonical
# is either covered by the expected list OR has been deliberately added
# (in which case update the expected list).
#
# Recall is also tight because the fixtures are hand-tuned to elicit a
# specific shape; if recall drops, either the recall floor or the
# subsumption rule has changed semantics.
PER_JD_PRECISION_FLOOR = 1.00
PER_JD_RECALL_FLOOR = 1.00
AGGREGATE_PRECISION_FLOOR = 1.00
AGGREGATE_RECALL_FLOOR = 1.00


def _collect_results():
    """Compute results once per test session — keeps the suite fast."""
    if not hasattr(_collect_results, "_cache"):
        _collect_results._cache = evaluate_all_mock()  # type: ignore[attr-defined]
    return _collect_results._cache  # type: ignore[attr-defined]


class TestGoldenCorpusShape:
    def test_corpus_is_non_empty(self):
        jds = load_corpus()
        assert len(jds) >= 4, "corpus must cover at least 4 JDs across verticals"

    def test_every_jd_has_required_metadata(self):
        for jd in load_corpus():
            assert jd.id, "JD missing id"
            assert jd.vertical in {"nursing", "tech", "cleaning"}, jd.vertical
            assert jd.role_family in {"nursing", "tech", "manual", "master"}, jd.role_family
            assert jd.body.strip(), f"JD {jd.id} has empty body"

    def test_every_jd_has_a_fixture(self):
        from tests.golden.harness import FIXTURES_DIR
        for jd in load_corpus():
            assert (FIXTURES_DIR / f"{jd.id}.json").exists(), (
                f"missing fixture for {jd.id}"
            )

    def test_verticals_represented(self):
        verticals = {jd.vertical for jd in load_corpus()}
        # At least nursing + tech + cleaning should be present — the
        # whole point is cross-vertical coverage.
        assert {"nursing", "tech", "cleaning"} <= verticals


class TestGoldenPerJd:
    @pytest.mark.parametrize("result_idx", range(len(_collect_results())))
    def test_per_jd_precision_meets_floor(self, result_idx):
        r = _collect_results()[result_idx]
        assert r.precision >= PER_JD_PRECISION_FLOOR, (
            f"{r.jd_id}: precision={r.precision:.2f} < {PER_JD_PRECISION_FLOOR:.2f}; "
            f"hallucinations={r.hallucinations}"
        )

    @pytest.mark.parametrize("result_idx", range(len(_collect_results())))
    def test_per_jd_recall_meets_floor(self, result_idx):
        r = _collect_results()[result_idx]
        assert r.recall >= PER_JD_RECALL_FLOOR, (
            f"{r.jd_id}: recall={r.recall:.2f} < {PER_JD_RECALL_FLOOR:.2f}; "
            f"missed={r.missed}"
        )

    @pytest.mark.parametrize("result_idx", range(len(_collect_results())))
    def test_per_jd_zero_hallucinations(self, result_idx):
        """Hard zero — the recorded LLM output is frozen, so any
        hallucination must come from a chain regression."""
        r = _collect_results()[result_idx]
        assert not r.hallucinations, (
            f"{r.jd_id}: hallucinations={r.hallucinations}"
        )


class TestGoldenAggregate:
    def test_aggregate_precision(self):
        results = _collect_results()
        macro_p = sum(r.precision for r in results) / len(results)
        assert macro_p >= AGGREGATE_PRECISION_FLOOR, (
            f"aggregate precision {macro_p:.2f} < {AGGREGATE_PRECISION_FLOOR:.2f}"
        )

    def test_aggregate_recall(self):
        results = _collect_results()
        macro_r = sum(r.recall for r in results) / len(results)
        assert macro_r >= AGGREGATE_RECALL_FLOOR, (
            f"aggregate recall {macro_r:.2f} < {AGGREGATE_RECALL_FLOOR:.2f}"
        )

    def test_aggregate_zero_hallucinations(self):
        """The Phase 4 acceptance criterion from
        PHASE_2_PLUS_STATUS.md: 0 hallucinations across the corpus."""
        results = _collect_results()
        total = sum(len(r.hallucinations) for r in results)
        assert total == 0, (
            f"corpus has {total} hallucinations across {len(results)} JDs"
        )
