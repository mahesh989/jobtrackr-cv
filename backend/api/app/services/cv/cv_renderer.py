"""Canonical CV renderer — structured CV → consistent markdown text.

Used by:
  • the upload + review-save path: render → store on
    cv_versions.normalized_cv_text → analysis pipeline reads this.

This is the second half of the consistency story (the first being the
structurizer). Same structured CV → same rendered text → same downstream
behaviour for every candidate, regardless of how the original CV was laid
out.

Order is fixed (Skills above Summary per product call):

  1. Contact line
  2. Professional Summary
  3. Skills
  4. Experience
  5. Education
  6. Certifications & licences  (omitted if empty)
  7. References

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

    # Heading: name as H1
    name = _str((structured.get("contact") or {}).get("name"))
    if name:
        out.append(f"# {name}")
        out.append("")

    # Contact line
    contact_line = _render_contact_line(structured.get("contact") or {})
    if contact_line:
        out.append(contact_line)
        out.append("")

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

    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------

def _render_contact_line(contact: Dict[str, Any]) -> str:
    parts: List[str] = []
    location = _str(contact.get("location"))
    if location:
        parts.append(location)
    phone = _str(contact.get("phone"))
    if phone:
        parts.append(phone)
    email = _str(contact.get("email"))
    if email:
        parts.append(f"[{email}](mailto:{email})")
    for link in contact.get("links") or []:
        link_s = _str(link)
        if link_s:
            parts.append(link_s)
    return " · ".join(parts)


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
