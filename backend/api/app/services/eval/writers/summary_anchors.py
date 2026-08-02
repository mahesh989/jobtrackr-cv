"""Summary employer anchoring — extracted from writers._impl.

Detects which employers the summary already names and re-prompts until both
anchor employers appear. Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
from app.services.ai.client import AIClient, TAILORED_CV_GENERATION
from app.services.pipeline.steps.tailored_cv import (
    _cert_policy_for,          # role-family cert_policy (keep first_class certs)
    _enforce_company_anchor,   # summary employer-anchor net (re-run post-verify)
    _enforce_structure,        # production-stable post-processor — reused for fairness
    _enforce_summary_opener,   # forbidden-opener strip (re-run post-verify)
    _enforce_summary_s1_title_case,  # S1 title-case (runs before opener strip)
    _extract_employers_from_cv,  # multi-month employer extraction (anchor enforcement)
    _inject_missing_skills,    # production-stable safety net
    _upload_to_storage,        # production-stable Supabase upload (same path contract)
    build_family_label_map,    # convert RoleFamilyProfile → bold label map for injector
)
import re
from app.services.eval.writers.career_highlights import _career_highlights_word_count, _replace_career_highlights_prose

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Display-heading unification for the summary block.
#
# Heading rule (overrides any role-family default):
#   • YEARS framing in S1 (numeric years figure / "a decade" / "for several
#     years") → "## Career Highlights"
#   • BREADTH framing in S1 (scope phrase, recent placement, no years figure)
#     → "## Professional Summary"
#
# Runs as the very last step in the pipeline so every internal helper
# (validators, enforcers, word-floor retry, restore_and_order) has already
# completed. Operates on any of the three observed summary heading aliases
# (Career Highlights / Professional Summary / Summary) so a role family's
# default name does not block the override.
# ---------------------------------------------------------------------------
_SUMMARY_HEADING_ALIASES = (
    "## Career Highlights",
    "## Professional Summary",
    "## Summary",
)

_YEARS_FIGURE_RE = re.compile(
    r"\b("
    r"\d+\+?\s+years?"            # "5 years", "10+ years"
    r"|over\s+\d+\s+years?"       # "over 3 years"
    r"|a\s+decade"                # "a decade"
    r"|several\s+years?"          # "several years"
    r"|many\s+years?"             # "many years"
    r")\b",
    re.IGNORECASE,
)

def _summary_named_employers(prose: str, employers: list[str]) -> list[str]:
    """Return the subset of `employers` whose name appears in the summary prose
    (case-insensitive)."""
    low = prose.lower()
    return [e for e in employers if e.lower() in low]

async def _ensure_summary_anchors_both_employers(
    client: AIClient, md: str, *, system_prompt: str, cv_text: str, jd_text: str,
) -> str:
    """MULTI-ROLE company-anchor corrective retry.

    The composition prompt requires that when the candidate has 2+ multi-month
    (NAMEABLE-anchor) employers, Sentence 2 names BOTH — one clause each,
    semicolon-joined. The model sometimes cherry-picks one (e.g. names only the
    employer that gave an award) and silently drops the other. The deterministic
    ``_enforce_company_anchor`` net cannot repair this: it treats the summary as
    "already anchored" the moment ANY one top-2 employer appears, and its regex
    append cannot restructure an award-shaped S2 into two clauses.

    This retry detects the gap (2+ anchors, but <2 named in the summary) and asks
    the model ONCE to rewrite Sentence 2 into two method+outcome clauses naming
    both employers. Accepts the rewrite ONLY when it now names both top-2
    employers AND stays exactly two sentences; otherwise keeps the original.
    Never loops, never fabricates (model is told CV-grounded facts only).
    """
    if not cv_text:
        return md
    employers = _extract_employers_from_cv(cv_text)
    if len(employers) < 2:
        return md  # single/none — the two-clause rule does not apply

    n, prose = _career_highlights_word_count(md)
    if n == 0 or not prose:
        return md
    top2 = employers[:2]
    if len(_summary_named_employers(prose, top2)) >= 2:
        return md  # both already named — compliant, no change

    retry_user = (
        "Your previous Career Highlights summary does not name BOTH of the "
        "candidate's anchor employers, which your instructions require when the "
        "candidate has two roles with continuous multi-month tenure.\n\n"
        f"Previous summary:\n\"{prose}\"\n\n"
        f"The two anchor employers (name BOTH) are: {top2[0]} and {top2[1]}.\n\n"
        "Rewrite the summary as EXACTLY two sentences, 35-50 words total. Keep "
        "Sentence 1 (positioning) essentially as-is. Rewrite Sentence 2 as TWO "
        "clauses joined by a SEMICOLON — one clause per employer above, each "
        "naming a care METHOD and a concrete CV-grounded outcome (e.g. "
        "\"Delivered electronic medication administration at "
        f"{top2[0]}; provided person-centred care at {top2[1]}.\"). "
        "Use PAST tense for a completed role and PRESENT tense for a role marked "
        "\"– Present\". Do NOT use the award as Sentence 2. Do NOT invent facts. "
        "No tool/brand names (use the method they enable). Follow every other "
        "Career Highlights rule from your system instructions.\n\n"
        f"Original CV:\n{cv_text}\n\nJob description:\n{jd_text}\n\n"
        "Output ONLY the two rewritten sentences — no heading, no markdown, "
        "no commentary."
    )
    try:
        retried = await client.complete(
            system=system_prompt,
            user=retry_user,
            max_tokens=300,
            operation="tailored_cv_summary_anchor_retry",
            **TAILORED_CV_GENERATION,
        )
    except Exception:
        logger.warning("summary anchor retry failed; keeping single-employer summary")
        return md

    new_prose = (retried or "").strip()
    if not new_prose:
        return md
    # Accept ONLY if the rewrite now names both anchors and is still two sentences.
    if len(_summary_named_employers(new_prose, top2)) < 2:
        logger.info("summary anchor retry did not name both employers; keeping original")
        return md
    sentence_count = len([s for s in re.split(r"(?<=[.!?])\s+", new_prose) if s.strip()])
    if sentence_count != 2:
        logger.info("summary anchor retry was not 2 sentences (%d); keeping original", sentence_count)
        return md

    logger.info("summary anchor retry: now names both %s and %s", top2[0], top2[1])
    return _replace_career_highlights_prose(md, new_prose)
