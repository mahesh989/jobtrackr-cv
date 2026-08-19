"""C67: TAILORED_CV_SYSTEM.replace("__EDUCATION_RULES_PLACEHOLDER__", ...)
runs once at module import time. str.replace() silently no-ops if the
placeholder is ever broken by an edit to the surrounding prompt text — the
module still imports fine, but every tailored-CV generation would ship
without EDUCATION_EXACT_RULES spliced in, with nothing to catch it. Fixed
with a module-load-time assertion (see the source for the mutation-tested
proof: temporarily breaking the placeholder string and re-importing the
module in a subprocess raises AssertionError; restoring it imports clean).

These tests pin the POSITIVE case — the splice actually happened and the
placeholder token is gone from the final prompt.
"""
from __future__ import annotations

from app.services.ai.prompts.education_rules import EDUCATION_EXACT_RULES
from app.services.ai.prompts.tailored_cv import TAILORED_CV_SYSTEM


def test_education_rules_are_spliced_into_the_system_prompt():
    assert EDUCATION_EXACT_RULES in TAILORED_CV_SYSTEM


def test_no_dangling_placeholder_survives_in_the_final_prompt():
    assert "__EDUCATION_RULES_PLACEHOLDER__" not in TAILORED_CV_SYSTEM
