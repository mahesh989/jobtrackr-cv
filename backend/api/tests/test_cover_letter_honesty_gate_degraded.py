"""C54 (AUDIT-REPORT.md, api-eval-verticals-misc.md P2): cover_letter/
generator.py's honesty gate returned (True, []) — indistinguishable from a
genuine pass — whenever its OWN AI verification call failed (a documented
recurring condition, 529/overload). The caller assigned that straight into
`honesty_ok = True` and persisted the letter with an empty `quality_flags`,
so a letter whose factual claims were NEVER checked shipped to the user
(and to a real employer) looking exactly like one that was genuinely
verified clean. The comparable CV-path verifier (eval/verify.py) already
does the opposite for the identical failure shape: sets `degraded=True`
with the comment "honesty gate did not run — surface it, don't claim
verified".

Fixed by adding a third return value (`gate_ran`) distinguishing "passed"
from "never actually ran", surfaced as `quality_flags["honesty_degraded"]`
at both call sites (the first attempt and the retry-after-fail attempt).
The letter still ships either way (per the audit's own fix note: "only the
claim of verification changes") — this is purely an added visibility
signal, not a new blocking gate.
"""
from __future__ import annotations

import pytest

from app.services.cover_letter.generator import _run_honesty_gate


class _FakeClient:
    """Minimal AIClient stand-in — only complete_json is exercised."""

    def __init__(self, *, result=None, raises=None):
        self._result = result
        self._raises = raises

    async def complete_json(self, **kwargs):
        if self._raises is not None:
            raise self._raises
        return self._result


@pytest.mark.asyncio
class TestRunHonestyGateReturnsWhetherItActuallyRan:
    async def test_genuine_pass_reports_gate_ran_true(self):
        client = _FakeClient(result={"result": "pass", "unsupported_claims": []})
        passed, unsupported, gate_ran = await _run_honesty_gate(client, "letter text", "cv text")
        assert (passed, unsupported, gate_ran) == (True, [], True)

    async def test_genuine_fail_reports_gate_ran_true(self):
        client = _FakeClient(result={"result": "fail", "unsupported_claims": ["Led a team of 50"]})
        passed, unsupported, gate_ran = await _run_honesty_gate(client, "letter text", "cv text")
        assert (passed, unsupported, gate_ran) == (False, ["Led a team of 50"], True)

    async def test_REGRESSION_ai_call_failure_still_ships_as_passed_but_now_reports_gate_ran_false(self):
        # The letter must still ship (passed=True, unsupported=[] — unchanged
        # from before this fix) — but gate_ran=False is the NEW signal that
        # lets the caller distinguish this from a genuine pass.
        client = _FakeClient(raises=RuntimeError("529 overloaded"))
        passed, unsupported, gate_ran = await _run_honesty_gate(client, "letter text", "cv text")
        assert (passed, unsupported, gate_ran) == (True, [], False)

    async def test_malformed_response_shape_does_not_crash_and_defaults_to_fail(self):
        # {} has no "result" key -> defaults to "fail" per .get("result", "fail").
        client = _FakeClient(result={})
        passed, unsupported, gate_ran = await _run_honesty_gate(client, "letter text", "cv text")
        assert (passed, unsupported, gate_ran) == (False, [], True)


class TestHonestyDegradedFlagWiredAtBothCallSites:
    """Static check that both call sites in generator.py destructure the new
    3-tuple and set quality_flags["honesty_degraded"] when gate_ran is
    False — a real end-to-end test would need to mock the full generation
    pipeline (AI client + supabase writes), which this module's own test
    coverage doesn't otherwise do; source-level assertion catches the
    concrete regression this chunk fixes (a 2-tuple unpack silently
    dropping the new signal) cheaply and reliably.

    Independent review's own finding: an earlier draft of this test only
    checked that the three matched strings were PRESENT somewhere in the
    file, which is mutation-blind to guard polarity — inverting both
    `if not gate_ran:` checks (flagging every genuinely-verified letter as
    degraded and never flagging a real gate failure — the exact inverse of
    the fix) would leave all three strings intact and this test green.
    Fixed by matching the GUARDED BLOCK as one unit (the `if` condition and
    the flag assignment together), not the assignment alone.
    """

    def test_both_call_sites_unpack_three_values_and_check_gate_ran(self):
        import inspect
        import re

        from app.services.cover_letter import generator

        src = inspect.getsource(generator)
        assert "passed, unsupported, gate_ran = await _run_honesty_gate" in src
        assert "passed_2, unsupported_2, gate_ran_2 = await _run_honesty_gate" in src

        guarded_block_re = re.compile(
            r'if not gate_ran(_2)?:\s*\n\s*quality_flags\["honesty_degraded"\] = True'
        )
        matches = guarded_block_re.findall(src)
        assert len(matches) == 2, (
            f"expected exactly 2 'if not gate_ran: quality_flags[\"honesty_degraded\"] "
            f"= True' blocks (one per call site), found {len(matches)}"
        )
