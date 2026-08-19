"""Shared "does this keyword literally appear in this text" predicate.

C49 (AUDIT-REPORT.md #11 / api-pipeline.md P2): cv_jd_matching.py and
tailored_rescoring.py each had their own copy of this predicate, and they
had drifted. cv_jd_matching._literal_match_in_text (used to promote a
missed JD keyword to matched on the ORIGINAL CV) always wrapped the keyword
in \\b...\\b — which fails whenever NEITHER side of the keyword sits next
to a word character in the surrounding text (independent review's own
adversarial check: \\b\\.net\\b DOES match inside "asp.net", since "p" is a
word char immediately before "."; it does NOT match ", .NET," — the
audit's own reproduction case — since both the preceding space and the
leading "." are non-word, so there's no boundary to anchor the match's
start at all). A trailing punctuation character makes this categorically
worse: "c#"/"c++"/"excel (advanced)" can NEVER match \\b...\\b regardless
of context, since nothing on their trailing side is ever a word character.
tailored_rescoring._literal_match (used to credit a keyword in the
TAILORED CV) already had a deliberate guard: word-boundary regex only for
keywords that are pure word/space/hyphen, plain substring otherwise.

The drift was strictly asymmetric and output-affecting: a JD keyword like
"C#" that the CV genuinely holds would stay stuck in `missed` on the
ORIGINAL score (understating it, since the promotion pass couldn't rescue
it) while the SAME keyword — carried through unchanged into the tailored
CV by the writer — got correctly credited by the tailored-side matcher,
reported to the user as something tailoring "injected", and inflated
`ats_lift` with a gain the tailoring never produced.

Single source of truth here, matching tailored_rescoring's original
(correct) behaviour — see PLAUSIBLE_WORD_RE's docstring for why the guard
exists. Both call sites keep their own text-casing contract: this function
requires PRE-LOWERED `text_lower` (tailored_rescoring's own convention);
cv_jd_matching's wrapper lowercases both keyword and text before calling in
(that module's own established convention — it accepts mixed-case input).
"""
from __future__ import annotations

import re

_PLAUSIBLE_WORD_RE = re.compile(r"[\w\s\-]+")


def literal_match(kw: str, text_lower: str) -> bool:
    """Word-boundary regex match for word-only keywords; substring for the
    rest. `text_lower` MUST already be lowercased by the caller — this
    function does not lowercase it (matches tailored_rescoring's original
    contract; see cv_jd_matching.literal_match_in_text for the
    accepts-mixed-case variant)."""
    if not kw:
        return False
    if _PLAUSIBLE_WORD_RE.fullmatch(kw):
        pattern = r"\b" + re.escape(kw) + r"\b"
        return re.search(pattern, text_lower) is not None
    return kw in text_lower
