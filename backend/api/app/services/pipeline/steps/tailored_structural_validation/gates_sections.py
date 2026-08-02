"""Education / projects / skills gates, including entry shapes.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
import re
from .parsing import (
    _EDUCATION_ALIASES,
    _ENTRY_TITLE_RE,
    _PROJECTS_ALIASES,
    _SKILLS_ALIASES,
    _check_two_line_shape,
    _parse_entries,
    _parse_two_line_blocks,
    _resolve_section,
)
from .relevance import (
    _has_overlap,
    _tokenise_for_relevance,
)
from .results import (
    _result,
    _short,
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


def _resolve_expected_skills_labels(jd_analysis: Dict[str, Any] | None) -> set[str]:
    """Pick the expected Skills-section category labels for the role family.

    Reads `category_labels` that the orchestrator attaches to `jd_analysis`
    after running `resolve_role_family`. The orchestrator emits it as a DICT
    keyed by internal bucket name:
        {"technical": "Other Skills",
         "soft_skills": "Soft Skills",
         "domain_knowledge": "Care Skills"}
    (For nursing the headline bucket is domain_knowledge → "Care Skills";
    for tech the headline is technical → "Technical Skills".)

    Falls back to the tech-shaped {Technical, Soft, Other} set when no family
    is attached (legacy resumes / unknown vertical).
    """
    fallback = {"technical skills", "soft skills", "other skills"}
    if not jd_analysis:
        return fallback
    labels = jd_analysis.get("category_labels")
    # Dict shape: pull the three values.
    if isinstance(labels, dict) and labels:
        out = {str(v).lower().strip() for v in labels.values()
               if isinstance(v, str) and v.strip()}
        return out or fallback
    # Legacy list shape, just in case.
    if isinstance(labels, list) and len(labels) >= 3:
        return {str(lbl).lower().strip() for lbl in labels
                if isinstance(lbl, str) and lbl.strip()}
    return fallback


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
