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


# Multi-word care phrases that are ATOMIC — the leading words are not a
# meaningful phrase on their own, so seeing the prefix WITHOUT the full
# phrase means something removed the tail mid-phrase.
_ATOMIC_CARE_PHRASES: tuple[tuple[str, str], ...] = (
    ("electronic medication", "electronic medication administration"),
    ("activities of daily", "activities of daily living"),
    ("behavioural management", "behavioural management techniques"),
    ("behavioral management", "behavioral management techniques"),
)


def summary_looks_garbled(md: str) -> str | None:
    """Return the offending prefix when the summary contains a care phrase
    that has been cut off mid-phrase, else None.

    verify_claims is an AI step that removes clauses it cannot entail. It
    usually removes them cleanly, but twice in five observed production runs
    it deleted words from the MIDDLE of a sentence and welded the remains
    together:

        "accurate electronic medication emergency response"
        "accurate electronic medication high-quality care"

    Both are "electronic medication administration" with the head noun
    removed and the next clause pulled forward — text that is not English
    and that no deterministic pass in the chain can produce (they only ever
    truncate at clause boundaries). Nothing downstream re-read the summary
    for sense, so it shipped.

    Detection is narrow on purpose: only phrases whose prefix is meaningless
    alone are checked, so ordinary prose cannot trip it. The remedy at the
    call site is to REGENERATE the summary, never to delete text — a false
    positive therefore costs one extra AI call, not content.
    """
    _, prose = _career_highlights_word_count(md)
    low = prose.lower()
    for prefix, full in _ATOMIC_CARE_PHRASES:
        if prefix in low and full not in low:
            return prefix
    return None


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
    """Retry ONCE when Career Highlights is below the 35-word floor OR has
    been left mid-phrase by an upstream AI rewrite (see summary_looks_garbled).
    The model is asked to rewrite from CV-grounded facts, never to invent.
    Keeps the original on any failure or non-improving retry — never loops.
    """
    n, prose = _career_highlights_word_count(md)
    if n == 0:
        return md
    garbled = summary_looks_garbled(md)
    if n >= _CAREER_HIGHLIGHTS_FLOOR and not garbled:
        return md

    if garbled:
        problem = (
            f'Your previous Career Highlights summary is broken: the phrase '
            f'"{garbled}" is cut off mid-phrase, so the sentence is not '
            "grammatical English. Rewrite BOTH sentences cleanly."
        )
    else:
        problem = (
            f"Your previous Career Highlights summary is only {n} words — "
            "below the 35-50 word HARD MINIMUM declared in your instructions."
        )

    retry_user = (
        f"{problem}\n\n"
        f"Previous summary:\n\"{prose}\"\n\n"
        "Rewrite it to 35-50 words, EXACTLY two sentences, using specific "
        "facts from the candidate's CV below — a JD-aligned specialisation in "
        "Sentence 1, and a concrete method or outcome in Sentence 2. Do NOT "
        "pad with adjectives or filler words. Do NOT invent any fact not "
        "present in the CV. Every phrase must be complete and grammatical. "
        "Follow every other Career Highlights rule from your system "
        "instructions unchanged (no tool names, no off-axis sector, "
        "employer/scope anchor in Sentence 2, no seniority word not in the "
        "CV's own job titles).\n\n"
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

    if garbled:
        # A garbled summary is not judged on LENGTH — the original is broken
        # English, so "did not expand" is not a reason to keep it. Accept any
        # replacement that is itself intact and long enough to be a summary;
        # otherwise keep the original rather than ship something worse.
        candidate = _replace_career_highlights_prose(md, new_prose)
        if new_n >= 20 and summary_looks_garbled(candidate) is None:
            logger.info(
                "career-highlights: replaced garbled summary (cut at '%s'), "
                "%d -> %d words", garbled, n, new_n,
            )
            return candidate
        logger.warning(
            "career-highlights: retry failed to repair garbled summary "
            "(cut at '%s'); keeping original", garbled,
        )
        return md

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
