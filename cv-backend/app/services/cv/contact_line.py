"""
Stamp a clean, consistent contact line onto the tailored CV markdown.

Why post-process: the AI sometimes drops a profile, formats the URL as a
bare link instead of `[Label](url)`, or merges everything onto one line
with awkward separators. This step replaces the contact paragraph (the
line(s) between the # H1 and the first ## section) with a deterministically
built one driven by the user's saved contact_details.

Selection rules — keep the line concise:
  - Always shown if present: phone, email, address (user-controlled verbosity).
  - Hyperlinks shown if present: LinkedIn, GitHub, Portfolio.
  - "Website" is shown only when there is no Portfolio (avoid both — they
    duplicate each other in most cases).
  - Other (label + url) shown if both fields are filled.

If contact_details is None / empty, the markdown is returned unchanged.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


def stamp_contact_line(markdown: str, contact_details: Optional[Dict[str, Any]]) -> str:
    if not markdown:
        return markdown
    if not contact_details:
        return markdown

    parts = _build_contact_parts(contact_details)
    if not parts:
        return markdown
    new_contact_line = " | ".join(parts)

    lines = markdown.splitlines()

    # Locate the H1 (name) line
    h1_idx = next((i for i, l in enumerate(lines) if re.match(r"^#\s+\S", l)), -1)
    if h1_idx == -1:
        # No H1 — prepend a header + contact line so the CV is well-formed
        name = contact_details.get("name") or ""
        prefix: List[str] = []
        if name:
            prefix.append(f"# {name}")
        prefix.append(new_contact_line)
        prefix.append("")
        return "\n".join(prefix + lines)

    # Optionally update the H1 if the user has a saved name
    if contact_details.get("name"):
        lines[h1_idx] = f"# {contact_details['name'].strip()}"

    # Find the first ## section after H1
    next_h2 = next(
        (i for i, l in enumerate(lines) if i > h1_idx and re.match(r"^##\s+", l)),
        len(lines),
    )

    # Replace everything between H1 and next H2 with: blank, contact_line, blank
    new_block = ["", new_contact_line, ""]
    lines = lines[: h1_idx + 1] + new_block + lines[next_h2:]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_contact_parts(cd: Dict[str, Any]) -> List[str]:
    """Return ordered list of contact-line segments. Each segment is plain
    text or a markdown link `[Label](url)`."""
    parts: List[str] = []

    address = _clean(cd.get("address"))
    phone = _clean(cd.get("phone"))
    email = _clean(cd.get("email"))
    linkedin = _normalise_url(cd.get("linkedin"))
    github = _normalise_url(cd.get("github"))
    portfolio = _normalise_url(cd.get("portfolio"))
    website = _normalise_url(cd.get("website"))
    other_label = _clean(cd.get("other_label"))
    other_url = _normalise_url(cd.get("other_url"))

    if address:
        parts.append(address)
    if phone:
        parts.append(phone)
    if email:
        # mailto link so it's clickable in the rendered HTML / PDF
        parts.append(f"[{email}](mailto:{email})")
    if linkedin:
        parts.append(f"[LinkedIn]({linkedin})")
    if github:
        parts.append(f"[GitHub]({github})")
    # Show Portfolio if present, otherwise fall back to Website (avoid both)
    if portfolio:
        parts.append(f"[Portfolio]({portfolio})")
    elif website:
        parts.append(f"[Website]({website})")
    if other_label and other_url:
        parts.append(f"[{other_label}]({other_url})")

    return parts


def _clean(value: Optional[str]) -> str:
    if not value:
        return ""
    return str(value).strip()


def _normalise_url(value: Optional[str]) -> str:
    """Ensure the URL has a scheme. Empty input → empty output."""
    raw = _clean(value)
    if not raw:
        return ""
    if not re.match(r"^https?://", raw, re.I):
        return f"https://{raw}"
    return raw
