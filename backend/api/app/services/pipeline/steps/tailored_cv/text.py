"""Generic text helpers — word trimming and dangling-token cleanup.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations



# Words that should never end a sentence — leaving any of these as the
# final word produces an obvious incomplete fragment (e.g. "...analysis to.").
_DANGLING_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "for",
    "of", "to", "in", "on", "at", "by", "with", "as", "from", "into",
    "onto", "upon", "through", "across", "over", "under", "between",
    "among", "about", "around", "via", "per", "than", "that", "which",
    "who", "whom", "whose", "if", "when", "while", "because", "since",
    "though", "although", "however",
}


def _strip_trailing_danglers(words: list[str]) -> list[str]:
    """
    Remove trailing connective words so the result ends on real content.
    Also strips hyphenated modifiers ("real-time", "cross-functional",
    "end-to-end") that dangle without their head noun after a hard cut.
    """
    while words:
        last_raw = words[-1].rstrip(".,;:!?")
        last_lc = last_raw.lower()
        if last_lc in _DANGLING_WORDS:
            words = words[:-1]
        elif "-" in last_raw and not last_raw[0].isdigit():
            # Hyphenated compound at end of a hard cut is almost always
            # incomplete (e.g. "real-time", "cross-functional"). Skip
            # numeric ones like "1-2" or "2024-2025".
            words = words[:-1]
        else:
            break
    return words


def _trim_to_words(text: str, max_words: int) -> str:
    """
    Truncate text to roughly max_words, ending with a period and a complete
    thought. Resolution order:
      1. If a clause boundary (',' or ';') exists in [60%..max_words], cut there.
      2. Else, look ahead up to max_words+10 for a clause boundary or sentence
         end so we never break mid-phrase for the sake of a tight cap.
      3. Else, hard-cut at max_words then strip any trailing connective
         words ("to", "and", "of", "the", "with", ...) so we never end on
         a preposition or conjunction.
    Word limits are guidelines; readability wins.
    """
    words = text.split()
    if len(words) <= max_words:
        return text

    min_words = max(1, int(max_words * 0.6))
    flex_cap = max_words + 10  # may exceed cap by up to 10 to complete a clause

    def _ends_clause(w: str) -> bool:
        # Only commas count as clause boundaries here. Semicolons used to
        # qualify, but the summary's S2 joins two employer clauses with a
        # semicolon ("…at Org A; …at Org B."); cutting at the semicolon
        # silently deleted the second clause and produced the "single
        # employer" summary bug. Commas are the safe boundary — the trimmer
        # falls back to commas when no clause boundary fits, and to a hard
        # word-cap dangler strip when there are no commas either.
        return w.endswith(",")

    def _outer_comma_idx(anchor_idx: int) -> int:
        """
        Given a comma at anchor_idx, walk back to find the FIRST comma in any
        chain of close-together commas (≤5 words apart). This identifies the
        START of a list — cutting there removes the whole dangling list, which
        reads cleaner than a 2-item stub like "X, Y" missing its closer.
        """
        cur = anchor_idx
        while True:
            search_start = max(0, cur - 5)
            earlier = -1
            for j in range(cur - 1, search_start - 1, -1):
                if _ends_clause(words[j]):
                    earlier = j
                    break
            if earlier == -1:
                return cur
            cur = earlier

    # 1. Backward search within the cap for a clause boundary
    for i in range(max_words, min_words - 1, -1):
        if i - 1 < 0 or i - 1 >= len(words):
            continue
        if _ends_clause(words[i - 1]):
            outer = _outer_comma_idx(i - 1)
            # Prefer cutting at the outer comma so we drop the whole list.
            # But never go below min_words — fall back to inner cut if so.
            cut = outer + 1 if outer + 1 >= min_words else i
            kept = _strip_trailing_danglers(words[:cut])
            return " ".join(kept).rstrip(".,;:!?") + "."

    # 2. Forward search up to flex_cap for a clause/sentence boundary
    for i in range(max_words + 1, min(flex_cap, len(words)) + 1):
        prev = words[i - 1]
        if _ends_clause(prev) or prev.endswith("."):
            kept = _strip_trailing_danglers(words[:i])
            return " ".join(kept).rstrip(".,;:!?") + "."

    # 3. Hard cut + strip danglers
    kept = _strip_trailing_danglers(words[:max_words])
    if not kept:
        kept = words[:max_words]  # safety: don't return empty
    return " ".join(kept).rstrip(".,;:!?") + "."
