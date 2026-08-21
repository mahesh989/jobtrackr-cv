"""Career-highlights floor — extracted from writers._impl.

Word-count measurement, prose replacement, and the retry loop that tops the
Career Highlights section up to its minimum word floor.
Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
from app.services.ai.client import AIClient, TAILORED_CV_GENERATION
from app.services.pipeline.steps.tailored_cv.summary import _SUMMARY_HEADING_RE

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Career Highlights word-floor enforcement — deterministic retry
#
# The composer prompt (composition.py) declares 35 words a HARD MINIMUM for
# the two-sentence summary, but the LLM does not always comply. Previously
# the only check was tailored_structural_validation's profile_word_count
# gate, which just LOGS "fail" on the report — it never fixed anything, so
# an under-length summary shipped to the user unchanged. This makes the
# floor self-healing: one targeted retry that asks the model to expand the
# existing summary with additional CV-grounded facts, not pad it.
# ---------------------------------------------------------------------------

_CAREER_HIGHLIGHTS_FLOOR = 35

def _summary_bounds(md: str) -> tuple[int | None, int]:
    """Locate the summary block by ANY of its heading aliases.

    Must not hardcode "## Career Highlights": restore_and_order() renames
    the canonical heading to the family's own name well before the end of
    the pipeline (for nursing, back to "## Professional Summary"), and
    _apply_display_heading can swap it again at the very end. A
    heading-literal lookup silently returns "no summary found" for every
    nursing CV once that rename has happened, which is exactly how an
    under-length summary reached production unnoticed. Reuses the same
    alias regex the production summary enforcers use.
    """
    lines = md.split("\n")
    start = next(
        (i for i, ln in enumerate(lines) if _SUMMARY_HEADING_RE.match(ln.strip())),
        None,
    )
    if start is None:
        return None, 0
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return start, end


def _career_highlights_word_count(md: str) -> tuple[int, str]:
    """Return (word_count, prose) for the summary body, under any heading alias.

    Bullet lines and italic-only lines are excluded — the latter keeps the
    stamped "*Available: …*" note out of the prose word count.
    """
    lines = md.split("\n")
    start, end = _summary_bounds(md)
    if start is None:
        return 0, ""
    prose = " ".join(
        ln.strip() for ln in lines[start + 1 : end]
        if ln.strip() and not ln.strip().startswith(("-", "*"))
    )
    return len(prose.split()), prose

def _replace_career_highlights_prose(md: str, new_prose: str) -> str:
    """Swap the summary prose, preserving any non-prose lines in the block.

    The stamped "*Available: …*" italic line lives inside this block; the
    earlier version rebuilt the block as [heading, "", prose, ""] and so
    DELETED it. That was harmless when this only ran pre-verify (before the
    availability line is stamped) but silently drops it on the post-verify
    re-run, so non-prose lines are now carried through explicitly.
    """
    lines = md.split("\n")
    start, end = _summary_bounds(md)
    if start is None:
        return md
    preserved = [
        ln for ln in lines[start + 1 : end]
        if ln.strip().startswith(("-", "*"))
    ]
    new_lines = (
        lines[: start + 1] + ["", new_prose, ""] + preserved
        + ([""] if preserved else []) + lines[end:]
    )
    return "\n".join(new_lines)

async def _ensure_career_highlights_floor(
    client: AIClient, md: str, *, system_prompt: str, cv_text: str, jd_text: str,
) -> str:
    """If Career Highlights is below the 35-word floor, retry ONCE asking the
    model to expand it with additional CV-grounded facts (never invented).
    Keeps the original on any failure or non-improving retry — never loops.
    """
    n, prose = _career_highlights_word_count(md)
    if n == 0 or n >= _CAREER_HIGHLIGHTS_FLOOR:
        return md

    retry_user = (
        f"Your previous Career Highlights summary is only {n} words — "
        "below the 35-50 word HARD MINIMUM declared in your instructions.\n\n"
        f"Previous summary:\n\"{prose}\"\n\n"
        "Rewrite it to 35-50 words, EXACTLY two sentences, by EXPANDING with "
        "additional specific facts from the candidate's CV below — an extra "
        "JD-aligned specialisation in Sentence 1, or a second quantified "
        "detail / named method in Sentence 2. Do NOT pad with adjectives or "
        "filler words. Do NOT invent any fact not present in the CV. Follow "
        "every other Career Highlights rule from your system instructions "
        "unchanged (no tool names, no off-axis sector, employer/scope anchor "
        "in Sentence 2, no seniority word not in the CV's own job titles).\n\n"
        f"Original CV:\n{cv_text}\n\nJob description:\n{jd_text}\n\n"
        "Output ONLY the two rewritten sentences — no heading, no markdown, "
        "no commentary."
    )
    try:
        retried = await client.complete(
            system=system_prompt,
            user=retry_user,
            max_tokens=300,
            operation="tailored_cv_summary_floor_retry",
            **TAILORED_CV_GENERATION,
        )
    except Exception:
        logger.warning("career-highlights floor retry failed; keeping %d-word summary", n)
        return md

    new_prose = (retried or "").strip()
    new_n = len(new_prose.split()) if new_prose else 0
    if new_n <= n:
        # Retry didn't actually expand it — keep the original rather than regress.
        logger.warning(
            "career-highlights floor retry did not expand (%d -> %d words); "
            "keeping original, still below the %d-word floor",
            n, new_n, _CAREER_HIGHLIGHTS_FLOOR,
        )
        return md

    # An improvement that is STILL under the floor is taken (better than the
    # original) but must not be logged as a success — the previous
    # unconditional info-level "31 -> 33 words" read as compliant when the
    # summary was still short of the hard minimum.
    if new_n < _CAREER_HIGHLIGHTS_FLOOR:
        logger.warning(
            "career-highlights floor retry: %d -> %d words — still below the "
            "%d-word floor", n, new_n, _CAREER_HIGHLIGHTS_FLOOR,
        )
    else:
        logger.info("career-highlights floor retry: %d -> %d words", n, new_n)
    return _replace_career_highlights_prose(md, new_prose)
