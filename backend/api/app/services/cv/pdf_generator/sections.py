"""Per-section renderers and story assembly.

Split out of the former single-module pdf_generator.py (1,371 lines). Function
bodies, ordering and comments are unchanged apart from one deliberate edit:
the three render drivers now call layout_state._set_active_config(cfg) instead
of each inlining `global _active_cfg, STYLES` (see layout_state for why).
Every name remains importable from ``app.services.cv.pdf_generator``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
import re
from .layout_state import (
    _cfg,
    _styles,
)
from .parsing import (
    _SECTION_ALIASES,
    _SECTION_LABELS,
    _SECTION_ORDER,
    _contact_label,
    _parse_experience_header,
)
from .primitives import (
    _bullet_row,
    _ensure_https,
    _escape,
    _inline_markup,
    _is_italic_only_line,
    _norm,
    _section_header,
    _spacer,
    _split_pipes,
    _strip_md_emphasis,
    _two_col,
)
from .theme import C_LINK

def _render_contact_line(contact: str) -> List[Any]:
    parts = [p.strip() for p in contact.split("|") if p.strip()]
    fragments: List[str] = []
    for part in parts:
        if "@" in part and "." in part and " " not in part:
            fragments.append(f'<a href="mailto:{part}" color="#000080">{_escape(part)}</a>')
        elif re.search(r'(linkedin\.com|github\.com|github\.io|behance|dribbble|https?://|www\.)', part, re.I):
            url = _ensure_https(part)
            label = _contact_label(url)
            fragments.append(
                f'<a href="{url.replace("&", "&amp;")}" color="#000080">{_escape(label)}</a>'
            )
        else:
            fragments.append(_escape(part))
    return [Paragraph(" | ".join(fragments), _styles()["contact"])]


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------

def _render_bullets(items: List[Dict], start: int, end: int) -> List[Any]:
    out: List[Any] = []
    for j, item in enumerate(items[start:end], start=start):
        para = _inline_markup(item["text"], _styles()["bullet_text"])
        out.append(_bullet_row(para))
        if j < end - 1:
            out.append(_spacer(_cfg().bullet_gap))
    return out


def _render_highlights(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    seen: set = set()
    bullet_paras: List[Paragraph] = []

    for item in items:
        text = item["text"].strip()
        if not text:
            continue
        fp = _norm(text)
        if fp in seen:
            continue
        seen.add(fp)

        if item["type"] == "bullet":
            if text.lower().startswith("skills:"):
                colon = text.index(":")
                skills_text = text[colon + 1:].strip()
                bullet_paras.append(Paragraph(
                    f"Skills: <i>{_escape(skills_text)}</i>",
                    _styles()["bullet_text"],
                ))
            else:
                bullet_paras.append(_inline_markup(text, _styles()["bullet_text"]))
        else:
            # paragraph (summary text)
            if bullet_paras:
                # already started bullets — treat as another bullet
                bullet_paras.append(_inline_markup(text, _styles()["bullet_text"]))
            else:
                out.append(_inline_markup(text, _styles()["body"]))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(_cfg().bullet_gap))
    return out


def _render_experience(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        # Try to parse as entry header
        header = _parse_experience_header(items, i)
        if header is not None:
            if header.fingerprint in seen_fp:
                # Duplicate header — skip the lines it consumed
                i += header.consumed
                continue
            seen_fp.add(header.fingerprint)

            if entry_count > 0:
                out.append(_spacer(_cfg().subsection_gap))
            entry_count += 1

            # Row 1: Company (bold) | Location
            out.append(_two_col(
                Paragraph(_escape(header.left_top), _styles()["company_row"]),
                Paragraph(_escape(header.right_top), _styles()["date_right"]),
            ))
            # Row 2: Title|Tools (italic) | Date
            if header.left_bot or header.right_bot:
                out.append(_two_col(
                    Paragraph(_escape(header.left_bot), _styles()["job_title"]),
                    Paragraph(_escape(header.right_bot), _styles()["date_right"]),
                ))

            i += header.consumed

            # Collect bullets for this entry
            bullet_start = i
            while i < len(items) and items[i]["type"] == "bullet":
                # Note: bullet dedup is per-entry — duplicates would just be
                # different recommendations, so we don't dedup bullets globally.
                i += 1
            bullet_end = i
            if bullet_end > bullet_start:
                out.extend(_render_bullets(items, bullet_start, bullet_end))
                out.append(_spacer(_cfg().after_bullets))
            continue

        # Stray bullet
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
            i += 1
            continue

        # Stray paragraph that's NOT a duplicate header — render as body
        text = _strip_md_emphasis(item["text"])
        fp = _norm(text)
        if fp in seen_fp:
            i += 1
            continue
        # If it has a date pattern but didn't parse as a header, skip silently.
        if re.search(r'\b(19|20)\d{2}\b', text) and "|" in text:
            i += 1
            continue
        out.append(_inline_markup(item["text"], _styles()["body"]))
        i += 1

    return out


def _render_education(items: List[Dict]) -> List[Any]:
    """
    Education entries. Supports:
      A) Bullet all-in-one:
           - **Degree** | Institution, Location | Year | GPA: x
      B) Two-line h3 + italic:
           ### Institution | Location
           *Degree | Year – Year* (or with GPA)
      C) h3 + plain-paragraph companion:
           ### Degree | Institution
           Institution line / Year line
    Output: Row1 = Bold Degree (left) | Year (right)
            Row2 = Italic Institution, Location (left) | GPA (right)
    """
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0

    def _emit(degree: str, institution: str, location: str, year: str, gpa: str) -> None:
        nonlocal entry_count
        if not degree:
            return
        fp = _norm(degree + institution + year)
        if fp in seen_fp:
            return
        seen_fp.add(fp)
        if entry_count > 0:
            out.append(_spacer(_cfg().education_gap))
        entry_count += 1

        out.append(_two_col(
            Paragraph(_escape(degree), _styles()["degree"]),
            Paragraph(_escape(year), _styles()["date_right"]),
        ))
        inst_loc = institution
        if location and location not in institution:
            inst_loc = f"{institution}, {location}" if institution else location
        if inst_loc or gpa:
            out.append(_two_col(
                Paragraph(_escape(inst_loc), _styles()["institution"]),
                Paragraph(_escape(gpa), _styles()["date_right"]),
            ))

    def _extract_year(parts: List[str]) -> str:
        for p in parts:
            if re.search(r'\b(19|20)\d{2}\b', p):
                return p
        return ""

    def _extract_gpa(parts: List[str]) -> str:
        for p in parts:
            if re.match(r'(?i)^\s*(c?gpa)\b', p):
                return p
        return ""

    i = 0
    while i < len(items):
        item = items[i]
        text = _strip_md_emphasis(item["text"]).strip()
        if not text:
            i += 1
            continue

        # Shape B: ### Institution | Location  +  *Degree | Year*
        if (
            item["type"] == "h3"
            and i + 1 < len(items)
            and items[i + 1]["type"] == "paragraph"
            and _is_italic_only_line(items[i + 1]["text"])
        ):
            top_parts = _split_pipes(text)
            bot_text = _strip_md_emphasis(items[i + 1]["text"])
            bot_parts = _split_pipes(bot_text)
            institution = top_parts[0] if top_parts else ""
            location = " | ".join(top_parts[1:]) if len(top_parts) > 1 else ""
            degree = bot_parts[0] if bot_parts else ""
            year = _extract_year(bot_parts[1:]) or (bot_parts[1] if len(bot_parts) > 1 else "")
            gpa = _extract_gpa(bot_parts)
            _emit(degree, institution, location, year, gpa)
            i += 2
            continue

        parts = _split_pipes(text)

        # Shape A: bullet/paragraph all-in-one with year
        if re.search(r'\b(19|20)\d{2}\b', text) and len(parts) >= 2:
            degree = parts[0]
            year = _extract_year(parts[1:])
            gpa = _extract_gpa(parts[1:])
            inst_parts = [
                p for p in parts[1:]
                if p != year and not re.match(r'(?i)^\s*(c?gpa)\b', p)
            ]
            if inst_parts:
                # institution may itself have ", Location"
                first = inst_parts[0]
                if "," in first and len(inst_parts) == 1:
                    seg = [s.strip() for s in first.split(",")]
                    institution = ", ".join(seg[:-1]) if len(seg) > 1 else first
                    location = seg[-1] if len(seg) > 1 else ""
                else:
                    institution = first
                    location = inst_parts[1] if len(inst_parts) > 1 else ""
            else:
                institution = ""
                location = ""
            _emit(degree, institution, location, year, gpa)
            i += 1
            continue

        # Shape C / fallback: try degree/institution split via pipes
        if len(parts) >= 2:
            degree = parts[0]
            institution = parts[1]
            location = parts[2] if len(parts) > 2 else ""
            year = _extract_year(parts[1:])
            gpa = _extract_gpa(parts[1:])
            _emit(degree, institution, location, year, gpa)
            i += 1
            continue

        # Single-token degree line — peek at next item for institution/year
        degree = text
        institution = location = year = gpa = ""
        if i + 1 < len(items):
            nxt = _strip_md_emphasis(items[i + 1]["text"])
            np = _split_pipes(nxt)
            if np and items[i + 1]["type"] != "h3":
                year = _extract_year(np)
                gpa = _extract_gpa(np)
                non_year = [p for p in np if p != year and not re.match(r'(?i)^\s*(c?gpa)\b', p)]
                institution = non_year[0] if non_year else ""
                location = non_year[1] if len(non_year) > 1 else ""
                i += 1
        _emit(degree, institution, location, year, gpa)
        i += 1

    return out


# Matches category markers embedded mid-bullet by the LLM writer. Two
# alternatives, bold tried first: a bold '**Category:**' marker, OR a BARE
# '<Word> Skills:' / '<Word> Knowledge:' label (the unbolded form the writer
# sometimes emits, which mashes all three categories onto one line).
# Example: 'Care Skills: x, y Soft Skills: a, b Other Skills: z'
_BOLD_CATEGORY_RE = re.compile(
    r'(\*\*[A-Z][^*:]+:\*\*\s*'
    r'|[A-Z][a-zA-Z]*\s+(?:Skills|Knowledge)\s*:\s*)'
)


def _split_compound_skills_item(original_text: str) -> List[str]:
    """
    Split a compound skills bullet that folds several categories into one line.

    LLM output patterns (bold or bare):
        'Care Skills: x, y **Soft Skills:** a, b **Other Skills:** z'
        'Care Skills: x, y Soft Skills: a, b Other Skills: z'
    both become:
        ['**Care Skills:** x, y', '**Soft Skills:** a, b', '**Other Skills:** z']

    Markers are normalised to the bold form so _strip_md_emphasis handles them
    downstream. If no category markers are found the text is returned unchanged.
    """
    parts = _BOLD_CATEGORY_RE.split(original_text)
    if len(parts) <= 1:
        return [original_text]     # no embedded categories — leave as-is

    result: List[str] = []
    # parts[0] = text before the first marker (empty when the line starts
    # with a category; non-empty only for stray leading prose).
    first = parts[0].strip()
    if first:
        result.append(first)

    # parts[1], parts[2], … = marker, items, marker, items, …
    for i in range(1, len(parts), 2):
        cat_name = parts[i].strip().strip("*").strip().rstrip(":").strip()
        items_text = parts[i + 1].strip().lstrip(",").strip() if i + 1 < len(parts) else ""
        result.append(f"**{cat_name}:** {items_text}" if items_text else f"**{cat_name}:**")

    return [r for r in result if r]


def _render_skills(items: List[Dict]) -> List[Any]:
    """
    Skills bullets, format: - **Category**: items, items, items
    Strip ** markers cleanly so they never appear as literal asterisks.

    Also handles compound bullets where the LLM writer folds multiple categories
    into one bullet using bold markers, e.g.:
        'Care Skills: x, y **Soft Skills:** a, b **Other Skills:** z'
    Each bold-marked category is expanded into its own bullet line.
    """
    out: List[Any] = []
    bullet_paras: List[Paragraph] = []
    pending_cat: Optional[str] = None
    seen_fp: set = set()

    # Pre-pass: expand compound items on the ORIGINAL text (before emphasis
    # strip) so the **Category:** markers are still present for detection.
    expanded: List[Dict] = []
    for item in items:
        original = item["text"].strip()
        sub_texts = _split_compound_skills_item(original)
        if len(sub_texts) > 1:
            for s in sub_texts:
                expanded.append({"type": item["type"], "text": s})
        else:
            expanded.append(item)

    for item in expanded:
        raw = _strip_md_emphasis(item["text"]).strip()
        if not raw:
            continue
        fp = _norm(raw)
        if fp in seen_fp:
            continue
        seen_fp.add(fp)

        if ":" in raw:
            colon = raw.index(":")
            cat = raw[:colon].strip()
            skills = raw[colon + 1:].strip()
            if skills:
                if pending_cat is not None:
                    pending_cat = None
                bullet_paras.append(Paragraph(
                    f"<b>{_escape(cat)}:</b> {_escape(skills)}",
                    _styles()["bullet_text"],
                ))
            else:
                pending_cat = cat
        else:
            if pending_cat is not None:
                bullet_paras.append(Paragraph(
                    f"<b>{_escape(pending_cat)}:</b> {_escape(raw)}",
                    _styles()["bullet_text"],
                ))
                pending_cat = None
            else:
                bullet_paras.append(_inline_markup(item["text"], _styles()["bullet_text"]))

    if pending_cat is not None:
        bullet_paras.append(Paragraph(
            f"<b>{_escape(pending_cat)}:</b>",
            _styles()["bullet_text"],
        ))

    for j, para in enumerate(bullet_paras):
        out.append(_bullet_row(para))
        if j < len(bullet_paras) - 1:
            out.append(_spacer(_cfg().skills_line_gap))
    return out


def _render_projects(items: List[Dict]) -> List[Any]:
    """
    Project headers may be h3 or bold paragraph. Format:
      ### Name – Subtitle | Tools | Date | URL
    or two-line:
      ### Name – Subtitle | Tools
      *Context | Date | URL*
    Followed by bullets.
    """
    out: List[Any] = []
    seen_fp: set = set()
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        if item["type"] in ("h3", "paragraph") and "|" in _strip_md_emphasis(item["text"]):
            text = _strip_md_emphasis(item["text"])
            fp = _norm(text)

            # Two-line shape?
            if (
                item["type"] == "h3"
                and i + 1 < len(items)
                and items[i + 1]["type"] == "paragraph"
                and _is_italic_only_line(items[i + 1]["text"])
            ):
                top_parts = _split_pipes(text)
                bot_text = _strip_md_emphasis(items[i + 1]["text"])
                bot_parts = _split_pipes(bot_text)
                fp = _norm(text + bot_text)
                consumed = 2
                left_text = " | ".join(top_parts)
                right_text = " | ".join(bot_parts)
            else:
                parts = _split_pipes(text)
                # Right column: trailing parts that look like a date/URL/short
                # status descriptor
                left_parts = list(parts)
                right_parts: List[str] = []
                while left_parts:
                    last = left_parts[-1]
                    is_date = bool(re.search(r'\b(19|20)\d{2}\b', last))
                    is_url = bool(re.search(r'https?://', last, re.I))
                    is_status = bool(re.match(r'(?i)^(live|production|live production|research|in progress|wip|completed|ongoing)$', last.strip()))
                    if is_date or is_url or is_status:
                        right_parts.insert(0, left_parts.pop())
                    else:
                        break
                consumed = 1
                left_text = " | ".join(left_parts)
                right_text = " | ".join(right_parts)

                # Promote em-dash context from left to right.
                # Match ONLY the em-dash (—, U+2014); preserve en-dashes (–)
                # that appear inside project names. Use the LAST occurrence so
                # nested em-dashes still split correctly.
                em_matches = list(re.finditer(r'\s+—\s+(.+?)$', left_text))
                if em_matches:
                    em = em_matches[-1]
                    ctx = em.group(1).strip()
                    left_text = left_text[:em.start()].strip()
                    right_text = (ctx + (" | " + right_text if right_text else "")).strip(" |")

            if fp in seen_fp:
                i += consumed
                # Still skip bullets that follow? No — bullets follow the
                # FIRST occurrence; the duplicate has none. Just skip header.
                continue
            seen_fp.add(fp)

            if entry_count > 0:
                out.append(_spacer(_cfg().subsection_gap))
            entry_count += 1

            # Build right paragraph: replace any URL with "Link" hyperlink
            url_match = re.search(r'https?://\S+', right_text)
            date_text = re.sub(r'https?://\S+', '', right_text).strip(" |").strip()
            if url_match and date_text:
                right_html = (
                    f'{_escape(date_text)} | '
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>'
                )
                right_para = Paragraph(right_html, _styles()["date_right"])
            elif url_match:
                right_para = Paragraph(
                    f'<a href="{url_match.group()}" color="{C_LINK.hexval()}">Link</a>',
                    _styles()["date_right"],
                )
            else:
                right_para = Paragraph(_escape(date_text), _styles()["date_right"])

            left_para = Paragraph(_escape(left_text), _styles()["project_name"])
            out.append(_two_col(left_para, right_para))

            i += consumed

            # Bullets
            b_start = i
            while i < len(items) and items[i]["type"] == "bullet":
                i += 1
            if i > b_start:
                out.extend(_render_bullets(items, b_start, i))
                out.append(_spacer(_cfg().after_bullets))
            continue

        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
            i += 1
            continue

        # Plain paragraph fallback (avoid emitting raw duplicate-looking lines)
        text = _strip_md_emphasis(item["text"])
        fp = _norm(text)
        if fp in seen_fp:
            i += 1
            continue
        out.append(_inline_markup(item["text"], _styles()["body"]))
        i += 1

    return out


_AWARD_DATE_TAIL_RE = re.compile(
    r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
    r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
    r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\b",
    re.IGNORECASE,
)

# Trailing parenthesised date on an award header line:
#   "Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)"
#   → left = "Staff Excellence Award, Jesmond Miranda Nursing Home"
#     date = "August 2025"
# Requires a 4-digit year inside the final parens so we never strip a non-date
# parenthetical (e.g. an acronym) as if it were the date.
_AWARD_TRAILING_DATE_RE = re.compile(
    r"^(.*?)\s*\(([^()]*\b(?:19|20)\d{2}\b[^()]*)\)\s*$"
)


def _render_awards(items: List[Dict]) -> List[Any]:
    """
    Awards entries — flat bullet layout, matching the web renderer:

      * Award Name, Organisation (Date)
            Concise description.

    Canonical markdown shape produced by _normalise_awards_entries:
      * Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)
        Recognised for hard work, caring nature, and positive attitude.

    Parsed as:
      bullet item:    "Name, Org (Date)"  → rendered verbatim as a bullet line
      paragraph item: "Description."      → indented continuation (optional)
    """
    out: List[Any] = []
    entry_count = 0
    i = 0

    while i < len(items):
        item = items[i]

        if item["type"] != "bullet":
            if item["text"].strip():
                out.append(_inline_markup(item["text"], _styles()["body"]))
            i += 1
            continue

        if entry_count > 0:
            out.append(_spacer(_cfg().subsection_gap))
        entry_count += 1

        # Header line "Award Name, Org (Date)" → two-column row with the date
        # right-aligned (matches Experience / Education), no bullet. The trailing
        # parenthesised date is split into the right column; a line with no date
        # renders as the left header alone.
        text = item["text"].strip()
        m = _AWARD_TRAILING_DATE_RE.match(text)
        if m:
            out.append(_two_col(
                Paragraph(_escape(m.group(1).strip()), _styles()["company_row"]),
                Paragraph(_escape(m.group(2).strip()), _styles()["date_right"]),
            ))
        else:
            out.append(Paragraph(_escape(text), _styles()["company_row"]))
        i += 1

        # Optional description: the paragraph that follows, full-width left
        # (no bullet indent now that the award header is a two-column row).
        if i < len(items) and items[i]["type"] == "paragraph":
            desc = items[i]["text"].strip()
            if desc:
                out.append(_inline_markup(desc, _styles()["body"]))
            i += 1

    return out


def _render_certifications(items: List[Dict]) -> List[Any]:
    out: List[Any] = []
    bullets = [it for it in items if it["type"] in ("bullet", "paragraph")]
    seen_fp: set = set()
    rendered: List[Paragraph] = []
    for item in bullets:
        text = item["text"].strip()
        fp = _norm(text)
        if fp in seen_fp or not text:
            continue
        seen_fp.add(fp)
        rendered.append(_inline_markup(text, _styles()["bullet_text"]))
    for j, para in enumerate(rendered):
        out.append(_bullet_row(para))
        if j < len(rendered) - 1:
            out.append(_spacer(_cfg().bullet_gap))
    return out


def _render_references(items: List[Dict]) -> List[Any]:
    """References section — parse GFM table rows produced by
    build_references_block (| Name, Title, Company | email |) into a
    two-column layout with right-aligned email, matching the markdown intent.

    Also handles the simple 'Available on request.' paragraph.
    """
    out: List[Any] = []
    entry_count = 0
    for item in items:
        text = item["text"].strip()
        if not text:
            continue
        # Skip GFM table header / alignment rows
        if re.match(r'^\|[\s:|-]+\|$', text):
            continue
        # Data row: | left content | right content |
        row_match = re.match(r'^\|\s*(.+?)\s*\|\s*(.*?)\s*\|$', text)
        if row_match:
            left_raw = row_match.group(1).strip()
            right_raw = row_match.group(2).strip()
            if not left_raw and not right_raw:
                continue
            if entry_count > 0:
                out.append(_spacer(_cfg().subsection_gap))
            entry_count += 1
            left_para = _inline_markup(left_raw, _styles()["body"])
            right_para = Paragraph(_escape(right_raw), _styles()["date_right"])
            out.append(_two_col(left_para, right_para))
            continue
        # Plain text fallback (e.g. "Available on request.")
        out.append(_inline_markup(text, _styles()["body"]))
    return out


def _render_section(stype: str, items: List[Dict]) -> List[Any]:
    if stype == "highlights":     return _render_highlights(items)
    if stype == "experience":     return _render_experience(items)
    if stype == "education":      return _render_education(items)
    if stype == "skills":         return _render_skills(items)
    if stype == "projects":       return _render_projects(items)
    if stype == "certifications": return _render_certifications(items)
    if stype == "awards":         return _render_awards(items)
    if stype == "references":     return _render_references(items)
    # Generic fallback
    out: List[Any] = []
    for item in items:
        if item["type"] == "bullet":
            out.append(_bullet_row(_inline_markup(item["text"], _styles()["bullet_text"])))
            out.append(_spacer(_cfg().bullet_gap))
        else:
            out.append(_inline_markup(item["text"], _styles()["body"]))
    return out


# ---------------------------------------------------------------------------
# Public API — adaptive layout engine
# ---------------------------------------------------------------------------

def _build_story(
    name: Optional[str],
    contact: Optional[str],
    sections: List[Tuple[str, List[Dict]]],
) -> List[Any]:
    """Build the ReportLab story list using the currently active config/styles."""
    story: List[Any] = []

    if name:
        story.append(Paragraph(_escape(name), _styles()["name"]))
    else:
        story.append(Spacer(1, 24))

    if contact:
        story.extend(_render_contact_line(contact))

    # Bucket sections by canonical type (preserving the AI's title text)
    section_map: Dict[str, Tuple[str, List[Dict]]] = {}
    extras: List[Tuple[str, List[Dict]]] = []
    for title, items in sections:
        key = _SECTION_ALIASES.get(title.lower())
        if key and key not in section_map:
            section_map[key] = (title, items)
        elif key:
            existing_title, existing_items = section_map[key]
            section_map[key] = (existing_title, existing_items + items)
        else:
            extras.append((title, items))

    # Render in canonical order
    for stype in _SECTION_ORDER:
        if stype not in section_map:
            continue
        ai_title, items = section_map[stype]
        if not items:
            continue
        display_title = ai_title or _SECTION_LABELS[stype]
        story.extend(_section_header(display_title))
        story.extend(_render_section(stype, items))

    # Then unknown sections (preserve original order)
    for title, items in extras:
        if not items:
            continue
        story.extend(_section_header(title))
        story.extend(_render_section("_unknown_", items))

    return story
