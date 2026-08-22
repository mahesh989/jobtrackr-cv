"""Section/bullet structural enforcement.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

import re
from .credentials import (
    _enforce_education_count,
    _promote_qualification_cert_to_education,
    _strip_certs_when_excluded,
    _strip_certs_when_projects_exist,
    _strip_education_bullets,
)
from .employers import _enforce_company_anchor
from .projects import _dedup_project_bullets
from .summary import (
    _find_summary_block,
    _enforce_summary_opener,
    _enforce_summary_s1_title_case,
    _enforce_summary_s2_word_cap,
    _flag_vague_anchor,
    _lowercase_generic_care_phrases,
)
from .text import _trim_to_words

def _enforce_bullets(bullet_lines: list[str], word_limits: list[int]) -> list[str]:
    """
    Keep at most len(word_limits) bullets and enforce per-bullet word caps.
    word_limits[i] is the cap for the i-th bullet (0-indexed).
    """
    kept = bullet_lines[: len(word_limits)]
    result = []
    for i, line in enumerate(kept):
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        if stripped.startswith("- "):
            prefix = indent + "- "
            content = stripped[2:]
        elif stripped.startswith("* "):
            prefix = indent + "* "
            content = stripped[2:]
        else:
            result.append(line)
            continue
        result.append(prefix + _trim_to_words(content, word_limits[i]))
    return result


def _enforce_section_roles(
    section_body: str,
    max_roles: int,
    default_bullet_limits: list[int],
    override_by_index: dict[int, list[int]] | None = None,
) -> str:
    """
    Trim section body to max_roles `### ` blocks, enforcing bullet limits per role.
    override_by_index maps 0-based role index → its specific bullet limits,
    overriding default_bullet_limits for that role only.
    """
    lines = section_body.split("\n")
    roles: list[list[str]] = []
    current: list[str] | None = None

    for line in lines:
        if line.startswith("### "):
            if current is not None:
                roles.append(current)
            current = [line]
        else:
            if current is not None:
                current.append(line)

    if current is not None:
        roles.append(current)

    roles = roles[:max_roles]

    out_lines: list[str] = []
    for role_idx, role in enumerate(roles):
        limits = (override_by_index or {}).get(role_idx, default_bullet_limits)
        header = role[0]
        rest = role[1:]

        bullets: list[str] = []
        non_bullets: list[str] = []
        collecting_bullets = False
        for line in rest:
            stripped = line.strip()
            if stripped.startswith("- ") or stripped.startswith("* "):
                collecting_bullets = True
                bullets.append(line)
            elif collecting_bullets and stripped == "":
                break
            else:
                non_bullets.append(line)

        enforced = _enforce_bullets(bullets, limits)
        out_lines.append(header)
        out_lines.extend(non_bullets)
        out_lines.extend(enforced)

    return "\n".join(out_lines)


def _enforce_career_highlights_words(markdown: str, max_words: int = 50) -> str:
    """
    Trim Career Highlights prose to at most max_words words.
    Ensures exactly two sentences are kept if present, truncating the second
    sentence if the total word count exceeds max_words.

    50 matches the composer prompt's own "35-50 words total" ceiling
    (composition.py CAREER-STYLE SUMMARY) — S1 ≤28 + a two-employer S2
    (16-22) already fits within 50, so no extra headroom is needed. The
    semicolon is not a cut boundary (see _trim_to_words._ends_clause), so a
    two-employer S2 still trims as one clause pair rather than losing the
    second employer's clause.
    """
    lines = markdown.split("\n")

    # Heading matched by ALIAS, not by the literal "## Career Highlights".
    # C22f already had to strip a trailing colon here because an exact match
    # silently skipped the whole word-cap pass; the same class of miss
    # applies to the family rename — restore_and_order() turns this heading
    # into "## Professional Summary" for nursing and "## Summary" for
    # manual, so a literal match makes this cap a no-op for those families
    # anywhere downstream of that rename. Pre-verify (its original and only
    # call site) the heading is still canonical, so this is a superset of
    # the previous behaviour there and changes nothing.
    ch_start, ch_end = _find_summary_block(lines)
    if ch_start is None:
        return markdown

    body = lines[ch_start + 1 : ch_end]
    prose_idx: list[int] = []
    prose_text: list[str] = []
    for i, ln in enumerate(body):
        s = ln.strip()
        if s and not s.startswith("- ") and not s.startswith("* "):
            prose_idx.append(i)
            prose_text.append(s)

    if not prose_text:
        return markdown

    full = " ".join(prose_text)
    words = full.split()
    if len(words) <= max_words:
        return markdown

    # Split into sentences using a regex
    sent_split_re = re.compile(r"(?<=[.!?])\s+")
    sentences = [s.strip() for s in sent_split_re.split(full) if s.strip()]
    if len(sentences) >= 2:
        s1 = sentences[0]
        s1_len = len(s1.split())
        s2_max = max(5, max_words - s1_len)
        s2 = sentences[1]
        s2_trimmed = _trim_to_words(s2, s2_max)
        trimmed = f"{s1} {s2_trimmed}"
    else:
        trimmed = _trim_to_words(full, max_words)

    # Replace prose lines: blank all, write trimmed into first prose slot
    new_lines = list(lines)
    for i in prose_idx:
        new_lines[ch_start + 1 + i] = ""
    new_lines[ch_start + 1 + prose_idx[0]] = trimmed
    return "\n".join(new_lines)


def _enforce_other_skills_chars(markdown: str, max_chars: int = 80) -> str:
    """
    Cap the Other Skills line content (after 'Other Skills:') to max_chars characters.
    Truncates at the last ', ' boundary within the cap to preserve complete skill names.
    """
    result = []
    for line in markdown.split("\n"):
        m = re.match(r'^(\*\*Other Skills:\*\*\s*)(.*)', line.strip(), re.IGNORECASE)
        if not m:
            m = re.match(r'^(Other Skills:\s*)(.*)', line.strip(), re.IGNORECASE)
        if m:
            prefix = m.group(1)
            content = m.group(2).strip()
            if len(content) > max_chars:
                cut = content[:max_chars]
                last_comma = cut.rfind(", ")
                content = cut[:last_comma] if last_comma > 0 else cut
            result.append(prefix + content)
        else:
            result.append(line)
    return "\n".join(result)


def _dedup_career_highlights(markdown: str) -> str:
    """
    If the AI emitted ## Career Highlights twice (prose then bullets),
    keep only the first occurrence and drop the second block entirely.
    """
    HEADING = "## Career Highlights"
    lines = markdown.split("\n")
    # C22f: strip a trailing colon the AI writer sometimes emits — a
    # colon'd duplicate heading previously wasn't recognised as a match at
    # all, so the dedup pass silently never fired.
    positions = [i for i, ln in enumerate(lines) if ln.strip().rstrip(":") == HEADING]
    if len(positions) < 2:
        return markdown

    second_start = positions[1]
    second_end = len(lines)
    for i in range(second_start + 1, len(lines)):
        if lines[i].startswith("## "):
            second_end = i
            break

    return "\n".join(lines[:second_start] + lines[second_end:])


def _enforce_structure(
    markdown: str, jd_job_title: str = "", cv_text: str = "", cert_policy: str = ""
) -> str:
    """
    Deterministic post-processing:
      - Deduplicate Career Highlights (keep prose, drop bullet repeat)
      - Professional Experience: max 3 roles; bullets 1+2 ≤32 words, bullet 3 ≤12 words
      - Projects: max 2 entries; bullet 1 ≤32 words, bullet 2 ≤14 words

    `jd_job_title` (when supplied) lets the S1-opener enforcer replace a
    forbidden status/education opener with the real JD-aligned role title.
    `cv_text` (when supplied) lets the company-anchor enforcer inject employer
    names into S2 when the LLM omitted them despite having multi-month roles.
    `cert_policy` (when supplied) governs the Certifications section:
    "first_class" families (manual) keep it even when Projects exists;
    "excluded" families (nursing/health sector) never get one at all; every
    other family drops it when Projects exists. In every case, an AQF
    qualification certificate (Certificate I–IV / Diploma) is promoted into
    Education first, so an AIN's "Certificate IV in Ageing Support" lands in
    the same section every time regardless of where the source CV placed it
    — before "excluded" wipes whatever's left under Certifications.
    """
    markdown = _dedup_project_bullets(markdown)
    markdown = _promote_qualification_cert_to_education(markdown, cert_policy)
    markdown = _strip_certs_when_excluded(markdown, cert_policy)
    markdown = _strip_certs_when_projects_exist(markdown, cert_policy)
    markdown = _dedup_career_highlights(markdown)
    markdown = _enforce_education_count(markdown, max_entries=3)
    markdown = _strip_education_bullets(markdown)
    markdown = _enforce_career_highlights_words(markdown, max_words=50)
    markdown = _flag_vague_anchor(markdown)
    markdown = _enforce_summary_s2_word_cap(markdown, cap=22)
    markdown = _enforce_summary_s1_title_case(markdown)
    markdown = _enforce_summary_opener(markdown, jd_job_title)
    markdown = _lowercase_generic_care_phrases(markdown)
    markdown = _enforce_company_anchor(markdown, cv_text)
    markdown = _enforce_other_skills_chars(markdown, max_chars=80)

    EXP_HEADING = "## Professional Experience"
    PROJ_HEADING = "## Projects"

    lines = markdown.split("\n")

    # Collect (start_idx, heading_text) for every ## line
    section_starts: list[tuple[int, str]] = [
        (i, line) for i, line in enumerate(lines) if line.startswith("## ")
    ]
    if not section_starts:
        return markdown

    # Map each section to its exclusive end index
    sections: list[tuple[int, int, str]] = []  # (start, end, heading)
    for idx, (start, heading) in enumerate(section_starts):
        end = section_starts[idx + 1][0] if idx + 1 < len(section_starts) else len(lines)
        # C22f: strip a trailing colon the AI writer sometimes emits — the
        # `heading == EXP_HEADING`/`== PROJ_HEADING` comparisons below are
        # defeated by it, silently skipping the role/bullet-count caps
        # entirely for a colon'd "## Professional Experience:"/"## Projects:".
        # This is also the site that closes the tech/master blind spot: those
        # families' _rename_headings mapping is intentionally empty (their
        # headings are already canonical natively), so nothing upstream ever
        # strips a colon for them — this is the first and only place their
        # heading text is compared by name before the caps apply.
        sections.append((start, end, heading.strip().rstrip(":")))

    # Process sections, accumulating output chunks
    output_chunks: list[list[str]] = []
    prev_end = 0

    for start, end, heading in sections:
        # Carry over any lines before this section (shouldn't normally exist)
        if start > prev_end:
            output_chunks.append(lines[prev_end:start])

        body = "\n".join(lines[start + 1 : end])

        if heading == EXP_HEADING:
            new_body = _enforce_section_roles(
                body,
                max_roles=3,
                default_bullet_limits=[32, 32, 12],
                override_by_index={2: [32, 32]},  # 3rd role: 2 bullets only
            )
        elif heading == PROJ_HEADING:
            new_body = _enforce_section_roles(
                body,
                max_roles=2,
                default_bullet_limits=[32, 14],
            )
        else:
            new_body = body

        output_chunks.append([lines[start]] + new_body.split("\n"))
        prev_end = end

    # Trailing lines after the last section
    if prev_end < len(lines):
        output_chunks.append(lines[prev_end:])

    return "\n".join(line for chunk in output_chunks for line in chunk)
