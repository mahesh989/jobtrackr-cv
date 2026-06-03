"""
Step 6.6 — Deterministic structural validation of the tailored CV.

After the AI writer has produced the tailored markdown, we run a series of
pure-function "gates" over the document. Each gate checks one structural
rule from the STRUCTURAL CONTRACT in TAILORED_CV_SYSTEM. The output is a
report — never a rewrite. The pipeline never fails on a structural gate;
gates only emit pass / warn / fail labels for the user to inspect.

Why deterministic and not another AI call?
  - The shape of the output is independent of any model judgement; we can
    parse it directly.
  - It produces a stable, reproducible signal we can show the user when
    the writer drifted from the contract.
  - It costs nothing (no tokens) and adds milliseconds, not seconds.

The gates are intentionally narrow — each one tests exactly ONE rule, so
the report is easy to interpret. They never overlap with the rescoring
step's keyword-presence checks (`tailored_rescoring.py`) or with the
fabrication detector (`fabricated_keywords`).

Output shape:
    {
      "gates": [
        {"name": str, "status": "pass" | "warn" | "fail", "detail": str}
      ],
      "summary": {"total": int, "pass": int, "warn": int, "fail": int}
    }
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# Words the writer is allowed to use in the Profile only if they are
# literally present in the candidate's CV job titles (per the
# SENIORITY LITERAL-MATCH RULE in the prompt).
_SENIORITY_TOKENS = (
    "senior",
    "lead",
    "principal",
    "staff",
    "manager",
    "director",
)

# Heuristic for "this bullet contains a metric". Catches:
#   - "10%"  "12.5%"  "$2M"  "300+"  "5x"
#   - "3-5 reports"  "10M records"  "12 months"  "$500k"
#   - "8 dashboards", "two e-commerce retailers" (number words excluded —
#     too many false positives; we use digits as the signal).
_METRIC_PATTERN = re.compile(
    r"""
    \$\s*\d                                         # currency e.g. $2, $500k
    | \b\d+(?:\.\d+)?\s*%                           # percentage
    | \b\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?        # ranges 3-5, 10–12
    | \b\d+(?:\.\d+)?\s*\+                          # 300+
    | \b\d+(?:\.\d+)?\s*[kKmMbB]\b                  # 10k, 2M, 1B
    | \b\d+\s*x\b                                   # 5x
    | \b\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?|months?|years?
                          |seconds?|minutes?
                          |users?|customers?|records?|rows?
                          |stores?|countries?|teams?|reports?
                          |dashboards?|stakeholders?|clients?
                          |websites?|projects?)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Section names we recognise (case-insensitive). The first match wins.
_PROFILE_ALIASES = ("career highlights", "highlights",
                    "professional summary", "professional profile",
                    "career profile", "profile", "summary")
_EXPERIENCE_ALIASES = ("experience", "work experience",
                       "professional experience")
_EDUCATION_ALIASES = ("education",)
_PROJECTS_ALIASES = ("projects", "personal projects", "side projects")
_SKILLS_ALIASES = ("skills", "technical skills", "core skills")


def run_tailored_structural_validation(
    tailored_markdown: str,
    original_cv_text: str = "",
    jd_analysis: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Top-level entry point. Returns a structural report dict — never raises.

    `jd_analysis` is the step-1 JD analysis output; passing it enables the
    relevance-gates (degree relevance, project relevance) which need a JD
    vocabulary to score against. Omitting it makes those gates skip with
    a "pass" status (graceful degradation).
    """
    try:
        sections = _split_sections(tailored_markdown or "")
        jd_vocab = _build_jd_vocabulary(jd_analysis or {})

        # Family-aware expected Skills categories. The first label varies by
        # role family ("Technical Skills" for tech, "Care Skills" for nursing,
        # "Core Skills" for manual). The gate fails harmlessly for tech CVs if
        # we omit this — its hardcoded {Technical, Soft, Other} was never going
        # to pass nursing or manual CVs.
        expected_skills_labels = _resolve_expected_skills_labels(jd_analysis)

        gates: List[Dict[str, Any]] = [
            _gate_profile_word_count(sections),
            _gate_seniority_literal_match(sections, original_cv_text),
            _gate_experience_role_count(sections),
            _gate_education_count(sections),
            _gate_projects_count(sections),
            _gate_bullets_per_entry(sections),
            _gate_highlights_no_bullets(sections),
            _gate_experience_bullet_length(sections),
            _gate_period_terminator(sections),
            _gate_metric_coverage(sections),
            _gate_skills_min_per_category(sections, expected_skills_labels),
            _gate_highlights_prose_shape(sections),
            _gate_highlights_reference_check(sections),
            _gate_degree_relevance(sections, jd_vocab),
            _gate_project_relevance(sections, jd_vocab),
            _gate_education_entry_shape(sections),
            _gate_project_entry_shape(sections),
        ]

        summary = {
            "total": len(gates),
            "pass":  sum(1 for g in gates if g["status"] == "pass"),
            "warn":  sum(1 for g in gates if g["status"] == "warn"),
            "fail":  sum(1 for g in gates if g["status"] == "fail"),
        }
        return {"gates": gates, "summary": summary}
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("Structural validation crashed: %s", exc)
        return {
            "gates": [],
            "summary": {"total": 0, "pass": 0, "warn": 0, "fail": 0},
            "error": f"validator_crashed: {exc}",
        }


# ---------------------------------------------------------------------------
# Markdown parsing helpers
# ---------------------------------------------------------------------------


def _split_sections(md: str) -> Dict[str, str]:
    """
    Split a markdown CV into {normalised_section_name: body_text}.

    Section name is the text after the level-2 heading, lowercased and
    whitespace-trimmed. Anything before the first ## heading (the contact
    block) is stored under the key "_preamble".
    """
    sections: Dict[str, str] = {}
    current_name = "_preamble"
    current_body: List[str] = []
    for line in md.splitlines():
        stripped = line.strip()
        # Section break only on ## headings, not deeper.
        if stripped.startswith("## ") and not stripped.startswith("### "):
            sections[current_name] = "\n".join(current_body).strip()
            current_name = stripped[3:].strip().lower()
            current_body = []
        else:
            current_body.append(line)
    sections[current_name] = "\n".join(current_body).strip()
    return sections


def _resolve_section(sections: Dict[str, str], aliases: Tuple[str, ...]) -> str:
    for alias in aliases:
        if alias in sections:
            return sections[alias]
    return ""


def _parse_entries(section_body: str) -> List[Dict[str, Any]]:
    """
    Parse an Experience or Projects section into discrete entries.

    An entry starts at an h3 heading (### ...) and runs through any
    subsequent subtitle lines and bullet lines until the next h3 heading.
    The italic subtitle line (*Title | Dates*) that follows the h3 heading
    is treated as part of the same entry — NOT as a separate entry.

    Returns: [{"title_line": str, "bullets": [str, ...]}, ...]
    """
    entries: List[Dict[str, Any]] = []
    current_title: str | None = None
    current_bullets: List[str] = []

    bullet_re = re.compile(r"^\s*[-•*]\s+(.*)$")
    # Matches italic subtitle lines like: *Data Analyst | July 2024 – Present*
    subtitle_re = re.compile(r"^\s*\*[^*]+\*\s*$")

    def _flush() -> None:
        if current_title is not None:
            entries.append({
                "title_line": current_title,
                "bullets":    list(current_bullets),
            })

    for raw in section_body.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        m = bullet_re.match(raw)
        if m:
            if current_title is None:
                # Orphan bullet without a preceding title — ignore.
                continue
            current_bullets.append(m.group(1).strip())
        elif subtitle_re.match(raw):
            # Italic subtitle line (e.g. *Title | Dates*) — belongs to
            # the current entry, not a new one. Skip silently.
            continue
        else:
            _flush()
            current_title = stripped
            current_bullets = []

    _flush()
    return entries


def _word_count(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------


def _gate_profile_word_count(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights = 2 sentences of prose (positioning + achievement).
    Healthy total is 35-60 words. No bullets, no skills line.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "profile_word_count", "fail",
            "No ## Career Highlights section detected.",
        )
    n = _word_count(body)
    if n < 25:
        return _result(
            "profile_word_count", "fail",
            f"Career Highlights is only {n} words — far too thin.",
        )
    if n < 35:
        return _result(
            "profile_word_count", "warn",
            f"Career Highlights is only {n} words (target 35-60).",
        )
    if n > 80:
        return _result(
            "profile_word_count", "fail",
            f"Career Highlights is {n} words (hard cap 60, absolute max 80).",
        )
    if n > 60:
        return _result(
            "profile_word_count", "warn",
            f"Career Highlights is {n} words — getting padded (target 35-60).",
        )
    return _result(
        "profile_word_count", "pass",
        f"Career Highlights is {n} words.",
    )


def _gate_seniority_literal_match(
    sections: Dict[str, str], original_cv_text: str,
) -> Dict[str, Any]:
    """
    If the Profile uses a seniority token, that exact word must also
    appear somewhere in the original CV text. Otherwise it is a likely
    fabrication.

    Reported as WARN (not fail) because edge cases exist where the user
    legitimately describes themselves at one level higher in plain prose
    elsewhere; a human should make the call.
    """
    profile = _resolve_section(sections, _PROFILE_ALIASES)
    if not profile:
        return _result(
            "seniority_literal_match", "warn",
            "No Profile section to check.",
        )
    profile_lower = profile.lower()
    cv_lower = (original_cv_text or "").lower()
    flagged: List[str] = []
    for token in _SENIORITY_TOKENS:
        in_profile = re.search(rf"\b{token}\b", profile_lower) is not None
        in_cv = re.search(rf"\b{token}\b", cv_lower) is not None
        if in_profile and not in_cv:
            flagged.append(token)
    if flagged:
        return _result(
            "seniority_literal_match", "warn",
            f"Profile uses {', '.join(flagged)} but the original CV "
            "does not contain those words — verify the seniority claim.",
        )
    return _result(
        "seniority_literal_match", "pass",
        "No seniority words appear in the Profile that aren't in the CV.",
    )


def _gate_experience_role_count(sections: Dict[str, str]) -> Dict[str, Any]:
    body = _resolve_section(sections, _EXPERIENCE_ALIASES)
    entries = _parse_entries(body)
    n = len(entries)
    if n == 0:
        return _result(
            "experience_role_count", "fail",
            "No experience entries detected.",
        )
    if n > 3:
        return _result(
            "experience_role_count", "warn",
            f"{n} experience roles (target 1-3).",
        )
    return _result(
        "experience_role_count", "pass",
        f"{n} experience role(s).",
    )


def _gate_education_count(sections: Dict[str, str]) -> Dict[str, Any]:
    body = _resolve_section(sections, _EDUCATION_ALIASES)
    if not body:
        return _result(
            "education_count", "warn",
            "No education section detected.",
        )
    # Education entries may not have bullets; count by blank-line separation.
    blocks = [b.strip() for b in re.split(r"\n\s*\n", body) if b.strip()]
    n = len(blocks)
    if n == 0:
        return _result(
            "education_count", "fail",
            "Education section is empty.",
        )
    if n > 3:
        return _result(
            "education_count", "warn",
            f"{n} education entries (target 1-3).",
        )
    return _result(
        "education_count", "pass",
        f"{n} education entry/entries.",
    )


def _gate_projects_count(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Projects target is now 1-2 when the candidate has any JD-relevant
    projects. The validator can't decide JD-relevance from the markdown
    alone, so it only complains about hard count violations:
      - 0 projects                → soft warn (might be a legit cut)
      - 3+ projects               → warn (target is 1-2)
      - more than 4               → fail (overweight)
    """
    body = _resolve_section(sections, _PROJECTS_ALIASES)
    if not body:
        return _result(
            "projects_count", "warn",
            "No Projects section. If the candidate has JD-relevant "
            "projects, prefer including 1-2 of them over a "
            "Certifications section.",
        )
    entries = _parse_entries(body)
    n = len(entries)
    if n > 4:
        return _result(
            "projects_count", "fail",
            f"{n} projects — target is 1-2.",
        )
    if n > 2:
        return _result(
            "projects_count", "warn",
            f"{n} projects (target 1-2).",
        )
    return _result(
        "projects_count", "pass",
        f"{n} project(s).",
    )


def _gate_bullets_per_entry(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every Experience role and every Project entry must have 2-3 bullets.
    """
    issues: List[str] = []
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            total += 1
            n = len(entry["bullets"])
            if n < 2 or n > 3:
                issues.append(
                    f"{_short(entry['title_line'])}: {n} bullet(s)"
                )
    if total == 0:
        return _result(
            "bullets_per_entry", "warn",
            "No experience or project entries found.",
        )
    if issues:
        return _result(
            "bullets_per_entry", "fail",
            "Entries outside 2-3 bullet target: "
            + "; ".join(issues[:3])
            + (f" (+{len(issues) - 3} more)" if len(issues) > 3 else ""),
        )
    return _result(
        "bullets_per_entry", "pass",
        f"All {total} entry/entries have 2-3 bullets.",
    )


def _gate_highlights_no_bullets(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights must be prose-only — no bullet points allowed.
    The new format is exactly 2 sentences with no list markers.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "highlights_no_bullets", "warn",
            "No Career Highlights section to check.",
        )

    bullet_re = re.compile(r"^\s*[-•*]\s+(.*)$")
    bullets: List[str] = []
    for raw in body.splitlines():
        m = bullet_re.match(raw)
        if m:
            bullets.append(m.group(1).strip())

    if bullets:
        return _result(
            "highlights_no_bullets", "fail",
            f"Career Highlights contains {len(bullets)} bullet point(s) — "
            "must be prose only (2 sentences, no list markers).",
        )
    return _result(
        "highlights_no_bullets", "pass",
        "Career Highlights is prose-only — no bullets detected.",
    )


def _gate_experience_bullet_length(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Experience and Project bullets target 18-30 words. Anything beyond 30
    words is a soft warn — the bullet has gone run-on and should be split
    or trimmed. Hard fails reserved for >40 words (truly unreadable).
    """
    issues_warn: List[str] = []
    issues_fail: List[str] = []
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            for bullet in entry["bullets"]:
                total += 1
                w = _word_count(bullet)
                if w > 40:
                    issues_fail.append(f"{w}w: '{bullet[:50]}…'")
                elif w > 30:
                    issues_warn.append(f"{w}w: '{bullet[:50]}…'")

    if total == 0:
        return _result(
            "experience_bullet_length", "warn",
            "No Experience/Project bullets to check.",
        )
    if issues_fail:
        return _result(
            "experience_bullet_length", "fail",
            "Run-on bullets (>40w): "
            + "; ".join(issues_fail[:3])
            + (f" (+{len(issues_fail) - 3} more)" if len(issues_fail) > 3 else ""),
        )
    if issues_warn:
        return _result(
            "experience_bullet_length", "warn",
            f"{len(issues_warn)} of {total} bullets over 30 words: "
            + "; ".join(issues_warn[:3])
            + (f" (+{len(issues_warn) - 3} more)" if len(issues_warn) > 3 else ""),
        )
    return _result(
        "experience_bullet_length", "pass",
        f"All {total} Experience/Project bullets within 18-30 word target.",
    )


def _gate_period_terminator(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every bullet must end with terminal punctuation (. ! ?).
    """
    missing = 0
    total = 0
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            for bullet in entry["bullets"]:
                total += 1
                # Strip trailing markdown formatting characters before
                # checking the terminator.
                tail = bullet.rstrip().rstrip("*_`)\"'")
                if not tail.endswith((".", "!", "?")):
                    missing += 1
    if total == 0:
        return _result(
            "period_terminator", "warn",
            "No bullets to check.",
        )
    if missing == 0:
        return _result(
            "period_terminator", "pass",
            f"All {total} bullets end with terminal punctuation.",
        )
    if missing / total > 0.2:
        return _result(
            "period_terminator", "fail",
            f"{missing} of {total} bullets lack terminal punctuation.",
        )
    return _result(
        "period_terminator", "warn",
        f"{missing} of {total} bullets lack terminal punctuation.",
    )


def _gate_metric_coverage(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Soft target: 60% of bullets across Experience + Projects carry a metric.

    NEVER returns "fail". The whole point of the soft target is to avoid
    pressuring the writer to fabricate numbers; we only warn if coverage
    is conspicuously low (< 40%).
    """
    bullets: List[str] = []
    for sec_aliases in (_EXPERIENCE_ALIASES, _PROJECTS_ALIASES):
        body = _resolve_section(sections, sec_aliases)
        for entry in _parse_entries(body):
            bullets.extend(entry["bullets"])
    if not bullets:
        return _result(
            "metric_coverage", "warn",
            "No bullets to check.",
        )
    with_metric = sum(1 for b in bullets if _METRIC_PATTERN.search(b))
    pct = with_metric / len(bullets)
    detail = (
        f"{with_metric}/{len(bullets)} bullets carry a metric "
        f"({pct:.0%}; soft target 60%)."
    )
    if pct < 0.4:
        return _result("metric_coverage", "warn", detail)
    return _result("metric_coverage", "pass", detail)


def _resolve_expected_skills_labels(jd_analysis: Dict[str, Any] | None) -> set[str]:
    """Pick the expected Skills-section category labels for the role family.

    Reads `category_labels` (a 3-element list) that the orchestrator attaches
    to `jd_analysis` after running `resolve_role_family`. Falls back to the
    tech-shaped {Technical, Soft, Other} set when no family is attached
    (legacy resumes / unknown vertical).
    """
    fallback = {"technical skills", "soft skills", "other skills"}
    if not jd_analysis:
        return fallback
    labels = jd_analysis.get("category_labels")
    if not isinstance(labels, list) or len(labels) < 3:
        return fallback
    return {str(lbl).lower().strip() for lbl in labels if isinstance(lbl, str) and lbl.strip()}


def _gate_skills_min_per_category(
    sections: Dict[str, str], expected: set[str]
) -> Dict[str, Any]:
    """
    The ## Skills section must use the three category labels appropriate for
    the role family — Technical/Soft/Other for tech, Care/Soft/Other for
    nursing, Core/Soft/Other for manual — and each line should carry at
    least 3 skills (sub-groups separated by ` | ` are flattened for the
    count).
    """
    body = _resolve_section(sections, _SKILLS_ALIASES)
    if not body:
        return _result(
            "skills_min_per_category", "warn",
            "No skills section detected.",
        )

    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]

    found_categories: List[str] = []
    issues: List[str] = []

    for line in lines:
        # Strip stray bullets and bold markers around the label.
        line = line.lstrip("-•* ").strip()
        # Strip leading **...:** so we can read the label cleanly.
        m_bold = re.match(r"^\*\*([^*]+)\*\*\s*(.*)$", line)
        if m_bold:
            label_part = m_bold.group(1).rstrip(":").strip()
            rest = m_bold.group(2).lstrip(": ").strip()
        elif ":" in line:
            label_part, rest = line.split(":", 1)
            label_part = label_part.strip()
            rest = rest.strip()
        else:
            continue

        found_categories.append(label_part.lower())

        # Flatten sub-groups separated by " | ", then split by comma.
        flat = rest.replace(" | ", ", ")
        skills = [s.strip() for s in flat.split(",") if s.strip()]
        if len(skills) < 3:
            issues.append(f"{label_part}: {len(skills)} skill(s)")

    if not found_categories:
        return _result(
            "skills_min_per_category", "fail",
            "Skills section has no 'Category: skill, skill' lines.",
        )

    missing = expected - set(found_categories)
    extra = set(found_categories) - expected

    detail_bits: List[str] = []
    if missing:
        detail_bits.append(
            "missing required categories: " + ", ".join(sorted(missing))
        )
    if extra:
        detail_bits.append(
            "non-standard categories: " + ", ".join(sorted(extra))
        )
    if issues:
        detail_bits.append(
            "categories with <3 skills: " + "; ".join(issues[:3])
        )

    if missing or issues:
        status = "fail" if missing else "warn"
        return _result(
            "skills_min_per_category", status,
            "; ".join(detail_bits),
        )
    if extra:
        return _result(
            "skills_min_per_category", "warn",
            "; ".join(detail_bits),
        )
    return _result(
        "skills_min_per_category", "pass",
        f"All 3 standard categories present, each with 3+ skills.",
    )


def _gate_highlights_prose_shape(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights must be exactly 2 sentences of prose.
    No skills line (*Skills: ...*) allowed.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "highlights_prose_shape", "warn",
            "No Career Highlights section to check.",
        )

    issues: List[str] = []

    # Check for banned skills line
    skills_line_re = re.compile(r"^\s*\*\s*Skills\s*:", re.IGNORECASE)
    for raw in body.splitlines():
        if skills_line_re.match(raw.strip()):
            issues.append("Contains a '*Skills: ...*' line — remove it")
            break

    # Count sentences heuristically: split on period-space or period-end,
    # ignoring common abbreviations and decimal numbers.
    # Strip the skills line (if present) before counting.
    prose = body
    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith("*") and "skills" in stripped.lower():
            prose = prose.replace(raw, "")

    # Sentence boundary: a period followed by a space+uppercase letter
    # or end of string. Also count ? and ! as terminators.
    # Exclude common abbreviations that contain periods.
    clean = re.sub(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|vs|etc|e\.g|i\.e)\.", "ABBR", prose)
    sentences = re.split(r'[.!?](?:\s+[A-Z]|\s*$)', clean.strip())
    # Filter out empty fragments
    sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 5]
    n_sentences = len(sentences)

    if n_sentences < 2:
        issues.append(f"Only {n_sentences} sentence(s) detected — need exactly 2")
    elif n_sentences > 2:
        issues.append(f"{n_sentences} sentences detected — need exactly 2")

    if issues:
        return _result(
            "highlights_prose_shape", "fail",
            "; ".join(issues),
        )
    return _result(
        "highlights_prose_shape", "pass",
        "Career Highlights has 2 sentences, no skills line — correct shape.",
    )


def _gate_highlights_reference_check(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every Capitalised multi-word noun phrase used in Career Highlights
    (project names, product names, employers, technologies) must also
    appear somewhere in the body of the tailored CV (Experience,
    Projects, Skills, Education, Certifications). If not, the Highlights
    is referencing a "ghost" — content the AI dropped from the body.

    Heuristic — looks for tokens that match:
      - Capitalised phrases of 2+ words ("CV Agent", "YOLOv8n", "Power BI")
      - All-caps tokens of 3+ chars  ("ATS", "AWS")
      - Slash/hyphen-joined tech    ("Flutter/Dart")
    Common verbs and stop-cap words are excluded.
    """
    profile = _resolve_section(sections, _PROFILE_ALIASES)
    if not profile:
        return _result(
            "highlights_reference_check", "warn",
            "No Career Highlights to cross-check.",
        )

    body_blob = "\n".join(
        _resolve_section(sections, aliases)
        for aliases in (
            _EXPERIENCE_ALIASES, _PROJECTS_ALIASES,
            _SKILLS_ALIASES,     _EDUCATION_ALIASES,
            ("certifications",),
            # Family-specific sections that exist outside tech: nursing CVs
            # cite awards / registration credentials that DO live in the
            # body but in sections this gate didn't scan. Without these,
            # the gate falsely flags "Staff Excellence Award" as a ghost
            # reference (it's in ## Awards, not ## Experience).
            ("awards", "honours", "honors", "recognition"),
            ("registration & licences", "registration", "licences",
             "registrations", "licenses"),
        )
    )
    body_lower = body_blob.lower()

    # Ignore noise: months, generic action words, common adjectives.
    stopcaps = {
        "data", "analyst", "engineer", "developer", "scientist", "manager",
        "lead", "senior", "principal", "staff", "director",
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct",
        "nov", "dec", "delivered", "built", "improved", "enhanced",
        "optimised", "optimized", "automated", "managed", "designed",
        "shipped", "migrated", "mentored", "skills", "technical", "soft",
        "other", "career", "highlights", "professional", "experience",
        "education", "projects", "certifications",
    }

    candidates: List[str] = []
    # Multi-word Capitalised phrases (e.g. "CV Agent", "Power BI",
    # "Charles Darwin University"). Allow & and digits inside.
    multi_re = re.compile(
        r"\b([A-Z][\w&]*(?:\s+[A-Z][\w&]*){1,3})\b"
    )
    for m in multi_re.finditer(profile):
        token = m.group(1).strip()
        # Skip if every word is in stopcaps
        words = [w.lower() for w in re.split(r"\s+", token)]
        if all(w in stopcaps for w in words):
            continue
        candidates.append(token)

    # All-caps acronyms (3+ chars, optionally with digits)
    acro_re = re.compile(r"\b([A-Z]{3,}\d*)\b")
    for m in acro_re.finditer(profile):
        token = m.group(1)
        if token.lower() in stopcaps:
            continue
        candidates.append(token)

    # Slash/hyphen tech tokens — keep as-is for matching
    slash_re = re.compile(r"\b(\w+/\w+(?:/\w+)?)\b")
    for m in slash_re.finditer(profile):
        candidates.append(m.group(1))

    if not candidates:
        return _result(
            "highlights_reference_check", "pass",
            "No proper-noun references in Career Highlights to verify.",
        )

    # Dedupe while preserving order
    seen: set[str] = set()
    unique = [c for c in candidates if not (c.lower() in seen or seen.add(c.lower()))]

    missing = [c for c in unique if c.lower() not in body_lower]
    if missing:
        return _result(
            "highlights_reference_check", "fail",
            "Highlights references not found in CV body: "
            + ", ".join(missing[:5])
            + (f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""),
        )
    return _result(
        "highlights_reference_check", "pass",
        f"All {len(unique)} Highlights references present in the body.",
    )


# ---------------------------------------------------------------------------
# Relevance gates — use JD vocabulary to flag off-topic Education / Projects
# ---------------------------------------------------------------------------

# Glue words and obvious noise — these are filtered before checking
# overlap. We deliberately keep "data", "analytics", "science",
# "engineering" etc. IN play because those ARE the signal that establishes
# field relevance (Master of Data Science vs. a data-analytics JD).
# Over-pruning the vocabulary causes false-positive "irrelevant" warnings
# on the candidate's most important credentials.
_RELEVANCE_STOPWORDS = frozenset({
    "the", "and", "of", "in", "for", "with", "a", "an", "on", "to",
    "is", "as", "at", "by", "or", "from", "into", "onto", "via",
    "applied", "general", "studies", "study", "modern", "advanced",
    "introduction", "fundamentals",
})

# Stems we consider domain-equivalent — extends literal token matching
# so "marketing" matches "marketers", "fundrais" covers fundraising/er.
_RELEVANCE_PREFIX_LEN = 5


def _normalise_token(tok: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", tok.lower())


def _tokenise_for_relevance(text: str) -> List[str]:
    """Lowercased alphanumeric tokens, stopwords removed."""
    return [
        t for t in (
            _normalise_token(w) for w in re.split(r"\s+", text or "")
        )
        if t and len(t) >= 3 and t not in _RELEVANCE_STOPWORDS
    ]


def _build_jd_vocabulary(jd_analysis: Dict[str, Any]) -> set[str]:
    """
    Flatten the JD analysis into a set of relevance tokens.

    Reads keywords.required.* and keywords.preferred.* across all three
    categories (technical / soft_skills / domain_knowledge) plus role
    title / industry hints if present. Tokenised the same way as
    `_tokenise_for_relevance` so the comparison is apples-to-apples.
    """
    bag: set[str] = set()
    if not jd_analysis:
        return bag

    keywords = jd_analysis.get("keywords") or {}
    for bucket in ("required", "preferred"):
        cats = keywords.get(bucket) or {}
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            for kw in cats.get(cat) or []:
                bag.update(_tokenise_for_relevance(str(kw)))

    # Role title and industry context
    for field in ("role_title", "primary_domain", "industry"):
        v = jd_analysis.get(field)
        if isinstance(v, str):
            bag.update(_tokenise_for_relevance(v))

    bag.discard("")
    return bag


def _has_overlap(tokens: List[str], jd_vocab: set[str]) -> List[str]:
    """Return the subset of `tokens` that share a prefix with any JD token."""
    if not jd_vocab:
        return []
    matches: List[str] = []
    for t in tokens:
        if t in jd_vocab:
            matches.append(t)
            continue
        # Prefix match on the first N characters — covers stem variants.
        head = t[:_RELEVANCE_PREFIX_LEN]
        if any(v.startswith(head) or head.startswith(v[:_RELEVANCE_PREFIX_LEN])
               for v in jd_vocab):
            matches.append(t)
    return matches


def _gate_degree_relevance(
    sections: Dict[str, str],
    jd_vocab: set[str],
) -> Dict[str, Any]:
    """
    Warn when a Master's or PhD entry has zero token overlap with the JD.

    Bachelor's degrees are exempt (kept as baseline credentials per the
    prompt). The gate is a soft warn — graduate degrees in unrelated
    fields signal overqualification and should typically be dropped, but
    the writer has final say.

    Skips silently (pass) when no JD vocabulary was provided.
    """
    if not jd_vocab:
        return _result(
            "degree_relevance", "pass",
            "Skipped (no JD analysis available).",
        )

    edu = _resolve_section(sections, _EDUCATION_ALIASES)
    if not edu.strip():
        return _result("degree_relevance", "pass", "No Education section.")

    grad_re = re.compile(
        r"\b(ph\.?d|doctorate|master(?:'s|s)?|m\.?sc|m\.?s\.?\b|m\.?a\.?\b|mba|m\.?phil)\b",
        re.IGNORECASE,
    )
    irrelevant: List[str] = []
    grad_count = 0
    for raw in edu.splitlines():
        line = raw.strip().lstrip("-•* ").strip()
        if not line or not grad_re.search(line):
            continue
        grad_count += 1
        # Strip likely-irrelevant tokens (institution, dates, GPA) by
        # focusing on the part of the line right around the degree word.
        # We tokenise the whole line — the degree-name + field + university
        # all contribute, which is fine.
        toks = _tokenise_for_relevance(line)
        overlap = _has_overlap(toks, jd_vocab)
        if not overlap:
            irrelevant.append(_short(line, 70))

    if grad_count == 0:
        return _result(
            "degree_relevance", "pass",
            "No graduate degrees in Education to check.",
        )
    if not irrelevant:
        return _result(
            "degree_relevance", "pass",
            f"All {grad_count} graduate degree(s) share vocabulary with the JD.",
        )
    return _result(
        "degree_relevance", "warn",
        f"{len(irrelevant)} graduate degree(s) appear unrelated to the JD "
        f"and may signal overqualification — consider dropping: "
        + "; ".join(irrelevant),
    )


def _gate_project_relevance(
    sections: Dict[str, str],
    jd_vocab: set[str],
) -> Dict[str, Any]:
    """
    Warn when a Project entry has zero token overlap with the JD.

    Tokenises the project's title line + tools/status line + first bullet
    and intersects with the JD vocabulary. Zero overlap → warn (likely
    off-topic project that should be dropped).

    Skips silently (pass) when no JD vocab is available.
    """
    if not jd_vocab:
        return _result(
            "project_relevance", "pass",
            "Skipped (no JD analysis available).",
        )

    proj_body = _resolve_section(sections, _PROJECTS_ALIASES)
    if not proj_body.strip():
        return _result(
            "project_relevance", "pass",
            "No Projects section to check.",
        )

    entries = _parse_entries(proj_body)
    if not entries:
        return _result(
            "project_relevance", "pass",
            "No parseable project entries.",
        )

    # Merge two-line headers: the project format is "### Name" then a
    # separate italic line "*Tools | Status*". The naïve entry parser
    # treats the italic line as a fresh entry. Fold it back into the
    # preceding entry so we score the project as one unit.
    merged: List[Dict[str, Any]] = []
    for ent in entries:
        title = ent.get("title_line", "").strip()
        is_italic_subline = title.startswith("*") and title.endswith("*")
        if is_italic_subline and merged and not merged[-1]["bullets"]:
            # Fold this subline's title into the previous entry's title
            # and absorb its bullets.
            merged[-1]["title_line"] = (
                merged[-1]["title_line"] + " " + title
            ).strip()
            merged[-1]["bullets"].extend(ent.get("bullets", []))
        else:
            merged.append({
                "title_line": title,
                "bullets":    list(ent.get("bullets", [])),
            })

    off_topic: List[str] = []
    for ent in merged:
        text_blob = " ".join([
            ent.get("title_line", ""),
            *(ent.get("bullets", [])[:1]),  # first bullet usually carries topic
        ])
        toks = _tokenise_for_relevance(text_blob)
        if not _has_overlap(toks, jd_vocab):
            off_topic.append(
                _short(
                    re.sub(r"\s*\|.*$", "",
                           ent.get("title_line", "").lstrip("#").lstrip("*").strip()),
                    60,
                )
            )

    if not off_topic:
        return _result(
            "project_relevance", "pass",
            f"All {len(merged)} project(s) share vocabulary with the JD.",
        )
    return _result(
        "project_relevance", "warn",
        f"{len(off_topic)} project(s) appear off-topic for this JD "
        f"and may dilute focus — consider dropping: "
        + "; ".join(off_topic),
    )


# ---------------------------------------------------------------------------
# Shape-consistency gates — Education and Projects must use the
# two-line "### Title | Right\n*Subline | Right*" rhythm uniformly.
# ---------------------------------------------------------------------------


# A header line that opens an entry: "### Something" (Education uses h3
# the same way Experience and Projects do). We accept either "### " or
# bold-only "**...**" lines as title candidates because the writer
# occasionally drops the heading level.
_ENTRY_TITLE_RE = re.compile(r"^\s*(?:###\s+|\*\*[^*]+\*\*\s*$)")
_ITALIC_SUBLINE_RE = re.compile(r"^\s*\*[^*][^\n]*[^*]\*\s*$")


def _parse_two_line_blocks(body: str) -> List[Dict[str, Any]]:
    """
    Parse a section body into blocks of {title_line, subline, has_subline}.

    A block starts at a title line (### ... or **...**) and the next
    non-empty line is treated as its subline if and only if that line is
    a single italic paragraph (`*...*`). Anything else means the entry
    skipped the second line.
    """
    blocks: List[Dict[str, Any]] = []
    lines = [ln for ln in body.splitlines()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if _ENTRY_TITLE_RE.match(line):
            title = line.strip()
            subline = ""
            has_subline = False
            # Look ahead past blank lines for the immediate next non-empty line.
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines):
                nxt = lines[j].strip()
                if _ITALIC_SUBLINE_RE.match(nxt):
                    subline = nxt
                    has_subline = True
                    i = j  # skip past the subline
            blocks.append({
                "title_line":  title,
                "subline":     subline,
                "has_subline": has_subline,
            })
        i += 1
    return blocks


def _check_two_line_shape(
    blocks: List[Dict[str, Any]], gate_name: str, section_label: str,
) -> Dict[str, Any]:
    """
    Shared shape-consistency check for Education and Projects sections.

    Reports FAIL when:
      - any entry is missing the italic subline, OR
      - entries are inconsistent: some have it, some don't.

    Reports PASS only when every entry has the two-line shape.
    """
    if not blocks:
        return _result(
            gate_name, "pass",
            f"No {section_label} entries to check.",
        )

    missing = [
        _short(b["title_line"].lstrip("#").strip().lstrip("*").rstrip("*"), 60)
        for b in blocks if not b["has_subline"]
    ]
    if not missing:
        return _result(
            gate_name, "pass",
            f"All {len(blocks)} {section_label} entry/entries use the "
            "two-line shape.",
        )
    if len(missing) == len(blocks):
        return _result(
            gate_name, "fail",
            f"None of the {len(blocks)} {section_label} entries use the "
            f"required two-line shape (`### Title | Right` then "
            f"`*Subline | Right*`): " + "; ".join(missing[:3])
            + (f" (+{len(missing) - 3} more)" if len(missing) > 3 else ""),
        )
    return _result(
        gate_name, "fail",
        f"{section_label} entries inconsistent — {len(missing)} of "
        f"{len(blocks)} missing the italic subline: "
        + "; ".join(missing[:3])
        + (f" (+{len(missing) - 3} more)" if len(missing) > 3 else ""),
    )


def _gate_education_entry_shape(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every degree must use the two-line shape:
        ### Degree | Institution
        *Location or specialisation | Year – Year*

    Mismatched shapes (one degree two-line, another one-line) fail.
    """
    body = _resolve_section(sections, _EDUCATION_ALIASES)
    if not body.strip():
        return _result(
            "education_entry_shape", "warn",
            "No Education section to check.",
        )
    # If the section is a bullet list with no h3 / bold-line headers at
    # all, the renderer can't align left/right columns. Flag it loudly.
    has_any_title = any(
        _ENTRY_TITLE_RE.match(ln) for ln in body.splitlines()
    )
    if not has_any_title:
        return _result(
            "education_entry_shape", "fail",
            "Education emitted as a bullet list — renderer cannot align "
            "left/right columns. Use `### Institution | Location` then "
            "`*Degree | Year – Year*` per entry.",
        )
    blocks = _parse_two_line_blocks(body)
    return _check_two_line_shape(blocks, "education_entry_shape", "Education")


def _gate_project_entry_shape(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every project must use the two-line shape:
        ### Project Name [| link/client]
        *Tools or status | Date*

    Mismatched shapes across projects fail.
    """
    body = _resolve_section(sections, _PROJECTS_ALIASES)
    if not body.strip():
        return _result(
            "project_entry_shape", "pass",
            "No Projects section.",
        )
    blocks = _parse_two_line_blocks(body)
    base = _check_two_line_shape(blocks, "project_entry_shape", "Projects")
    if base["status"] == "fail":
        return base
    # Extra constraint: every project's Line 1 must contain a ` | ` so
    # the renderer has something to right-align.
    no_pipe_on_line1: List[str] = []
    for b in blocks:
        title = b["title_line"].lstrip("#").strip()
        if " | " not in title:
            no_pipe_on_line1.append(_short(title, 60))
    if no_pipe_on_line1:
        return _result(
            "project_entry_shape", "fail",
            f"{len(no_pipe_on_line1)} project(s) missing ` | <right>` on "
            "Line 1 — renderer can't align the right column: "
            + "; ".join(no_pipe_on_line1[:3])
            + (f" (+{len(no_pipe_on_line1) - 3} more)"
               if len(no_pipe_on_line1) > 3 else ""),
        )
    return base


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------


def _result(name: str, status: str, detail: str) -> Dict[str, Any]:
    return {"name": name, "status": status, "detail": detail}


def _short(text: str, n: int = 50) -> str:
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"
