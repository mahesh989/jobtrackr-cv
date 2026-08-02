"""Project bullet dedup.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

import re

def _norm_bullet(text: str) -> str:
    """Fingerprint for bullet dedup: lowercase alphanumerics only."""
    return re.sub(r'[^a-z0-9]', '', text.lower())


def _dedup_project_bullets(markdown: str) -> str:
    """
    Remove project bullets that are verbatim (normalised) copies of
    experience bullets. The AI tends to paste the same bullet into both
    sections; this strips the duplicate from Projects.
    """
    EXP_HEADING = "## Professional Experience"
    PROJ_HEADING = "## Projects"
    lines = markdown.split("\n")

    def _section_range(heading: str):
        start = next((i for i, ln in enumerate(lines) if ln.strip() == heading), None)
        if start is None:
            return None, None
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
            len(lines),
        )
        return start, end

    exp_start, exp_end = _section_range(EXP_HEADING)
    proj_start, proj_end = _section_range(PROJ_HEADING)
    if exp_start is None or proj_start is None:
        return markdown

    # Collect normalised fingerprints of all experience bullets
    exp_fps: set[str] = set()
    for ln in lines[exp_start:exp_end]:
        s = ln.strip()
        if s.startswith("- ") or s.startswith("* "):
            exp_fps.add(_norm_bullet(s[2:]))

    # Strip any project bullet whose fingerprint matches an experience bullet
    new_lines = list(lines)
    for i in range(proj_start, proj_end):
        s = new_lines[i].strip()
        if (s.startswith("- ") or s.startswith("* ")) and _norm_bullet(s[2:]) in exp_fps:
            new_lines[i] = ""

    return "\n".join(new_lines)
