"""Canonical CV renderer — structured CV → consistent markdown text.

Used by:
  • the upload + review-save path: render → store on
    cv_versions.normalized_cv_text → analysis pipeline reads this.

This is the second half of the consistency story (the first being the
structurizer). Same structured CV → same rendered text → same downstream
behaviour for every candidate, regardless of how the original CV was laid
out.

Order is fixed (Skills above Summary per product call):

  1. Skills
  2. Professional Summary
  3. Experience
  4. Education
  5. Projects             (omitted if empty)
  6. Languages            (omitted if empty)
  7. Awards               (omitted if empty)
  8. Certifications & licences  (omitted if empty)
  9. References
 10. Custom sections      (built-from-scratch CVs only; omitted if empty)

Contact details are NOT rendered here — the analysis orchestrator stamps
the contact line from the user's profile via stamp_contact_line(). The
review form has no contact section; the user edits their contact via the
profile page.

Dates and content are rendered verbatim — never altered, never inferred.
Sections with no content are simply omitted; the same structured CV always
renders to the same text (pure function).
"""
from __future__ import annotations

from typing import Any, Dict, List


def render_canonical_cv(structured: Dict[str, Any]) -> str:
    """Render a structured CV into canonical markdown text. Pure + deterministic."""
    structured = structured or {}
    out: List[str] = []

    # No name/contact line — the orchestrator's stamp_contact_line() adds
    # them from the user profile when the analysis pipeline runs.

    # Professional Summary (rendered AFTER Skills per product call, but the
    # bucket order chose Skills above Summary because skills lead with what
    # the candidate offers — recruiters in care/AIN scan skills first).
    skills_block = _render_skills(structured.get("skills") or {})
    if skills_block:
        out.append("## Skills")
        out.append("")
        out.extend(skills_block)
        out.append("")

    summary = _str(structured.get("summary"))
    if summary:
        out.append("## Professional Summary")
        out.append("")
        out.append(summary)
        out.append("")

    # Experience
    experience = structured.get("experience") or []
    if experience:
        out.append("## Experience")
        out.append("")
        for entry in experience:
            out.extend(_render_experience_entry(entry))
            out.append("")

    # Education
    education = structured.get("education") or []
    if education:
        out.append("## Education")
        out.append("")
        for entry in education:
            out.extend(_render_education_entry(entry))
            out.append("")

    # Projects (omitted when empty). Built-from-scratch CVs carry projects in
    # the structured doc; the tailoring composer recognises the ## Projects
    # heading and references 1-2 relevant projects per the prompt rules.
    projects = structured.get("projects") or []
    if projects:
        project_lines: List[str] = []
        for p in projects:
            project_lines.extend(_render_project_lines(p))
        if project_lines:
            out.append("## Projects")
            out.append("")
            out.extend(project_lines)
            out.append("")

    # Languages (omitted when empty). Not used by the tailored-CV composer
    # — preserved so the original verbatim view stays complete.
    languages = structured.get("languages") or []
    if languages:
        out.append("## Languages")
        out.append("")
        for l in languages:
            line = _render_language_line(l)
            if line:
                out.append(f"- {line}")
        out.append("")

    # Awards (omitted when empty)
    awards = structured.get("awards") or []
    if awards:
        out.append("## Awards")
        out.append("")
        for a in awards:
            for line in _render_award_lines(a):
                out.append(line)
        out.append("")

    # Certifications & licences (omitted when empty — care VET quals get
    # routed to Education upstream by the structurizer).
    certifications = structured.get("certifications") or []
    if certifications:
        out.append("## Certifications & Licences")
        out.append("")
        for c in certifications:
            out.append(_render_cert_line(c))
        out.append("")

    # References
    references = structured.get("references") or []
    if references:
        out.append("## References")
        out.append("")
        for r in references:
            line = _render_reference_line(r)
            if line:
                out.append(f"- {line}")
        out.append("")

    # Custom sections (built-from-scratch CVs only) — user-defined heading +
    # label/value field pairs. Rendered last so they never displace canonical
    # sections. Empty sections (no field with a value) are omitted.
    custom_sections = structured.get("custom_sections") or []
    for sect in custom_sections:
        title = _str(sect.get("title"))
        fields = sect.get("fields") or []
        rendered_fields: List[str] = []
        for f in fields:
            label = _str(f.get("label"))
            value = _str(f.get("value"))
            if not value and not label:
                continue
            if label and value:
                rendered_fields.append(f"- **{label}:** {value}")
            elif value:
                rendered_fields.append(f"- {value}")
            elif label:
                rendered_fields.append(f"- {label}")
        if title and rendered_fields:
            out.append(f"## {title}")
            out.append("")
            out.extend(rendered_fields)
            out.append("")

    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------

def _render_language_line(l: Dict[str, Any]) -> str:
    lang = _str(l.get("language"))
    prof = _str(l.get("proficiency"))
    if not lang and not prof:
        return ""
    if lang and prof:
        return f"{lang} ({prof})"
    return lang or prof


def _render_project_lines(p: Dict[str, Any]) -> List[str]:
    name = _str(p.get("name"))
    url = _str(p.get("url"))
    description = _str(p.get("description"))
    title_parts: List[str] = []
    if name:
        title_parts.append(f"**{name}**")
    if url:
        title_parts.append(f"[{url}]({url})")
    lines: List[str] = []
    if title_parts:
        lines.append(f"- {' · '.join(title_parts)}")
    if description:
        lines.append(f"  {description}")
    return lines


def _render_award_lines(a: Dict[str, Any]) -> List[str]:
    name = _str(a.get("name"))
    issuer = _str(a.get("issuer"))
    location = _str(a.get("location"))
    date = _str(a.get("date"))
    description = _str(a.get("description"))
    parts: List[str] = []
    if name:
        parts.append(name)
    if issuer:
        parts.append(issuer)
    if location:
        parts.append(location)
    if date:
        parts.append(date)
    lines: List[str] = []
    if parts:
        lines.append(f"- {' · '.join(parts)}")
    if description:
        lines.append(f"  {description}")
    return lines


def _render_skills(skills: Dict[str, Any]) -> List[str]:
    """Skills line per category, with a consistent label per category for the
    nursing/care vertical (Care Skills / Soft Skills / Other Skills). The
    pipeline relies on these exact labels (lib/atsThresholds + lexicon)."""
    lines: List[str] = []
    domain = skills.get("domain_knowledge") or []
    soft = skills.get("soft_skills") or []
    technical = skills.get("technical") or []
    if domain:
        lines.append(f"- **Care Skills:** {_skill_join(domain)}")
    if soft:
        lines.append(f"- **Soft Skills:** {_skill_join(soft)}")
    if technical:
        lines.append(f"- **Other Skills:** {_skill_join(technical)}")
    return lines


def _skill_join(items: List[Any]) -> str:
    """Title-Case each skill, join with comma+space. De-duplicates and
    drops blanks."""
    seen: set[str] = set()
    out: List[str] = []
    for it in items:
        s = _str(it)
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(_title_skill(s))
    return ", ".join(out)


def _title_skill(s: str) -> str:
    """Title-case for a skill, preserving small connectives + acronyms."""
    SMALL = {"and", "or", "of", "in", "for", "the", "to", "a", "an", "on", "with"}
    ACRONYMS = {"cpr", "ndis", "ain", "pcw", "rn", "en", "bgl", "iv", "iii", "co2", "spo2", "obs"}
    words = s.split()
    out: List[str] = []
    for i, w in enumerate(words):
        low = w.lower()
        if low in ACRONYMS:
            out.append(low.upper())
        elif i > 0 and low in SMALL:
            out.append(low)
        else:
            out.append(low[:1].upper() + low[1:])
    return " ".join(out)


def _render_experience_entry(entry: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    employer = _str(entry.get("employer"))
    location = _str(entry.get("location"))
    role = _str(entry.get("role"))
    dates = _join_dates(entry.get("start_date"), entry.get("end_date"))

    head = f"### {employer}" if employer else "###"
    if location:
        head += f" | {location}"
    lines.append(head)

    role_line_parts: List[str] = []
    if role:
        role_line_parts.append(role)
    if dates:
        role_line_parts.append(dates)
    if role_line_parts:
        lines.append(f"*{' | '.join(role_line_parts)}*")
    lines.append("")

    for bullet in entry.get("bullets") or []:
        b = _str(bullet)
        if b:
            lines.append(f"- {b}")
    return lines


def _render_education_entry(entry: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    institution = _str(entry.get("institution"))
    location = _str(entry.get("location"))
    qualification = _str(entry.get("qualification"))
    dates = _join_dates(entry.get("start_date"), entry.get("end_date"))

    head = f"### {institution}" if institution else "###"
    if location:
        head += f" | {location}"
    lines.append(head)

    italic_parts: List[str] = []
    if qualification:
        italic_parts.append(qualification)
    if dates:
        italic_parts.append(dates)
    elif not entry.get("completed"):
        italic_parts.append("Ongoing")
    if italic_parts:
        lines.append(f"*{' | '.join(italic_parts)}*")
    return lines


def _render_cert_line(cert: Dict[str, Any]) -> str:
    name = _str(cert.get("name"))
    code = _str(cert.get("code"))
    issuer = _str(cert.get("issuer"))
    date = _str(cert.get("issued_date"))
    parts: List[str] = []
    if name:
        if code:
            parts.append(f"{name} ({code})")
        else:
            parts.append(name)
    if issuer:
        parts.append(issuer)
    if date:
        parts.append(date)
    return f"- {' · '.join(parts)}" if parts else ""


def _render_reference_line(r: Dict[str, Any]) -> str:
    name = _str(r.get("name"))
    job_title = _str(r.get("job_title"))
    company = _str(r.get("company"))
    email = _str(r.get("email"))
    pieces: List[str] = []
    if name:
        pieces.append(name)
    if job_title:
        pieces.append(job_title)
    if company:
        pieces.append(company)
    line = " · ".join(pieces)
    if email:
        line += f" — [{email}](mailto:{email})"
    return line


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _join_dates(start: Any, end: Any) -> str:
    s, e = _str(start), _str(end)
    if s and e:
        return f"{s} – {e}"
    return s or e  # one or zero of them
