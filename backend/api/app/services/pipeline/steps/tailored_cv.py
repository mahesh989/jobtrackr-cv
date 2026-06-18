"""
Step 6 — Tailored CV generation.

Calls AI to rewrite the CV in markdown, then uploads the markdown to
Supabase Storage and returns the storage path.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Dict, Optional, Tuple

from app.config import get_settings
from app.database import get_supabase
from app.services.ai.client import AIClient, TAILORED_CV_GENERATION
from app.services.eval.enforce import _split_compound_skills
from app.services.ai.prompts import (
    TAILORED_CV_SYSTEM,
    TAILORED_CV_USER_TEMPLATE,
)
from app.services.cv.contact_line import stamp_contact_line

logger = logging.getLogger(__name__)


async def run_tailored_cv(
    client: AIClient,
    user_id: uuid.UUID,
    run_id: uuid.UUID,
    cv_text: str,
    jd_analysis: Dict[str, Any],
    ai_recommendations_md: str,
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str]:
    """
    Returns:
        (markdown, storage_path)
    """
    # The prompt only needs the plan itself, not the summary block.
    feasibility_for_prompt = (feasibility or {}).get("feasibility_plan") or {}

    user_prompt = TAILORED_CV_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(jd_analysis, indent=2),
        ai_recommendations_md=ai_recommendations_md,
        feasibility_json=json.dumps(feasibility_for_prompt, indent=2),
    )
    # Bumped from cv-magic's 4096 to 6144. The tailored CV is the longest
    # AI output in the pipeline; verbose JDs + multi-role CVs can produce
    # markdown that hits 4096 and gets cut off mid-section, failing
    # _enforce_structure downstream. The AI client also retries on
    # truncation, but raising the first-try ceiling avoids the extra
    # round-trip in the common case.
    markdown = await client.complete(
        system=TAILORED_CV_SYSTEM,
        user=user_prompt,
        max_tokens=6144,
        operation="tailored_cv",
        **TAILORED_CV_GENERATION,
    )

    if not markdown or len(markdown.strip()) < 200:
        raise ValueError("Tailored CV: response too short")

    enforced_md = _enforce_structure(markdown.strip(), jd_job_title=str(jd_analysis.get("job_title") or ""))

    role_family_id = jd_analysis.get("role_family")
    family_label_map = None
    if role_family_id:
        try:
            from app.services.eval.role_families import resolve_role_family
            rf = resolve_role_family(role_family_id, jd_analysis)
            if rf:
                family_label_map = build_family_label_map(rf)
        except Exception:
            logger.warning("Tailored CV: failed to resolve family %s for label map", role_family_id)

    # Deterministic safety net: ensure every approved Skills-targeted keyword
    # actually lands in the Skills section, even if the AI dropped or omitted
    # it. Avoids needing further prompt tightening for keyword recall.
    enforced_md = _inject_missing_skills(enforced_md, feasibility, family_label_map=family_label_map)

    # Stamp the user's saved contact details onto the contact line so the
    # output is consistent regardless of what the AI emitted.
    final_md = stamp_contact_line(enforced_md, contact_details, role_family_id=role_family_id)

    storage_path = _upload_to_storage(user_id, run_id, final_md)
    return final_md, storage_path


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
      2. Else, look ahead up to max_words+5 for a clause boundary or sentence
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
    HEADING = "## Career Highlights"
    lines = markdown.split("\n")

    ch_start = next((i for i, ln in enumerate(lines) if ln.strip() == HEADING), None)
    if ch_start is None:
        return markdown

    ch_end = next(
        (i for i in range(ch_start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )

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


# ---------------------------------------------------------------------------
# Summary-quality deterministic enforcers
# ---------------------------------------------------------------------------

# Role-title fragments that appear at the start of the summary S1 opener and
# must be Title Cased.  We don't try to title-case the whole sentence (that
# would wreck mid-sentence proper nouns); we only fix the opener token(s)
# that are the role title — typically 2-4 words before the first "with".
_TITLE_CASE_STOP = re.compile(
    r"^([A-Za-z][a-z]*(?: [A-Za-z][a-z]*){0,4})\b(.*)",
    re.DOTALL,
)

# Vague anchor phrases the COMPANY ANCHOR rule explicitly forbids.
# Real anchors are: a NAMED employer ("at RFBI Concord Community Village") or
# a scope phrase ("across multiple residential aged care settings"). Anything
# vague — "a facility", "this setting", "a multidisciplinary team
# environment" — fails the rule.
_VAGUE_ANCHOR_RE = re.compile(
    # facility variants
    r"\b(?:at|in|through)\s+(?:a|an|the)\s+(?:aged care\s+)?facilit(?:y|ies)\b"
    # setting variants — "in a residential aged care setting", "in this setting"
    r"|\b(?:at|in|for residents in|across)\s+(?:a|an|the|this|that|the same)"
    r"(?:\s+(?:residential|aged care|nursing|care|clinical))*\s+setting\b"
    # environment variants — "in a multidisciplinary team environment"
    r"|\b(?:at|in|within)\s+(?:a|an|the|this|that)"
    r"(?:\s+[a-z-]+){0,4}\s+environment\b"
    # generic placement / casual / industry catch-alls
    r"|\bin\s+(?:casual|various|several|multiple)\s+roles?\b"
    r"|\bduring (?:my )?placement\b"
    r"|\bacross the industry\b"
    # "in aged care" / "for residents" with no specific anchor following
    r"|\bin aged care\b(?!\s+(?:at|with|across))"
    r"|\bfor residents\b(?!\s+(?:at|across|of [A-Z]))",
    re.IGNORECASE,
)


def _get_summary_prose(lines: list[str], start: int, end: int) -> tuple[list[int], str]:
    """Return (prose_line_indices, joined_prose_text) for a summary block."""
    idx, texts = [], []
    for i, ln in enumerate(lines[start + 1: end], start=start + 1):
        s = ln.strip()
        if s and not s.startswith(("-", "*")):
            idx.append(i)
            texts.append(s)
    return idx, " ".join(texts)


_SUMMARY_HEADING_RE = re.compile(r"^## (Career Highlights|Professional Summary|Summary)$")


def _find_summary_block(lines: list[str]) -> tuple[int, int] | tuple[None, None]:
    start = next((i for i, ln in enumerate(lines) if _SUMMARY_HEADING_RE.match(ln.strip())), None)
    if start is None:
        return None, None
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return start, end


def _enforce_summary_s1_title_case(markdown: str) -> str:
    """Title-case the role-title opener of S1 (words before the first 'with'
    or comma that form the job title).  Fixes "Personal care worker with …"
    → "Personal Care Worker with …"."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    # Split into S1 / rest on first period
    dot = prose.find(".")
    if dot == -1:
        return markdown
    s1, rest = prose[:dot + 1], prose[dot + 1:]
    # Find the role-title token: words up to (but not including) "with" / "–" / ","
    # Capture trailing whitespace separately so we don't lose the space.
    with_match = re.match(r"^(.*?)(\s+)(with|–|-|,)\b", s1, re.IGNORECASE)
    if with_match:
        title_part = with_match.group(1)
        space = with_match.group(2)
        remainder = s1[len(title_part) + len(space):]
        fixed_title = " ".join(w.capitalize() for w in title_part.split())
        new_s1 = fixed_title + space + remainder
    else:
        # Fallback: title-case first 4 words
        words = s1.split()
        words[:4] = [w.capitalize() for w in words[:4]]
        new_s1 = " ".join(words)
    new_prose = new_s1 + rest
    # Write back into the first prose line
    lines[idx[0]] = new_prose
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


def _enforce_summary_s2_word_cap(markdown: str, cap: int = 22) -> str:
    """Hard-trim S2 to at most `cap` words (rule: Sentence 2 ≤22 words)."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    sent_re = re.compile(r"(?<=[.!?])\s+")
    sentences = [s.strip() for s in sent_re.split(prose) if s.strip()]
    if len(sentences) < 2:
        return markdown
    s2 = sentences[1]
    if len(s2.split()) <= cap:
        return markdown
    s2 = _trim_to_words(s2, cap)
    new_prose = sentences[0] + " " + s2
    lines[idx[0]] = new_prose
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


def _flag_vague_anchor(markdown: str) -> str:
    """Replace vague COMPANY ANCHOR phrases with a conspicuous placeholder so
    the issue is visible in the rendered output and triggers a retry in review.
    Does NOT attempt an AI rewrite — that belongs to the retry loop."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx or not _VAGUE_ANCHOR_RE.search(prose):
        return markdown
    fixed = _VAGUE_ANCHOR_RE.sub("[ANCHOR NEEDED]", prose)
    lines[idx[0]] = fixed
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


# Status / education / identity labels the S1 opener must NEVER lead with — the
# opener slot is for the JD-aligned PROFESSIONAL identity only (composition.py
# CAREER HIGHLIGHTS + tailored_cv.py CRITICAL RULE #1). "Aspiring" is
# deliberately NOT here: W1 permits "Aspiring <Role>" for true career-changers
# with zero in-vertical experience, so the enforcer leaves it alone.
_FORBIDDEN_OPENER_RE = re.compile(
    r"^\s*(?:an?\s+)?(?:"
    r"international\s+student|international|"
    r"recent\s+graduate|recent|graduate|"
    r"visa\s+holder|career\s+changer|student|"
    r"certificate|diploma|bachelor|masters?|phd|doctorate"
    r")\b",
    re.IGNORECASE,
)

# Leading seniority adjectives stripped from the JD title before it is used as
# the opener — the SENIORITY WORDS rule forbids a seniority label unless it
# appears in the candidate's own CV titles, and the enforcer cannot verify that.
_SENIORITY_PREFIX_RE = re.compile(
    r"^(?:senior|junior|lead|principal|staff|entry[-\s]level|trainee)\s+",
    re.IGNORECASE,
)


def _clean_job_title(jd_job_title: str) -> str:
    """Sanitise a JD job title for use as the summary opener: drop parenthetical
    abbreviations, a leading seniority adjective, and surplus whitespace. Returns
    "" when nothing usable remains (caller then flags instead of inserting)."""
    if not jd_job_title:
        return ""
    title = re.sub(r"\s*\([^)]*\)", "", jd_job_title)        # drop "(AIN)" etc.
    title = re.sub(r"\s+", " ", title).strip(" -–|,")
    title = _SENIORITY_PREFIX_RE.sub("", title).strip()
    # Guard against junk titles (empty, or an implausibly long phrase that is
    # clearly not a clean role label).
    if not title or len(title.split()) > 6:
        return ""
    return title


def _enforce_summary_opener(markdown: str, jd_job_title: str = "") -> str:
    """If S1 opens with a forbidden status / education / identity label instead
    of a JD-aligned role title, replace the opener with the JD job title. When
    no usable JD title is available, flag with [ROLE TITLE NEEDED] so the failure
    is conspicuous rather than silently shipped.

    Runs AFTER _enforce_summary_s1_title_case so the inserted title keeps the
    JD's own casing (e.g. "Assistant in Nursing", not "Assistant In Nursing")."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    dot = prose.find(".")
    s1 = prose if dot == -1 else prose[: dot + 1]
    rest = "" if dot == -1 else prose[dot + 1:]
    # Split the opener (role-title slot) from the rest of S1 at the first
    # "with"/"having"/dash/comma boundary — matching the "<Role> with …" shape.
    split = re.match(
        r"^(.*?)(\s+(?:with|having|–|-|,)\b.*)$", s1, re.IGNORECASE | re.DOTALL
    )
    opener = split.group(1) if split else s1
    if not _FORBIDDEN_OPENER_RE.match(opener.strip()):
        return markdown
    title = _clean_job_title(jd_job_title)
    replacement = title if title else "[ROLE TITLE NEEDED]"
    if split:
        new_s1 = replacement + split.group(2)
    else:
        # No "with"-style tail: swap only the leading forbidden phrase.
        new_s1 = _FORBIDDEN_OPENER_RE.sub(replacement, s1, count=1)
    lines[idx[0]] = new_s1 + rest
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


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


def _strip_certs_when_projects_exist(markdown: str) -> str:
    """
    If ## Projects is present, remove ## Certifications entirely.
    The prompt rule (projects beat certs) is routinely ignored by the AI;
    this enforces it deterministically.
    """
    lines = markdown.split("\n")
    has_projects = any(ln.strip() == "## Projects" for ln in lines)
    if not has_projects:
        return markdown

    cert_start = next(
        (i for i, ln in enumerate(lines) if ln.strip() == "## Certifications"),
        None,
    )
    if cert_start is None:
        return markdown

    cert_end = next(
        (i for i in range(cert_start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return "\n".join(lines[:cert_start] + lines[cert_end:])


def _dedup_career_highlights(markdown: str) -> str:
    """
    If the AI emitted ## Career Highlights twice (prose then bullets),
    keep only the first occurrence and drop the second block entirely.
    """
    HEADING = "## Career Highlights"
    lines = markdown.split("\n")
    positions = [i for i, ln in enumerate(lines) if ln.strip() == HEADING]
    if len(positions) < 2:
        return markdown

    second_start = positions[1]
    second_end = len(lines)
    for i in range(second_start + 1, len(lines)):
        if lines[i].startswith("## "):
            second_end = i
            break

    return "\n".join(lines[:second_start] + lines[second_end:])


def _enforce_education_count(markdown: str, max_entries: int = 3) -> str:
    """Cap Education section to max_entries degree blocks (h3 + optional italic line)."""
    EDU_HEADING = "## Education"
    lines = markdown.split("\n")

    edu_start = next((i for i, l in enumerate(lines) if l.strip() == EDU_HEADING), None)
    if edu_start is None:
        return markdown

    edu_end = len(lines)
    for i in range(edu_start + 1, len(lines)):
        if lines[i].startswith("## "):
            edu_end = i
            break

    body_lines = lines[edu_start + 1 : edu_end]

    entry_count = 0
    cutoff = len(body_lines)
    for i, line in enumerate(body_lines):
        if line.startswith("### "):
            entry_count += 1
            if entry_count > max_entries:
                cutoff = i
                break

    return "\n".join(lines[: edu_start + 1] + body_lines[:cutoff] + lines[edu_end:])


def _strip_education_bullets(markdown: str) -> str:
    """
    Defensive post-processor: strip bullets from the Education section.

    The prompt instructs the LLM to emit each degree as a two-line block
    (### Institution | Location ↵ *Degree | Year*) and explicitly forbids
    bullets under degrees. But LLMs occasionally hallucinate filler bullets
    like "Leveraged this program to navigate higher education data
    requirements…" which is content the model invented to pad the entry.

    The renderer's two-column row layout also can't align bullets — they
    sit awkwardly between two formatted rows.

    Strategy: inside ## Education only, drop any line that starts with a
    bullet marker (-, *, •). Keep the H3 headings and the italic subtitle
    lines. Stop at the next ## section.
    """
    EDU_HEADING = "## Education"
    lines = markdown.split("\n")

    edu_start = next((i for i, l in enumerate(lines) if l.strip() == EDU_HEADING), None)
    if edu_start is None:
        return markdown

    edu_end = len(lines)
    for i in range(edu_start + 1, len(lines)):
        if lines[i].startswith("## "):
            edu_end = i
            break

    cleaned: list[str] = []
    bullet_re = re.compile(r"^\s*[-*•]\s+")
    for line in lines[edu_start + 1 : edu_end]:
        if bullet_re.match(line):
            continue  # drop the bullet line
        cleaned.append(line)

    # Collapse runs of >2 blank lines that may have been left behind.
    out: list[str] = []
    blank_run = 0
    for line in cleaned:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= 2:
                out.append(line)
        else:
            blank_run = 0
            out.append(line)

    return "\n".join(lines[: edu_start + 1] + out + lines[edu_end:])


# ---------------------------------------------------------------------------
# Deterministic Skills-section keyword injector
#
# The feasibility-classifier flags some keywords as "inject_directly" with
# target=skills_section. The AI is supposed to put them in ## Skills, but it
# occasionally misses one. Rather than tightening the prompt indefinitely, we
# enforce these deterministically: any approved skills-targeted keyword that
# isn't present in the Skills section gets appended to the appropriate
# category line. Bullet mentions don't count — recruiters scan the Skills
# line specifically.
# ---------------------------------------------------------------------------

# Maps the feasibility classifier's category enum to the Skills line label.
# This is the UNIVERSAL (family-agnostic) map. Pass ``family_label_map`` to
# ``_inject_missing_skills`` to override for a specific role family (e.g.
# nursing maps domain_knowledge → "**Care Skills:**" not "**Other Skills:**").
_SKILLS_CATEGORY_LABEL: dict[str, str] = {
    "technical": "**Technical Skills:**",
    "soft_skills": "**Soft Skills:**",
    "domain_knowledge": "**Other Skills:**",
}


def build_family_label_map(rf) -> dict[str, str]:
    """Convert a RoleFamilyProfile's category_labels to the bold "**Label:**"
    format expected by ``_inject_missing_skills``.

    ``category_labels(rf)`` returns e.g. ``{"domain_knowledge": "Care Skills",
    "soft_skills": "Soft Skills", "technical": "Other Skills"}`` for nursing.
    This function converts that to ``{"domain_knowledge": "**Care Skills:**",
    ...}`` so the injector can match against actual Skills section lines.
    """
    from app.services.eval.role_families import category_labels
    return {cat: f"**{label}:**" for cat, label in category_labels(rf).items()}


def _kw_in_skills(keyword: str, skills_text_lower: str) -> bool:
    """
    Word-boundary check with simple plural/singular tolerance, scoped to the
    Skills section text only. Returns True if the keyword (or its near-form)
    is already listed.
    """
    kw = keyword.lower().strip()
    if not kw:
        return True  # nothing to inject
    pattern = r"\b" + re.escape(kw) + r"s?\b"
    if re.search(pattern, skills_text_lower):
        return True
    if kw.endswith("s") and len(kw) > 3:
        # plural keyword — also accept singular form already present
        pattern_sg = r"\b" + re.escape(kw[:-1]) + r"\b"
        if re.search(pattern_sg, skills_text_lower):
            return True
    return False


def _format_skill_label(keyword: str) -> str:
    """
    Title-case multi-word keywords while preserving acronyms (SQL, AWS, GA4).
    e.g. 'spreadsheets' -> 'Spreadsheets', 'data warehouse' -> 'Data Warehouse'.
    """
    parts = keyword.strip().split()
    out: list[str] = []
    for p in parts:
        if len(p) > 1 and p.isupper():
            out.append(p)
        elif any(ch.isdigit() for ch in p):
            out.append(p)  # preserve "ga4", "yolov8", "ml/ai" etc.
        else:
            out.append(p[:1].upper() + p[1:].lower())
    return " ".join(out)


def _inject_missing_skills(
    markdown: str,
    feasibility: dict | None,
    *,
    family_label_map: dict[str, str] | None = None,
) -> str:
    """
    Append any inject_directly keyword (target=skills_section) that's missing
    from the Skills section, and any inject_as_extension / inject_with_inference
    keyword that is completely missing from the entire CV text, to the appropriate
    Skills category line. AI-free.

    ``family_label_map`` is a {category_key: "**Label:**"} dict that overrides
    the default ``_SKILLS_CATEGORY_LABEL`` for the current role family. Pass
    the output of ``category_labels(rf)`` (from role_families.py) converted to
    bold-label form to make the injector family-aware. When None, the legacy
    universal label map is used (backward-compatible).

    Why this matters: for nursing, ``domain_knowledge`` maps to ``"Care Skills"``
    (the headline), NOT ``"Other Skills"`` (which is what the universal map says).
    Without this override, inject_directly domain keywords (e.g. ``wound care``,
    ``continence care``) land on the Other Skills line instead of Care Skills.
    """
    markdown = _split_compound_skills(markdown)
    plan = (feasibility or {}).get("feasibility_plan") or {}

    # Collect all approved items from the three feasibility categories
    approved_entries = []
    for bucket in ("inject_directly", "inject_as_extension", "inject_with_inference"):
        entries = plan.get(bucket) or []
        if isinstance(entries, list):
            approved_entries.extend(entries)

    if not approved_entries:
        return markdown

    lines = markdown.split("\n")

    # Locate the Skills section
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip() == "## Skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown  # no Skills section present, nothing to do

    from app.services.pipeline.steps.tailored_rescoring import _kw_present

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    markdown_lower = markdown.lower()

    targets: list[tuple[str, str]] = []  # (keyword, category)
    for entry in approved_entries:
        if not isinstance(entry, dict):
            continue
        kw = str(entry.get("keyword") or "").strip()
        cat = str(entry.get("category") or "").strip()
        target = str(entry.get("injection_target") or "").strip().lower()
        if not kw or not cat:
            continue

        # Rule:
        # 1. If target is specifically skills_section, check if it's in the Skills section.
        # 2. For bullet or other targets, check if it is present anywhere in the entire CV.
        #    If it's not present anywhere, we fallback to injecting it into the Skills section.
        if target == "skills_section":
            if not _kw_in_skills(kw, skills_text_lower):
                targets.append((kw, cat))
        else:
            if not _kw_present(kw, markdown_lower):
                targets.append((kw, cat))

    if not targets:
        return markdown

    # Use the caller-supplied family label map when available; fall back to the
    # universal map so existing callers that don't supply one still work.
    effective_label_map = family_label_map if family_label_map is not None else _SKILLS_CATEGORY_LABEL

    # Map each category to its line index within the Skills section, using the
    # family-specific label map so nursing's "Care Skills" label is recognised.
    cat_to_line_idx: dict[str, int] = {}
    for i in range(skills_start + 1, skills_end):
        # Tolerate an optional leading list bullet ("- ", "* ", "• ") that the
        # renderer-facing prefix may have stamped on the category line.
        stripped = re.sub(r"^[-*•]\s+", "", lines[i].lstrip())
        for cat, label in effective_label_map.items():
            if stripped.startswith(label):
                cat_to_line_idx[cat] = i
                break

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()

    # Lazy import to avoid circular dependency — writers.py imports from this
    # module. _is_non_skill_phrase encodes the same blocklist used by
    # _surface_matched_skills + _inject_approved_skills; this injector was the
    # only one missing the guard, which is why approved-but-junk keywords
    # ("Residential Care", "Aged Care Delivery") were dumped into Skills only
    # to be scrubbed later by _strip_non_skill_phrases. Skipping them up front
    # prevents the leak at source.
    from app.services.eval.writers import _is_non_skill_phrase

    appended_count = 0
    skipped_junk = 0
    for kw, cat in targets:
        if _kw_in_skills(kw, skills_text_lower):
            continue
        if _is_non_skill_phrase(kw):
            skipped_junk += 1
            continue
        target_idx = cat_to_line_idx.get(cat) or cat_to_line_idx.get("domain_knowledge")
        if target_idx is None:
            continue  # no matching category line and no Other Skills fallback
        display = _format_skill_label(kw)
        existing = lines[target_idx].rstrip()
        # Append with a comma + space; works whether or not the line uses ` | `
        # sub-groups, since we always append to the FINAL group.
        lines[target_idx] = f"{existing}, {display}"
        appended_count += 1
        # Update the lower-cased blob so subsequent checks see the new addition
        skills_text_lower = skills_text_lower + ", " + display.lower()

    if appended_count or skipped_junk:
        logger.info(
            "Deterministic skills injector: appended %d, skipped %d non-skill phrase(s)",
            appended_count, skipped_junk,
        )

    return "\n".join(lines)


def _enforce_structure(markdown: str, jd_job_title: str = "") -> str:
    """
    Deterministic post-processing:
      - Deduplicate Career Highlights (keep prose, drop bullet repeat)
      - Professional Experience: max 3 roles; bullets 1+2 ≤32 words, bullet 3 ≤12 words
      - Projects: max 2 entries; bullet 1 ≤32 words, bullet 2 ≤14 words

    `jd_job_title` (when supplied) lets the S1-opener enforcer replace a
    forbidden status/education opener with the real JD-aligned role title.
    """
    markdown = _dedup_project_bullets(markdown)
    markdown = _strip_certs_when_projects_exist(markdown)
    markdown = _dedup_career_highlights(markdown)
    markdown = _enforce_education_count(markdown, max_entries=3)
    markdown = _strip_education_bullets(markdown)
    markdown = _enforce_career_highlights_words(markdown, max_words=50)
    markdown = _flag_vague_anchor(markdown)
    markdown = _enforce_summary_s2_word_cap(markdown, cap=22)
    markdown = _enforce_summary_s1_title_case(markdown)
    markdown = _enforce_summary_opener(markdown, jd_job_title)
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
        sections.append((start, end, heading.strip()))

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


def _upload_to_storage(user_id: uuid.UUID, run_id: uuid.UUID, markdown: str) -> str:
    settings = get_settings()
    supabase = get_supabase()

    storage_path = f"{user_id}/{run_id}.md"
    bucket = settings.SUPABASE_TAILORED_CV_BUCKET

    # supabase-py upload accepts bytes
    payload = markdown.encode("utf-8")
    try:
        supabase.storage.from_(bucket).upload(
            path=storage_path,
            file=payload,
            file_options={"content-type": "text/markdown", "upsert": "true"},
        )
    except Exception as exc:
        # If the file already exists, try update instead
        logger.warning("Tailored CV upload failed (%s) — retrying with update()", exc)
        supabase.storage.from_(bucket).update(
            path=storage_path,
            file=payload,
            file_options={"content-type": "text/markdown"},
        )

    return storage_path
