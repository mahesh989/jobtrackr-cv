"""Coverage gap (audit, execution chunk C42d): tailored_structural_validation/
gates_experience.py — 5 gates on Experience/Project role counts, bullet
counts, bullet length, terminal punctuation and metric coverage — had zero
test coverage. Part of C42's 6-way split (see C42a/#197, C42b/#198,
C42c/#201 for the earlier chunks and the full split rationale).

All gates here are advisory (warn/pass/fail feed the admin quality
dashboard and TailoredScoreCard only — never block CV delivery).
metric_coverage in particular is documented as NEVER returning "fail" by
design, to avoid pressuring the writer to fabricate numbers; that
constraint is asserted directly below, not just assumed.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation.gates_experience import (
    _gate_bullets_per_entry,
    _gate_experience_bullet_length,
    _gate_experience_role_count,
    _gate_metric_coverage,
    _gate_period_terminator,
)


def _entry(title: str, bullets: list[str]) -> str:
    lines = [f"### {title}"] + [f"- {b}" for b in bullets]
    return "\n".join(lines) + "\n"


def _words(n: int, suffix: str = "") -> str:
    return " ".join(["word"] * n) + suffix


# ---------------------------------------------------------------------------
# _gate_experience_role_count
# ---------------------------------------------------------------------------


class TestGateExperienceRoleCount:
    def test_no_experience_section_fails(self):
        result = _gate_experience_role_count({})
        assert result["status"] == "fail"
        assert "No experience entries detected" in result["detail"]

    def test_one_to_three_roles_passes(self):
        body = _entry("Role A", ["Did a thing."]) + _entry("Role B", ["Did another."])
        result = _gate_experience_role_count({"experience": body})
        assert result["status"] == "pass"
        assert "2 experience role" in result["detail"]

    def test_boundary_exactly_three_roles_passes(self):
        body = "".join(_entry(f"Role {i}", ["Did it."]) for i in range(3))
        result = _gate_experience_role_count({"experience": body})
        assert result["status"] == "pass"

    def test_boundary_four_roles_warns(self):
        body = "".join(_entry(f"Role {i}", ["Did it."]) for i in range(4))
        result = _gate_experience_role_count({"experience": body})
        assert result["status"] == "warn"
        assert "target 1-3" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_bullets_per_entry
# ---------------------------------------------------------------------------


class TestGateBulletsPerEntry:
    def test_no_entries_anywhere_warns(self):
        result = _gate_bullets_per_entry({})
        assert result["status"] == "warn"
        assert "No experience or project entries found" in result["detail"]

    def test_all_entries_with_two_to_three_bullets_passes(self):
        body = _entry("Role A", ["One.", "Two."]) + _entry("Role B", ["One.", "Two.", "Three."])
        result = _gate_bullets_per_entry({"experience": body})
        assert result["status"] == "pass"
        assert "All 2 entry/entries" in result["detail"]

    def test_entry_with_only_one_bullet_fails(self):
        body = _entry("Role A", ["Only one bullet."])
        result = _gate_bullets_per_entry({"experience": body})
        assert result["status"] == "fail"
        assert "Role A" in result["detail"]
        assert "1 bullet(s)" in result["detail"]

    def test_entry_with_four_bullets_fails(self):
        body = _entry("Role A", ["One.", "Two.", "Three.", "Four."])
        result = _gate_bullets_per_entry({"experience": body})
        assert result["status"] == "fail"
        assert "4 bullet(s)" in result["detail"]

    def test_projects_section_entries_count_alongside_experience(self):
        experience = _entry("Role A", ["One.", "Two."])
        projects = _entry("Side Project", ["Only one."])
        result = _gate_bullets_per_entry({"experience": experience, "projects": projects})
        assert result["status"] == "fail"
        assert "Side Project" in result["detail"]

    def test_more_than_three_issues_are_truncated_with_a_count(self):
        body = "".join(_entry(f"Role {i}", ["Only one."]) for i in range(5))
        result = _gate_bullets_per_entry({"experience": body})
        assert result["status"] == "fail"
        assert "(+2 more)" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_experience_bullet_length
# ---------------------------------------------------------------------------


class TestGateExperienceBulletLength:
    def test_no_bullets_warns(self):
        result = _gate_experience_bullet_length({})
        assert result["status"] == "warn"
        assert "No Experience/Project bullets to check" in result["detail"]

    def test_short_bullet_still_passes_gate_only_enforces_an_upper_bound(self):
        # Docstring says "target 18-30 words" but the code never checks a
        # floor — only >30 warns and >40 fails. Pinning current behaviour.
        body = _entry("Role A", [_words(5) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "pass"

    def test_boundary_exactly_30_words_passes(self):
        body = _entry("Role A", [_words(30) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "pass"

    def test_boundary_31_words_warns(self):
        body = _entry("Role A", [_words(31) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "warn"

    def test_boundary_exactly_40_words_still_warns_not_fails(self):
        body = _entry("Role A", [_words(40) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "warn"

    def test_boundary_41_words_fails(self):
        body = _entry("Role A", [_words(41) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "fail"

    def test_a_single_failing_bullet_reports_fail_even_with_other_warn_bullets(self):
        body = _entry("Role A", [_words(31) + ".", _words(41) + "."])
        result = _gate_experience_bullet_length({"experience": body})
        assert result["status"] == "fail"


# ---------------------------------------------------------------------------
# _gate_period_terminator
# ---------------------------------------------------------------------------


class TestGatePeriodTerminator:
    def test_no_bullets_warns(self):
        result = _gate_period_terminator({})
        assert result["status"] == "warn"
        assert "No bullets to check" in result["detail"]

    def test_all_bullets_terminated_passes(self):
        body = _entry("Role A", ["Did a thing.", "Did another!", "Did a third?"])
        result = _gate_period_terminator({"experience": body})
        assert result["status"] == "pass"

    def test_trailing_markdown_characters_are_stripped_before_checking(self):
        body = _entry("Role A", ["Did a thing.**", "Did another.`"])
        result = _gate_period_terminator({"experience": body})
        assert result["status"] == "pass"

    def test_boundary_exactly_20_percent_missing_warns_not_fails(self):
        bullets = ["Terminated." for _ in range(4)] + ["Not terminated"]
        body = _entry("Role A", bullets)
        result = _gate_period_terminator({"experience": body})
        assert result["status"] == "warn"
        assert "1 of 5" in result["detail"]

    def test_over_20_percent_missing_fails(self):
        bullets = ["Terminated." for _ in range(3)] + ["Not terminated"]
        body = _entry("Role A", bullets)
        result = _gate_period_terminator({"experience": body})
        assert result["status"] == "fail"
        assert "1 of 4" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_metric_coverage
# ---------------------------------------------------------------------------


class TestGateMetricCoverage:
    def test_no_bullets_warns(self):
        result = _gate_metric_coverage({})
        assert result["status"] == "warn"
        assert "No bullets to check" in result["detail"]

    def test_never_returns_fail_even_at_zero_percent_coverage(self):
        body = _entry("Role A", ["No numbers in this bullet at all."])
        result = _gate_metric_coverage({"experience": body})
        assert result["status"] == "warn"

    def test_at_or_above_40_percent_passes(self):
        body = _entry("Role A", ["Grew revenue by 20%.", "Led a team of 5 people."])
        result = _gate_metric_coverage({"experience": body})
        assert result["status"] == "pass"
        assert "1/2 bullets" in result["detail"]

    def test_below_40_percent_warns(self):
        body = _entry("Role A", [
            "Grew revenue by 20%.",
            "No metric here.",
            "Also no metric here.",
        ])
        result = _gate_metric_coverage({"experience": body})
        assert result["status"] == "warn"
        assert "1/3 bullets" in result["detail"]


class TestMetricPatternHeuristic:
    """Direct coverage of the individual _METRIC_PATTERN branches, exercised
    through _gate_metric_coverage since the compiled pattern isn't exported.
    """

    def _has_metric(self, bullet: str) -> bool:
        body = _entry("Role A", [bullet, "Filler with no signal at all here."])
        result = _gate_metric_coverage({"experience": body})
        return "1/2" in result["detail"]

    def test_currency(self):
        assert self._has_metric("Managed a budget of $2M.")

    def test_percentage(self):
        assert self._has_metric("Improved conversion by 12.5%.")

    def test_numeric_range(self):
        assert self._has_metric("Led a team of 3-5 engineers.")

    def test_plus_suffix(self):
        assert self._has_metric("Onboarded 300+ customers.")

    def test_k_m_b_suffix(self):
        assert self._has_metric("Managed a $500k budget.")

    def test_x_multiplier(self):
        assert self._has_metric("Sped up builds by 5x.")

    def test_unit_word_e_g_months(self):
        assert self._has_metric("Delivered the project in 12 months.")

    def test_unit_word_e_g_dashboards(self):
        assert self._has_metric("Built 8 dashboards for stakeholders.")

    def test_number_word_alone_is_not_a_signal(self):
        # "two" is deliberately excluded — the module docstring notes digits
        # only, to avoid false positives on spelled-out numbers.
        assert not self._has_metric("Supported two e-commerce retailers.")

    def test_bare_number_with_no_recognised_unit_is_not_a_signal(self):
        assert not self._has_metric("Led 5 people across two offices.")
