"""Certification and education entry handling.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple
import re
from ._common import logger

def _cert_policy_for(jd_analysis: Optional[Dict[str, Any]]) -> str:
    """Resolve the role family's cert_policy
    ("first_class" | "plus" | "rare" | "excluded") for the given JD
    analysis. Empty string on any failure (treated as non-first-class,
    non-excluded — i.e. the default strip-when-Projects-exists behaviour)."""
    if not jd_analysis:
        return ""
    try:
        from app.services.eval.role_families import resolve_role_family
        rf = resolve_role_family(jd_analysis.get("role_family"), jd_analysis)
        return getattr(rf, "cert_policy", "") or ""
    except Exception:  # noqa: BLE001 — never block structure enforcement on this
        return ""


def _strip_certs_when_projects_exist(markdown: str, cert_policy: str = "") -> str:
    """
    If ## Projects is present, remove ## Certifications entirely.
    The prompt rule (projects beat certs) is routinely ignored by the AI;
    this enforces it deterministically.

    EXCEPTION — first_class cert families (manual): certs ARE the
    qualification there (e.g. White Card, forklift licence). Stripping them
    in favour of Projects silently drops the candidate's most role-relevant
    credential. For this family the Certifications section is preserved
    even when Projects exist (mirrors composition.py's first_class policy:
    "certs outrank projects").

    "excluded" families (nursing/health sector) never reach the has_projects
    check at all — _strip_certs_when_excluded, called earlier in
    _enforce_structure, has already removed the section unconditionally.
    """
    if cert_policy == "first_class":
        return markdown
    lines = markdown.split("\n")
    has_projects = any(ln.strip() == "## Projects" for ln in lines)
    if not has_projects:
        return markdown

    cert_start = next(
        (i for i, ln in enumerate(lines) if ln.strip() == "## Certifications"),
        None,
    )
    if cert_start is None:
        return markdown

    cert_end = next(
        (i for i in range(cert_start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return "\n".join(lines[:cert_start] + lines[cert_end:])


def _strip_certs_when_excluded(markdown: str, cert_policy: str = "") -> str:
    """
    Unconditionally remove ## Certifications for "excluded" cert-policy
    families (health sector) — regardless of whether ## Projects is present.

    Distinct from _strip_certs_when_projects_exist, which only strips when
    Projects and Certifications are competing for the one-page budget: health
    sector CVs rarely have a Projects section at all, so that rule alone
    never fires for them and a raw AI-written Certifications section (or one
    reintroduced later by verify_claims — see the re-run call in _impl.py)
    survives to the final output. Call this BEFORE
    _strip_certs_when_projects_exist so an AQF qualification cert still gets
    a chance to be promoted into Education first (via
    _promote_qualification_cert_to_education, which also runs for
    "excluded") — this function then drops whatever is left.
    """
    if cert_policy != "excluded":
        return markdown
    lines = markdown.split("\n")
    cert_start = next(
        (i for i, ln in enumerate(lines) if ln.strip() == "## Certifications"),
        None,
    )
    if cert_start is None:
        return markdown

    cert_end = next(
        (i for i in range(cert_start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return "\n".join(lines[:cert_start] + lines[cert_end:])


# An AQF qualification certificate (Certificate I–IV / Diploma / Advanced
# Diploma) is an *educational* qualification — the foundational credential that
# qualifies a candidate for the role (e.g. "Certificate IV in Ageing Support"
# for an AIN). It is NOT a licence/check (First Aid, CPR, Police Check, WWCC,
# Driver Licence) — those carry no AQF level and stay in Certifications. The
# level token (I–IV or 1–4) immediately after "Cert(ificate)" is what
# distinguishes the two, so "First Aid Certificate" / "Certificate of
# Completion" deliberately do NOT match.
_QUAL_CERT_RE = re.compile(
    r"\bcert(?:ificate)?\s+(?:iv|iii|ii|i|[1-4])\b"   # Certificate I–IV / Cert IV
    r"|\b(?:advanced\s+)?diploma\b",                   # Diploma / Advanced Diploma
    re.IGNORECASE,
)


def _norm_credential(text: str) -> str:
    """Lowercase + strip markdown/punctuation noise for substring comparison."""
    text = re.sub(r"[*_>#`\[\]]", "", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def _split_cert_entry(entry: str) -> Tuple[str, str, str]:
    """Parse a one-line certification entry into (qualification, institution,
    date). institution/date are "" when the entry doesn't carry them.

    Handles the common production shapes:
      Certificate IV in Ageing Support — Heritage Skills Institute 2025
      Certificate IV in Ageing Support, Heritage Skills Institute (May 2025)
      Certificate III in Individual Support – TAFE NSW
      Diploma of Nursing
    """
    text = re.sub(r"\*+", "", entry).strip()
    date = ""
    # Trailing date: an optional real month name, a 4-digit year, and an
    # optional range. The month must be an actual month token (not just any
    # 3–9 letter word) so an issuer like "…Institute 2025" doesn't get its
    # last word swallowed into the date.
    _month = (
        r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
    )
    m = re.search(
        r"[(,–—-]?\s*("
        rf"(?:{_month}\s+)?(?:19|20)\d{{2}}"
        rf"(?:\s*[–—-]\s*(?:Present|(?:{_month}\s+)?(?:19|20)\d{{2}}))?"
        r")\)?\s*$",
        text,
        re.IGNORECASE,
    )
    if m:
        date = m.group(1).strip()
        text = text[: m.start()].rstrip(" ,–—-(").strip()
    text = text.strip().rstrip(")").strip()
    # Split qualification from institution on the first strong separator.
    parts = re.split(r"\s+[–—|]\s+|\s+-\s+|,\s+|\s*\(", text, maxsplit=1)
    qualification = re.sub(r"\*+", "", parts[0]).strip().rstrip(",–—-").strip()
    institution = (
        re.sub(r"\*+", "", parts[1]).strip().rstrip(")").strip() if len(parts) > 1 else ""
    )
    return qualification, institution, date


def _promote_qualification_cert_to_education(
    markdown: str, cert_policy: str = ""
) -> str:
    """For first_class cert families (manual) AND excluded families (health
    sector, which no longer gets a Certifications section at all), surface
    an AQF qualification certificate under ## Education — consistently,
    regardless of whether the source CV listed it under Education or
    Certifications.

    The bug this fixes: two AINs with the same "Certificate IV in Ageing
    Support" rendered differently — one had it in Education (source put it
    there), the other had it under Certifications. For these families the
    certificate IS the educational qualification, so it belongs in Education
    every time. When such a cert is found in ## Certifications but not already in
    ## Education, it is moved (inserted at the top of Education — role-critical
    and most recent — and removed from Certifications, which is dropped if it
    becomes empty).

    Runs for "excluded" too so an AQF qual isn't lost when
    _strip_certs_when_excluded wipes whatever remains under Certifications
    right after this — see the call order in _enforce_structure.

    No-op unless cert_policy is "first_class" or "excluded". Conservative by
    construction:
      • only AQF qualification certs move (licences/checks stay put);
      • a cert already represented in Education is left untouched (the
        cross-section dedupe pass owns that case);
      • a cert with no parseable issuer is left in Certifications rather than
        emit a malformed Education entry (it is never dropped — for
        "excluded" families it is instead dropped moments later by
        _strip_certs_when_excluded, which is the intended outcome there).
    """
    if cert_policy not in ("first_class", "excluded"):
        return markdown

    lines = markdown.split("\n")

    def _bounds(heading: str) -> Tuple[Optional[int], int]:
        start = next((i for i, l in enumerate(lines) if l.strip() == heading), None)
        if start is None:
            return None, 0
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
            len(lines),
        )
        return start, end

    edu_start, edu_end = _bounds("## Education")
    cert_start, cert_end = _bounds("## Certifications")
    if edu_start is None or cert_start is None:
        return markdown  # need both a source and a destination

    edu_blob = _norm_credential(" ".join(lines[edu_start + 1 : edu_end]))

    promoted: list[Tuple[str, str, str]] = []  # (institution, qualification, date)
    kept_cert: list[str] = []
    for ln in lines[cert_start + 1 : cert_end]:
        s = ln.strip()
        entry = re.sub(r"^\s*(?:[-*•]|#{1,6})\s*", "", s)
        if not (s and _QUAL_CERT_RE.search(entry)):
            kept_cert.append(ln)
            continue
        qualification, institution, date = _split_cert_entry(entry)
        qual_norm = _norm_credential(qualification)
        if qual_norm and qual_norm in edu_blob:
            kept_cert.append(ln)  # already in Education — dedupe pass owns this
            continue
        if not institution:
            kept_cert.append(ln)  # can't form a clean Education block — leave it
            continue
        promoted.append((institution, qualification, date))

    if not promoted:
        return markdown

    # Build the promoted Education entries (h3 + italic two-line blocks).
    promoted_lines: list[str] = []
    for institution, qualification, date in promoted:
        promoted_lines.append(f"### {institution}")
        promoted_lines.append(f"*{qualification}" + (f" | {date}" if date else "") + "*")
        promoted_lines.append("")

    edu_body = lines[edu_start + 1 : edu_end]
    while edu_body and not edu_body[0].strip():
        edu_body.pop(0)
    while edu_body and not edu_body[-1].strip():
        edu_body.pop()
    new_edu = [lines[edu_start], ""] + promoted_lines + edu_body + [""]

    while kept_cert and not kept_cert[0].strip():
        kept_cert.pop(0)
    while kept_cert and not kept_cert[-1].strip():
        kept_cert.pop()
    new_cert = [lines[cert_start], ""] + kept_cert + [""] if kept_cert else []

    # Splice both sections back in, replacing the higher index first so the
    # lower-index replacement keeps its offsets (sections may be in any order).
    result = list(lines)
    for start, end, repl in sorted(
        [(edu_start, edu_end, new_edu), (cert_start, cert_end, new_cert)],
        reverse=True,
    ):
        result[start:end] = repl

    logger.info(
        "w8: promoted %d qualification cert(s) into Education (cert_policy=%s)",
        len(promoted), cert_policy,
    )
    return "\n".join(result)


def _enforce_education_count(markdown: str, max_entries: int = 3) -> str:
    """Cap Education section to max_entries degree blocks (h3 + optional italic line)."""
    EDU_HEADING = "## Education"
    lines = markdown.split("\n")

    edu_start = next((i for i, l in enumerate(lines) if l.strip() == EDU_HEADING), None)
    if edu_start is None:
        return markdown

    edu_end = len(lines)
    for i in range(edu_start + 1, len(lines)):
        if lines[i].startswith("## "):
            edu_end = i
            break

    body_lines = lines[edu_start + 1 : edu_end]

    entry_count = 0
    cutoff = len(body_lines)
    for i, line in enumerate(body_lines):
        if line.startswith("### "):
            entry_count += 1
            if entry_count > max_entries:
                cutoff = i
                break

    return "\n".join(lines[: edu_start + 1] + body_lines[:cutoff] + lines[edu_end:])


def _strip_education_bullets(markdown: str) -> str:
    """
    Defensive post-processor: strip bullets from the Education section.

    The prompt instructs the LLM to emit each degree as a two-line block
    (### Institution | Location ↵ *Degree | Year*) and explicitly forbids
    bullets under degrees. But LLMs occasionally hallucinate filler bullets
    like "Leveraged this program to navigate higher education data
    requirements…" which is content the model invented to pad the entry.

    The renderer's two-column row layout also can't align bullets — they
    sit awkwardly between two formatted rows.

    Strategy: inside ## Education only, drop any line that starts with a
    bullet marker (-, *, •). Keep the H3 headings and the italic subtitle
    lines. Stop at the next ## section.
    """
    EDU_HEADING = "## Education"
    lines = markdown.split("\n")

    edu_start = next((i for i, l in enumerate(lines) if l.strip() == EDU_HEADING), None)
    if edu_start is None:
        return markdown

    edu_end = len(lines)
    for i in range(edu_start + 1, len(lines)):
        if lines[i].startswith("## "):
            edu_end = i
            break

    cleaned: list[str] = []
    bullet_re = re.compile(r"^\s*[-*•]\s+")
    for line in lines[edu_start + 1 : edu_end]:
        if bullet_re.match(line):
            continue  # drop the bullet line
        cleaned.append(line)

    # Collapse runs of >2 blank lines that may have been left behind.
    out: list[str] = []
    blank_run = 0
    for line in cleaned:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= 2:
                out.append(line)
        else:
            blank_run = 0
            out.append(line)

    return "\n".join(lines[: edu_start + 1] + out + lines[edu_end:])
