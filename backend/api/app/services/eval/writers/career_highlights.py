"""Career-highlights floor — extracted from writers._impl.

Word-count measurement, prose replacement, and the retry loop that tops the
Career Highlights section up to its minimum word floor.
Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
from app.services.ai.client import AIClient, TAILORED_CV_GENERATION

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

def _career_highlights_word_count(md: str) -> tuple[int, str]:
    """Return (word_count, prose) for the canonical '## Career Highlights' body."""
    heading = "## Career Highlights"
    lines = md.split("\n")
    start = next((i for i, ln in enumerate(lines) if ln.strip() == heading), None)
    if start is None:
        return 0, ""
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    prose = " ".join(
        ln.strip() for ln in lines[start + 1 : end]
        if ln.strip() and not ln.strip().startswith(("-", "*"))
    )
    return len(prose.split()), prose

def _replace_career_highlights_prose(md: str, new_prose: str) -> str:
    heading = "## Career Highlights"
    lines = md.split("\n")
    start = next((i for i, ln in enumerate(lines) if ln.strip() == heading), None)
    if start is None:
        return md
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    new_lines = lines[: start + 1] + ["", new_prose, ""] + lines[end:]
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
        return md

    logger.info("career-highlights floor retry: %d -> %d words", n, new_n)
    return _replace_career_highlights_prose(md, new_prose)
