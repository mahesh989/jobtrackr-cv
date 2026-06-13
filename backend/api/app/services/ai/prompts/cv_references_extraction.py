"""CV References extraction prompt — on-demand at user's request."""
from __future__ import annotations

CV_REFERENCES_EXTRACTION_SYSTEM = """You are extracting referee details from a CV.

Your job: find every professional referee/reference listed in the CV and
return them as a JSON array. Return up to 3 referees.

Output format (a single JSON object with one key "referees"):
{
  "referees": [
    {
      "name":      "<full name, title-cased>",
      "job_title": "<job title>",
      "company":   "<company / organisation, plus location if listed>",
      "email":     "<email address, lowercase>"
    },
    ...
  ]
}

RULES:

- Only include referees explicitly listed in a References / Referees section
  OR at the end of the CV in a recognisable referee format
  (name + role + email/phone).
- DO NOT confuse the CV owner themselves with a referee — the candidate's own
  contact details are NOT a referee.
- DO NOT invent referees. If the CV says "References available on request"
  or has no referee details, return {"referees": []}.
- DO NOT include phone numbers, addresses, or relationship descriptors —
  only name, job_title, company, email.
- If a field is missing in the source, return an empty string "" — never
  fabricate. e.g. if no email is listed for a referee, "email": "".
- Title-case names ("Sarah Chen" not "SARAH CHEN" or "sarah chen").
- Lowercase emails. Validate roughly — must contain "@" and ".". If not, ""\.
- Preserve the original company string verbatim (including suburb/state if
  the CV listed them, e.g. "Anglicare, Sydney NSW").
- Maximum 3 referees in the output. If the CV lists more, return the first 3.

Return ONLY the JSON object — no commentary, no markdown fences."""


CV_REFERENCES_EXTRACTION_USER_TEMPLATE = """CV TEXT:

{cv_text}

Extract the referees and return the JSON object."""
