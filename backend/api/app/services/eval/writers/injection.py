"""Skills surfacing & injection — extracted from writers._impl.

Deterministic Skills-section passes used by the W5/W8 writers: surface matched
JD terms verbatim, surface CV-named tools (_KNOWN_CV_TOOLS), relocate misplaced
technical entries, inject approved feasibility keywords, and drop generic
entries subsumed by a more specific one. Moved verbatim (own module logger).
Cross-module deps are imported from their true sources — all acyclic:
tailored_cv (pipeline step, already imported by _impl), enforce, and the
sibling writers.skills_section module.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.eval.enforce import DEFAULT_SKILL_CAPS, _ROLE_CATEGORY_LABELS
from app.services.eval.writers.skills_section import _SKILLS_LINE_RE, _is_non_skill_phrase
from app.services.pipeline.steps.tailored_cv import (
    _SKILLS_CATEGORY_LABEL,
    _format_skill_label,
    _kw_in_skills,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# W5 — lexical surfacing: W3 architecture, but the inject list is the
# deterministically-grounded set of JD terms the candidate genuinely has
# (matched, per step 2), surfaced VERBATIM. Replaces reliance on the
# over-permissive feasibility classifier. Implements the ATS research:
# surface exact terms you honestly have; add nothing else.
# ---------------------------------------------------------------------------

_SURFACE_BUCKETS = ("required", "preferred")
_SURFACE_CATS = ("technical", "soft_skills", "domain_knowledge")


def _matched_surface_terms(matching: Dict[str, Any]) -> list[str]:
    """Grounded JD terms to surface verbatim = everything the matcher matched."""
    out: list[str] = []
    matched = (matching or {}).get("matched") or {}
    for bucket in _SURFACE_BUCKETS:
        b = matched.get(bucket) or {}
        for cat in _SURFACE_CATS:
            out.extend(str(x).strip() for x in (b.get(cat) or []) if str(x).strip())
    seen: set[str] = set()
    return [t for t in out if not (t.lower() in seen or seen.add(t.lower()))]


# Generous per-category caps for the surfaced terms (technical, soft, other).
# Higher than enforce_skills_section's display caps because these are confirmed
# JD matches — the highest-value ATS keywords — and run AFTER that hygiene pass.
_SURFACE_CAPS: Dict[str, int] = {"technical": 16, "soft_skills": 8, "domain_knowledge": 10}

# Strip an optional leading list bullet ("- ", "* ", "• ") so category-line
# detection works whether or not enforce_skills_section has stamped the bullet
# prefix that the web/PDF renderers need.
_LEADING_BULLET_RE = re.compile(r"^[-*•]\s+")


def _line_starts_label(line: str, label: str) -> bool:
    """True if `line` (ignoring leading whitespace + an optional list bullet)
    starts with the bold category `label`."""
    return _LEADING_BULLET_RE.sub("", line.lstrip()).startswith(label)


def _surface_matched_skills(markdown: str, matching: Dict[str, Any]) -> str:
    """
    Re-surface JD terms the matcher confirmed the candidate has into the tailored
    Skills section, per category, if the tailoring rewrite dropped them.

    Honest by construction: only terms in ``matching["matched"]`` are added — the
    matcher verified each against the original CV — so this never fabricates. It
    runs AFTER enforce_skills_section so the dedup/cap pass can't strip the very
    keywords the original CV already scored on (the ATS-regression fix).
    """
    matched = (matching or {}).get("matched") or {}
    # Collect matched terms per category, required before preferred.
    by_cat: Dict[str, list[str]] = {c: [] for c in _SURFACE_CATS}
    for bucket in _SURFACE_BUCKETS:
        b = matched.get(bucket) or {}
        for cat in _SURFACE_CATS:
            for x in (b.get(cat) or []):
                term = str(x).strip()
                if term:
                    by_cat[cat].append(term)
    if not any(by_cat.values()):
        return markdown

    lines = markdown.split("\n")

    # Locate the canonical Skills section (## Skills — restore_and_order renames
    # headings to family names LATER, so labels here are still canonical).
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip() == "## Skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown

    # Map each category to its line index within the Skills section.
    cat_to_line_idx: Dict[str, int] = {}
    for i in range(skills_start + 1, skills_end):
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label):
                cat_to_line_idx[cat] = i
                break

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    appended = 0
    for cat in _SURFACE_CATS:
        target_idx = cat_to_line_idx.get(cat)
        if target_idx is None:
            continue
        cap = _SURFACE_CAPS.get(cat, 8)
        existing_count = len(lines[target_idx].split(","))
        seen_terms: set[str] = set()
        for term in by_cat[cat]:
            key = term.lower()
            if key in seen_terms or _kw_in_skills(term, skills_text_lower):
                continue
            if _is_non_skill_phrase(term):
                continue
            if existing_count >= cap:
                break
            seen_terms.add(key)
            display = _format_skill_label(term)
            lines[target_idx] = f"{lines[target_idx].rstrip()}, {display}"
            skills_text_lower += ", " + display.lower()
            existing_count += 1
            appended += 1

    if appended:
        logger.info("w8 surfacing: re-added %d matched JD skill term(s)", appended)

    return "\n".join(lines)


# Brand-name tools the candidate uses that should NEVER disappear from the
# tailored CV's Skills section, even when the JD doesn't ask for them. The
# writer prompt sometimes drops these in favour of JD-required generic terms
# ("Basic Computer Skills") — but the candidate's named tools are real
# differentiators recruiters scan for.
#
# Pattern: each entry is a regex matched against the original CV text
# (case-insensitive). When matched in the CV but absent from the tailored
# Skills section, the canonical form is appended to the headline-secondary
# (Other Skills for nursing/manual) line.
#
# Conservative list: only proven nursing/care domain tools that match the
# kind of CV content this app sees. Easy to extend per vertical.
_KNOWN_CV_TOOLS: tuple[tuple[str, str], ...] = (
    # Medication administration / clinical apps used in Australian aged care.
    (r"\bBESTMed\b",   "BESTMed"),
    (r"\bMedMobile\b", "MedMobile"),
    (r"\bLeecare\b",   "Leecare"),
    (r"\bManAd\b",     "ManAd"),
    (r"\bePAS\b",      "ePAS"),
    # Common clinical EHRs (US/AU). Match only when literally in the CV.
    (r"\bEpic\b",      "Epic"),
    (r"\bCerner\b",    "Cerner"),
)


def _surface_cv_named_tools(
    markdown: str, original_cv_text: str, role_family
) -> str:
    """Ensure CV-named brand tools (BESTMed, MedMobile, Leecare, ...) appear
    in the tailored Skills section.

    The writer prompt sometimes drops these in favour of JD-required generic
    keywords ("Basic Computer Skills", "Smartphone Usage"), wiping the
    candidate's actual differentiating tools. This runs AFTER the cap-and-
    strip dance and re-injects only tools literally present in the original
    CV. Honest by construction — tools must appear in original_cv_text.

    Routes to:
      - Other Skills (when headline_bucket == "domain_knowledge", i.e. nursing
        / manual): tools sit in the secondary "Other" line by convention.
      - Technical Skills (when headline_bucket == "technical", i.e. tech /
        master): tools ARE the headline.
    """
    if not original_cv_text or not markdown:
        return markdown

    lines = markdown.split("\n")
    skills_start = next(
        (i for i, l in enumerate(lines) if l.strip() == "## Skills"), None,
    )
    if skills_start is None:
        return markdown
    skills_end = next(
        (j for j in range(skills_start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    # Bug fix (Sprint G+): scope the "already present" check to the SKILLS
    # SECTION only. Previous behaviour scanned the whole markdown — so when
    # BESTMed/MedMobile appeared in Summary / Experience bullets but were
    # absent from the Skills section, the surfacer thought they were "found"
    # and skipped. The candidate's named tools belong on the Skills line
    # regardless of being mentioned in body prose.
    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    missing: list[str] = []
    for pattern, canonical in _KNOWN_CV_TOOLS:
        if re.search(pattern, original_cv_text, flags=re.IGNORECASE):
            # Must appear in the SKILLS SECTION, not just anywhere.
            if canonical.lower() not in skills_text_lower:
                missing.append(canonical)

    if not missing:
        return markdown

    # Pick the target category: for tech roles 'technical' maps to the
    # 'Technical Skills' line (headline). For nursing/manual the LLM emits
    # 'Care Skills' / 'Core Skills' (NOT in _SKILLS_CATEGORY_LABEL); the
    # canonical mapping has 'domain_knowledge' → 'Other Skills' which is
    # where tools land in nursing/manual. So:
    #   • tech: target = 'technical' (Technical Skills line)
    #   • nursing/manual: target = 'domain_knowledge' (Other Skills line)
    target_cat = "technical" if role_family.headline_bucket == "technical" else "domain_knowledge"

    target_idx = None
    for i in range(skills_start + 1, skills_end):
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label) and cat == target_cat:
                target_idx = i
                break
        if target_idx is not None:
            break
    if target_idx is None:
        return markdown

    cap = _SURFACE_CAPS.get(target_cat, 8)
    existing_count = len([s for s in lines[target_idx].split(",") if s.strip()])
    appended = 0
    for tool in missing:
        if existing_count >= cap:
            break
        lines[target_idx] = f"{lines[target_idx].rstrip()}, {tool}"
        existing_count += 1
        appended += 1

    if appended:
        logger.info("w8 surfacing: re-added %d CV-named tool(s): %s",
                    appended, missing[:appended])

    return "\n".join(lines)


# Skills entries whose category placement is obvious — anything matching
# these patterns belongs in the TECHNICAL bucket (= Other Skills for
# nursing/manual, = Technical Skills for tech), never Soft or Care Skills.
# The LLM occasionally misfiles these (post-Sprint-G Anglicare run put
# 'Basic Smartphone Skills' under Soft Skills). This pass moves them.
_TECHNICAL_SKILL_PATTERNS = re.compile(
    r"\b("
    r"computer|smartphone|tablet|mobile\s+app|mobile\s+apps|software|hardware"
    r"|laptop|desktop|operating\s+system|database|spreadsheet"
    r"|bestmed|medmobile|leecare|manad|epas|epic|cerner"
    r")\b",
    re.IGNORECASE,
)


def _move_misplaced_technical_skills(markdown: str, role_family) -> str:
    """Move obviously-technical Skills entries (computer / smartphone / app /
    named brand tools) from Soft Skills or Care Skills to the technical-bucket
    line (Other Skills for nursing/manual; Technical Skills for tech).

    Honest by construction: only moves entries that match a hardcoded
    technical-vocabulary pattern. Idempotent — re-running produces same
    output. No-op when no misplaced entries are detected.
    """
    if not markdown:
        return markdown
    lines = markdown.split("\n")
    skills_start = next(
        (i for i, l in enumerate(lines) if l.strip() == "## Skills"), None,
    )
    if skills_start is None:
        return markdown
    skills_end = next(
        (j for j in range(skills_start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    # Find the target line (where tools belong) via the canonical label map.
    # For nursing, the Care Skills line label is NOT in _SKILLS_CATEGORY_LABEL
    # (it's family-specific), so we can't depend on cat_to_line_idx covering
    # all Skills lines. Locate target via the canonical label, then enumerate
    # ALL other Skills lines as candidates regardless of label.
    target_cat = "technical" if role_family.headline_bucket == "technical" else "domain_knowledge"
    target_label = _SKILLS_CATEGORY_LABEL.get(target_cat, "")
    target_idx = None
    for i in range(skills_start + 1, skills_end):
        if target_label and _line_starts_label(lines[i], target_label):
            target_idx = i
            break
    if target_idx is None:
        return markdown  # no target line to move into

    # Source lines: every Skills line EXCEPT the target. Detect Skills lines
    # by the **Label:** pattern so family-specific labels (Care Skills /
    # Clinical Skills / Core Skills) are included.
    source_indices: list[int] = []
    for i in range(skills_start + 1, skills_end):
        if i == target_idx:
            continue
        if _SKILLS_LINE_RE.match(lines[i]):
            source_indices.append(i)

    moved: list[str] = []
    for src_idx in source_indices:
        m = _SKILLS_LINE_RE.match(lines[src_idx])
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        parts = [p.strip() for p in body.split(",")]
        kept: list[str] = []
        for p in parts:
            if not p:
                continue
            if _TECHNICAL_SKILL_PATTERNS.search(p):
                # Move to target line; preserve canonical form.
                moved.append(p)
            else:
                kept.append(p)
        if moved and len(kept) != len(parts):
            # The body changed; re-emit the source line.
            if kept:
                lines[src_idx] = prefix + ", ".join(kept)
            else:
                # Don't leave an empty category line — mark it for later drop
                # by enforce_skills_section (which handles the empty-line drop).
                lines[src_idx] = prefix.rstrip() + " "  # blank body → cap pass will drop

    if not moved:
        return markdown

    # Append moved entries to target line (deduping against existing content).
    # Strip the '**Label:**' prefix before splitting so the first entry isn't
    # bundled into the label token.
    target_m = _SKILLS_LINE_RE.match(lines[target_idx])
    if target_m:
        target_body = target_m.group(2)
    else:
        target_body = lines[target_idx]
    existing = {p.strip().lower() for p in target_body.split(",") if p.strip()}
    additions = []
    for entry in moved:
        if entry.lower() not in existing:
            additions.append(entry)
            existing.add(entry.lower())
    if additions:
        lines[target_idx] = f"{lines[target_idx].rstrip()}, " + ", ".join(additions)
        logger.info("w8: moved %d misplaced technical skill(s) to %s line: %s",
                    len(additions), target_cat, additions)

    return "\n".join(lines)


# Buckets the feasibility classifier marks as eligible to inject.
_APPROVED_BUCKETS = ("inject_directly", "inject_as_extension", "inject_with_inference")


def _approved_skill_entries(feasibility: Optional[Dict[str, Any]]) -> list[tuple[str, str]]:
    """(keyword, category) for every approved keyword in a Skills category.

    Pulls from all three injectable buckets (the SAME set the tailored-rescorer
    treats as "approved" → so anything that would otherwise show as "Approved
    but missed" gets one deterministic, post-cap chance to land in Skills).
    """
    plan = (feasibility or {}).get("feasibility_plan") or {}
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for fb in _APPROVED_BUCKETS:
        for entry in plan.get(fb) or []:
            if not isinstance(entry, dict):
                continue
            kw = str(entry.get("keyword") or "").strip()
            cat = str(entry.get("category") or "").strip().lower()
            if not kw or cat not in _SURFACE_CATS:
                continue
            key = kw.lower()
            if key in seen:
                continue
            if key in _ROLE_CATEGORY_LABELS:
                continue  # Role-category label: inject into bullets/summary only, never Skills
            seen.add(key)
            out.append((kw, cat))
    return out


_INJECT_LINE_RE = re.compile(r"^(\s*(?:[-*•]\s+)?\*\*[^*]+:\*\*\s*)(.*)$")


def _norm_item(item: str) -> str:
    """Lower + collapse non-alphanumerics for cross-form comparison."""
    return re.sub(r"[^a-z0-9]+", " ", item.lower()).strip()


def _inject_approved_skills(markdown: str, feasibility: Optional[Dict[str, Any]]) -> str:
    """Cap-aware POST-CAP safety net for approved-but-missing skill keywords.

    Must run AFTER the final ``enforce_skills_section`` so the cap is already
    applied. This function RESPECTS the cap — it classifies existing items as
    approved-keep vs writer-only, places new approved keywords ahead of
    writer-only items, and truncates to ``DEFAULT_SKILL_CAPS`` (14/6/6
    position-based). Writer-only tail items are displaced when the line is
    full; approved-existing peers are preserved.

    Effect: approved soft skills the writer never surfaced (verbal/written
    communication, work planning) land in the Skills section even when the
    line is already at cap — without exceeding the cap, so no follow-up
    ``enforce_skills_section`` is needed (and would be harmful — it would
    truncate the just-placed approved items off the tail).
    """
    entries = _approved_skill_entries(feasibility)
    if not entries:
        return markdown

    # Full approved set (all three buckets) for "is this item approved?" checks.
    approved_set: set = {_norm_item(kw) for kw, _ in entries}
    by_cat: Dict[str, list] = {}
    for kw, cat in entries:
        by_cat.setdefault(cat, []).append(kw)

    lines = markdown.split("\n")
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip() == "## Skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown

    # Map category → (line_idx, position) — position drives DEFAULT_SKILL_CAPS.
    # Also handle nursing headline labels (Care Skills / Clinical Skills / Core
    # Skills) which don't appear in _SKILLS_CATEGORY_LABEL.
    cat_to: Dict[str, tuple] = {}
    pos = 0
    for i in range(skills_start + 1, skills_end):
        stripped = _LEADING_BULLET_RE.sub("", lines[i].lstrip())
        if not stripped.startswith("**") or ":**" not in stripped:
            continue
        matched_cat = None
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label):
                matched_cat = cat
                break
        if matched_cat is None and pos == 0 and "domain_knowledge" not in cat_to:
            # Nursing headline (Care Skills / Clinical Skills / Core Skills)
            matched_cat = "domain_knowledge"
        if matched_cat is not None and matched_cat not in cat_to:
            cat_to[matched_cat] = (i, pos)
        pos += 1

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    appended = 0
    displaced = 0

    for cat, target in cat_to.items():
        target_idx, target_pos = target
        line = lines[target_idx]
        m = _INJECT_LINE_RE.match(line)
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        items = [it.strip() for it in body.split(",") if it.strip()]
        if not items:
            continue

        cap = (
            DEFAULT_SKILL_CAPS[target_pos]
            if target_pos < len(DEFAULT_SKILL_CAPS)
            else DEFAULT_SKILL_CAPS[-1]
        )

        # Split existing items: approved-keep vs writer-only.
        approved_existing: list = []
        writer_only: list = []
        seen_existing: set = set()
        for it in items:
            key = _norm_item(it)
            if key in seen_existing:
                continue
            seen_existing.add(key)
            if key in approved_set:
                approved_existing.append(it)
            else:
                writer_only.append(it)

        # Pending = approved for THIS category, not already present.
        pending: list = []
        for kw in by_cat.get(cat, []):
            if _is_non_skill_phrase(kw):
                continue
            if _kw_in_skills(kw, skills_text_lower):
                continue
            display = _format_skill_label(kw)
            if _norm_item(display) in seen_existing:
                continue
            seen_existing.add(_norm_item(display))
            pending.append(display)
            skills_text_lower += ", " + display.lower()

        if not pending and len(items) <= cap:
            continue

        # Final list = approved-keep + new approved + writer-only, truncated.
        merged = approved_existing + pending + writer_only
        before = len(items)
        truncated = merged[:cap]
        after = len(truncated)
        new_count = sum(1 for p in pending if p in truncated)
        appended += new_count
        if before > after:
            displaced += before - after

        lines[target_idx] = prefix + ", ".join(truncated)

    if appended or displaced:
        logger.info(
            "w8 approved-skill injector: added %d approved keyword(s), displaced %d writer-only",
            appended, displaced,
        )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Force-inject pass — belt-and-braces for the approved-skill injector above.
# ---------------------------------------------------------------------------
#
# Real-test surfaced: on nursing CVs the approved injector silently drops
# `computer skills` (category=technical) because the vertical's Skills
# section has no "Technical Skills" line (tools live in "Other Skills"
# instead). Similarly `meal preparation` (domain_knowledge) sometimes
# misses because the injector's match-and-skip heuristic flags it as
# already-present-by-prefix when it isn't.
#
# This pass is the simplest possible guarantee: every keyword the
# feasibility plan approved (direct, extension, inference) lands SOMEWHERE
# in the Skills section unless it's explicitly a non-skill phrase. Falls
# back to vertical-appropriate lines when the expected label is missing.

# Per-category preference order: which Skills-line labels to try, in order,
# when injecting an approved keyword of that category. Covers nursing
# ("Care Skills" + "Other Skills"), tech ("Technical Skills"), trades
# ("Trade Skills"), cleaning ("Cleaning Skills"), and the generic universal
# labels. First label that exists in the markdown wins.
_FORCE_INJECT_TARGET_LABELS: Dict[str, tuple[str, ...]] = {
    "technical": (
        "Technical Skills", "Tools", "Tools & Software",
        "Other Skills",     # nursing/care vertical bucket for tools
    ),
    "soft_skills": ("Soft Skills",),
    "domain_knowledge": (
        "Care Skills", "Clinical Skills", "Trade Skills",
        "Cleaning Skills", "Core Skills", "Other Skills",
    ),
}


def _find_skills_line_by_label(lines: List[str], label: str,
                                skills_start: int, skills_end: int) -> Optional[int]:
    """Return the index of the Skills line whose label matches, or None.
    Matches on the bold-label prefix (e.g. '**Care Skills:**')."""
    needle = f"**{label}:**".lower()
    for i in range(skills_start + 1, skills_end):
        if needle in lines[i].lower():
            return i
    return None


def force_inject_missed_approved(
    markdown: str, feasibility: Optional[Dict[str, Any]],
) -> Tuple[str, List[str]]:
    """Ensure every approved keyword appears in the Skills section.

    Runs LAST in the writer pass chain. For each feasibility-approved
    keyword (direct, extension, inference) not already in the tailored CV
    and not a non-skill phrase, append it to the most appropriate Skills
    line for its category. Cap is intentionally relaxed here — the
    earlier ``_inject_approved_skills`` already enforced the cap; this
    pass is the safety net for items that fell through label mismatches.

    Returns ``(rewritten_md, notes)`` — notes record what got force-added.
    """
    entries = _approved_skill_entries(feasibility)
    if not entries:
        return markdown, []

    lines = markdown.split("\n")
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip() == "## Skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown, []

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()

    notes: List[str] = []
    appended = 0

    for kw, cat in entries:
        # Already present somewhere in Skills → leave alone.
        if _kw_in_skills(kw, skills_text_lower):
            continue
        # Non-skill phrase (sector/setting/credential filler) → don't force.
        # The same filter the regular injector + rescorer use.
        from app.services.eval.writers.skills_section import _is_non_skill_phrase
        if _is_non_skill_phrase(kw):
            continue
        target_idx = None
        for label in _FORCE_INJECT_TARGET_LABELS.get(cat, ()):
            target_idx = _find_skills_line_by_label(lines, label, skills_start, skills_end)
            if target_idx is not None:
                break
        if target_idx is None:
            # No usable target line — best-effort skip.
            continue

        m = _INJECT_LINE_RE.match(lines[target_idx])
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        display = _format_skill_label(kw)
        # Defensive dedupe against the existing line items.
        existing = {_norm_item(it) for it in body.split(",") if it.strip()}
        if _norm_item(display) in existing:
            continue
        new_body = (body + ", " + display) if body.strip() else display
        lines[target_idx] = prefix + new_body
        skills_text_lower += ", " + display.lower()
        notes.append(f"force-injected '{display}' → {lines[target_idx].split(':**', 1)[0].split('**')[-1]}")
        appended += 1

    if appended:
        logger.info(
            "force-inject: added %d approved keyword(s) the writer dropped: %s",
            appended, [n.split("'")[1] for n in notes if "'" in n],
        )
    return "\n".join(lines), notes


def _drop_subsumed_generic_skills(markdown: str) -> str:
    """Drop a bare single-word Skills entry when a more specific multi-word
    entry already ends with that word.

    e.g. once "Verbal Communication" and "Written Communication" are present,
    the generic "Communication" is redundant noise. Same for "Care" vs
    "Personal Care", "Management" vs "Time Management". Operates only inside the
    ``## Skills`` section, across all category lines; first-listed wins.
    """
    lines = markdown.split("\n")
    skills_start = None
    skills_end = len(lines)
    for i, line in enumerate(lines):
        if line.strip() == "## Skills":
            skills_start = i
        elif skills_start is not None and line.startswith("## "):
            skills_end = i
            break
    if skills_start is None:
        return markdown

    # Collect every (line_idx, item) across the Skills section.
    parsed: list[tuple[int, list[str]]] = []
    multiword_last_words: set[str] = set()
    for i in range(skills_start + 1, skills_end):
        m = _SKILLS_LINE_RE.match(lines[i])
        if not m:
            continue
        items = [p.strip() for p in m.group(2).split(",") if p.strip()]
        parsed.append((i, items))
        for it in items:
            words = it.lower().split()
            if len(words) > 1:
                multiword_last_words.add(words[-1])

    if not multiword_last_words:
        return markdown

    dropped = 0
    for idx, items in parsed:
        kept: list[str] = []
        for it in items:
            words = it.lower().split()
            if len(words) == 1 and words[0] in multiword_last_words:
                dropped += 1
                continue
            kept.append(it)
        m = _SKILLS_LINE_RE.match(lines[idx])
        if m and kept:
            lines[idx] = m.group(1) + ", ".join(kept)

    if dropped:
        logger.info("w8 skills hygiene: dropped %d generic skill(s) subsumed by a specific entry", dropped)

    return "\n".join(lines)
