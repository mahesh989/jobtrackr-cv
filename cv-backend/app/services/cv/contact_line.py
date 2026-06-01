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


# ---------------------------------------------------------------------------
# Credentials line (nursing / healthcare / care families).
# Surfaces user-supplied credentials in a compact single-line ## Registration
# & Licences section. Only positive items appear (a user without a licence
# simply has no chip — never an "Absent" line). Role-family-gated so the
# block stays out of tech / general CVs entirely.
# ---------------------------------------------------------------------------

# Section heading inserted/replaced when stamping credentials. Tied to the
# nursing role-pack's section_order entry of the same name and the manual
# role-pack's "Certifications & Checks" entry — we use a single canonical
# heading and let the role-pack rename it via to_canonical/restore_and_order.
_CREDENTIALS_HEADING = "## Registration & Licences"

# Role families that surface credentials. Each picks a different subset of
# the unified credentials JSON via build_credentials_line(family_id=...).
_CREDENTIAL_FAMILIES = frozenset({"nursing", "manual"})


def build_credentials_line(
    contact_details: Optional[Dict[str, Any]],
    family_id: Optional[str] = "nursing",
) -> str:
    """Compose a compact middle-dot-separated line from the user's saved
    credentials, picking the family-relevant subset.

    Family subsets:
      nursing — AHPRA registration, clinical clearances (police/NDIS/WWCC),
                healthcare certs (First Aid/CPR/Medication Competency),
                vehicle (driver licence/car/insurance), status (work rights,
                flu/COVID vaccination).
      manual  — trade certs (White Card/Forklift), basic clearances (police/
                WWCC), vehicle, status (work rights).

    Empty / false / missing fields are skipped; the line never advertises
    what the candidate doesn't hold.
    """
    if not contact_details:
        return ""
    creds = contact_details.get("credentials") or {}
    if not isinstance(creds, dict) or not creds:
        return ""

    parts: List[str] = []
    family = (family_id or "nursing").lower()

    # 1. Registrations / trade certs (family-specific identity)
    if family == "nursing":
        ahpra = _clean(creds.get("ahpra_number"))
        if ahpra:
            parts.append(f"AHPRA {ahpra}")
    elif family == "manual":
        if creds.get("white_card"):
            parts.append("White Card")
        forklift = _clean(creds.get("forklift_licence"))
        if forklift:
            parts.append(f"Forklift Licence ({forklift})")

    # 2. Clearances — shared
    if creds.get("police_check"):
        parts.append("National Police Check")
    if family == "nursing" and creds.get("ndis_screening"):
        parts.append("NDIS Worker Screening")
    if creds.get("wwcc"):
        state = _clean(creds.get("wwcc_state"))
        parts.append(f"Working with Children Check ({state})" if state else "Working with Children Check")

    # 3. Healthcare-only skill certs
    if family == "nursing":
        if creds.get("first_aid"):
            parts.append("First Aid (HLTAID011)")
        if creds.get("cpr"):
            parts.append("CPR (HLTAID009)")
        if creds.get("medication_competency"):
            parts.append("Medication Competency")

    # 4. Practical / transport — shared
    licence = _clean(creds.get("drivers_licence"))
    if licence:
        if licence.lower() == "yes":
            parts.append("Driver Licence")
        elif licence.lower() == "no":
            pass
        else:
            parts.append(f"Driver Licence ({licence})")
    if creds.get("own_car"):
        parts.append("Own a car")

    # 5. Status — shared
    rights = _clean(creds.get("work_rights"))
    hours = _clean(creds.get("work_rights_hours"))
    if rights:
        if rights == "Visa with work rights" and hours:
            parts.append(f"Working Right ({hours})")
        else:
            parts.append(f"Work Rights ({rights})")
    if family == "nursing":
        if creds.get("flu_vaccination"):
            parts.append("Influenza Vaccination")
        if creds.get("covid_vaccination"):
            parts.append("COVID-19 Vaccination")

    return " · ".join(parts)


def stamp_credentials(
    markdown: str,
    contact_details: Optional[Dict[str, Any]],
    role_family_id: Optional[str],
) -> str:
    """Stamp the user's credentials into the ``## Registration & Licences``
    section as a single compact line. No-op when:
      • the role family is not credentialed (e.g. tech / manual / general),
      • no credentials are supplied,
      • the assembled line would be empty.

    When an existing Registration & Licences section is present, its body is
    REPLACED with the deterministic line (the user's saved credentials are
    authoritative). When the section is absent, a new section is inserted at
    the natural slot — directly after the H1 / contact paragraph and before
    the first content section (Summary, Experience, etc.).
    """
    if not markdown:
        return markdown
    if role_family_id not in _CREDENTIAL_FAMILIES:
        return markdown
    line = build_credentials_line(contact_details, family_id=role_family_id)
    if not line:
        return markdown

    lines = markdown.split("\n")

    # Locate an existing Registration & Licences section (case-insensitive
    # match on the heading text after "## "). Replace its body with the
    # deterministic line so we never compound user input with AI noise.
    start_idx = next(
        (i for i, l in enumerate(lines)
         if l.startswith("## ") and l[3:].strip().lower().rstrip(":") == "registration & licences"),
        -1,
    )
    if start_idx >= 0:
        end_idx = next(
            (j for j in range(start_idx + 1, len(lines)) if lines[j].startswith("## ")),
            len(lines),
        )
        new_block = [_CREDENTIALS_HEADING, "", line, ""]
        lines = lines[:start_idx] + new_block + lines[end_idx:]
        return "\n".join(lines)

    # Section absent — append at end of the markdown document
    return markdown.rstrip("\n") + f"\n\n{_CREDENTIALS_HEADING}\n\n{line}\n"
