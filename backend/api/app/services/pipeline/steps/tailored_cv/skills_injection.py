"""Deterministic Skills-section keyword injector.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

from app.services.eval.enforce import _split_compound_skills
import re
from ._common import logger

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
