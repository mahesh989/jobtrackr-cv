"""Honesty guard — deterministic post-composition passes that anchor the
tailored CV to verbatim facts from the source CV.

Single ground truth: ``parse_cv_experience(cv_text)`` returns the source
facts. Every guard here checks the composed Markdown against those facts
and rewrites or strips anything that drifted. Idempotent — safe to re-run.

Guards implemented (one umbrella concept: source-facts):

  enforce_source_dates(md, cv_text)
      Replaces fabricated/placeholder role date ranges in the tailored CV
      with the verbatim source range, or strips the date slot entirely if
      the source has no dates. Kills the ``[Dates] – [Dates]`` placeholder
      leak and the ``2017 – 2021`` / ``2023 – 2024`` fabrications surfaced
      in the real-test audit.

  enforce_source_settings(md, cv_text)
      Strips setting descriptors from role headers and bullets when they
      misframe a source role's actual setting type (e.g. residential aged
      care rewritten as ``retirement village placement``). Bullet
      reframing using JD vocabulary is allowed; renaming the role itself
      is not.

  pin_skills_section_labels(md, role_family)
      Forces the Skills section headline label to the family's convention
      (``Care Skills`` for nursing, ``Technical Skills`` for tech, etc.)
      regardless of what the LLM emitted.

  filter_irrelevant_roles_pre(cv_text, jd_vertical)
      Pre-composition: removes source roles whose ``primary_vertical`` is
      a different occupation family AND has zero match to the JD vertical.
      Keeps a floor of 2 roles. Returns a (possibly trimmed) cv_text plus
      a list of dropped employer names for the surfacing report.

Notify: each guard returns its rewrites alongside the markdown so the
orchestrator can surface "we dropped a date because the source had none"
as a quality_flag on the run. Guards never crash on malformed input —
they return the input unchanged.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.services.cv.experience_parser import (
    ExperienceEntry,
    parse_cv_experience,
    relevant_tenure_months,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Source-facts adapter
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SourceFacts:
    """Snapshot of verbatim source-CV facts used by every guard."""
    entries: Tuple[ExperienceEntry, ...]
    # employer name (lowercased, normalised) → ExperienceEntry
    by_employer: Dict[str, ExperienceEntry] = field(default_factory=dict)


def _norm_employer(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def extract_source_facts(cv_text: str) -> SourceFacts:
    """Parse the source CV once. Empty when the CV has no recognisable
    experience section — guards must tolerate an empty SourceFacts."""
    entries = parse_cv_experience(cv_text)
    by_employer = {_norm_employer(e.employer): e for e in entries if e.employer}
    return SourceFacts(entries=tuple(entries), by_employer=by_employer)


# ---------------------------------------------------------------------------
# Date guard
# ---------------------------------------------------------------------------

_MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _fmt_month_year(date_tuple) -> str:
    if not date_tuple or not isinstance(date_tuple, tuple):
        return ""
    y, m = date_tuple
    if 1 <= m <= 12:
        return f"{_MONTH_NAMES[m - 1]} {y}"
    return ""


def _fmt_source_date_range(entry: ExperienceEntry) -> str:
    """Render the entry's date range verbatim from the source. Empty
    string when the source has no parseable start AND no end."""
    start = _fmt_month_year(entry.start)
    if entry.end == "present":
        end = "Present"
    elif isinstance(entry.end, tuple):
        end = _fmt_month_year(entry.end)
    else:
        end = ""
    if start and end:
        return f"{start} – {end}"
    if end and not start:
        return end          # "Completed 2021" → render only the end
    if start and not end:
        return start
    return ""


# Match a role line that includes a "* Role | dates *" italic header or
# similar variants. We rewrite ONLY the dates token; role text is kept.
_ROLE_LINE_RE = re.compile(
    r"^(\s*\*[^|*\n]+\|\s*)([^*\n]+?)(\s*\*\s*)$", re.MULTILINE
)
# Tokens that indicate a "no date" or fabricated/placeholder date in the
# tailored CV. Used to decide whether to overwrite from source.
_NO_DATE_TOKENS_RE = re.compile(
    r"\[\s*dates?\s*\][^|*\n]*|dates?\s+not\s+specified", re.IGNORECASE,
)


def _split_role_and_dates(inner: str) -> Tuple[str, str]:
    """Split the italic-line inner text on the FIRST ``|`` into (role, dates).
    The role-line regex already split on ``|``, so ``inner`` here is the
    dates segment alone — but be defensive."""
    if "|" in inner:
        role, dates = inner.split("|", 1)
        return role.strip(), dates.strip()
    return "", inner.strip()


def _find_h3_for_match(md: str, role_line_idx: int) -> Optional[str]:
    """Walk back from role_line_idx to find the most recent ``### Employer``
    heading. Returns the employer text or None."""
    lines = md[:role_line_idx].splitlines()
    for line in reversed(lines):
        s = line.strip()
        if s.startswith("### "):
            head = s[4:].strip()
            # Drop a "| Location" tail
            return head.split("|", 1)[0].strip()
    return None


def enforce_source_dates(md: str, cv_text: str) -> Tuple[str, List[str]]:
    """Replace fabricated/placeholder role date ranges with source-verbatim
    dates, or drop the date slot entirely if source has none.

    Returns (rewritten_md, notes). ``notes`` lists each rewrite for the
    quality-flag surface (e.g. "Dimeo Cleaning: dates omitted (source has
    none)" — the user asked to be notified).
    """
    facts = extract_source_facts(cv_text)
    if not facts.entries:
        return md, []

    notes: List[str] = []

    # Lower-cased source text for the "does this date string actually
    # appear in the source?" check used when we can't match the employer
    # to a parsed entry (the plain-text parser skips dateless blocks; an
    # entry can still exist in the raw text).
    src_lower = cv_text.lower()

    def _dates_appear_in_source(date_str: str) -> bool:
        """True iff every year mentioned in `date_str` appears in source.
        Strict: ANY year in the tailored date that's not in source means
        the date string is at least partially fabricated → strip."""
        years = re.findall(r"\b(19|20)\d{2}\b", date_str)
        return all(y in src_lower for y in [m for m in re.findall(r"\b(?:19|20)\d{2}\b", date_str)]) and bool(years)

    def _rewrite(m: re.Match) -> str:
        prefix, inner, suffix = m.group(1), m.group(2), m.group(3)
        current = inner.strip()
        # Universal placeholder strip — `[Dates] – [Dates]` and `Dates not
        # specified` are template-fallback leaks, never legitimate output.
        is_placeholder = bool(_NO_DATE_TOKENS_RE.search(current))

        employer = _find_h3_for_match(md, m.start())
        entry = facts.by_employer.get(_norm_employer(employer)) if employer else None

        source_dates = _fmt_source_date_range(entry) if entry else ""

        # When the employer matched a parsed source entry:
        if entry:
            if source_dates and current == source_dates:
                return m.group(0)
            if source_dates:
                notes.append(f"{employer}: dates set to '{source_dates}' (was '{current}')")
                return f"{prefix}{source_dates}{suffix}"
            # Matched entry but source has no dates → strip slot.
            notes.append(f"{employer}: dates omitted (no source dates)")
            head = prefix.rstrip()
            if head.endswith("|"):
                head = head[:-1].rstrip()
            return f"{head}{suffix}"

        # No parsed source entry for this employer. Decide whether the
        # current date string is fabricated by checking whether its years
        # appear ANYWHERE in the source CV text.
        if is_placeholder or not _dates_appear_in_source(current):
            label_for_note = employer or "(unknown employer)"
            reason = "placeholder" if is_placeholder else "fabricated (not in source CV)"
            notes.append(f"{label_for_note}: dates omitted — {reason}")
            head = prefix.rstrip()
            if head.endswith("|"):
                head = head[:-1].rstrip()
            return f"{head}{suffix}"

        return m.group(0)

    rewritten = _ROLE_LINE_RE.sub(_rewrite, md)
    return rewritten, notes


# ---------------------------------------------------------------------------
# Setting-descriptor guard
# ---------------------------------------------------------------------------

# Setting tokens that name a SPECIFIC work setting. If a tailored CV's role
# header introduces one of these but the source role doesn't evidence it,
# strip the descriptor — the role's identity must come from source.
_SETTING_DESCRIPTORS = {
    "retirement village": r"retirement\s+village",
    "retirement living": r"retirement\s+living",
    "acute hospital": r"acute\s+hospital",
    "hospital ward": r"hospital\s+ward",
    "surgical ward": r"surgical\s+ward",
    "operating theatre": r"operating\s+theatre",
    "ndis home": r"ndis\s+home",
}

# Source-role markers per setting — phrases in the source bullets/role
# line that legitimise the descriptor.
_SETTING_EVIDENCE = {
    "retirement village": (r"retirement\s+village", r"retirement\s+living", r"independent\s+living"),
    "retirement living": (r"retirement\s+village", r"retirement\s+living", r"independent\s+living"),
    "acute hospital": (r"acute", r"hospital"),
    "hospital ward": (r"hospital", r"ward\b"),
    "surgical ward": (r"surgical", r"operating\s+theatre"),
    "operating theatre": (r"theatre", r"surgical"),
    "ndis home": (r"ndis", r"home\s+support"),
}


def _role_block_for_employer(facts: SourceFacts, employer: str) -> str:
    entry = facts.by_employer.get(_norm_employer(employer))
    if not entry:
        return ""
    return " ".join([entry.role or "", *(entry.bullets or [])]).lower()


def enforce_source_settings(md: str, cv_text: str) -> Tuple[str, List[str]]:
    """Strip setting descriptors from role italic-headers when the source
    role does NOT evidence that setting. Preserves bullets — only the role
    header line is touched (that's where the categorical hallucination
    showed up: 'retirement village placement', 'acute hospital placement').
    """
    facts = extract_source_facts(cv_text)
    if not facts.entries:
        return md, []

    notes: List[str] = []
    lines = md.splitlines(keepends=True)
    cur_employer: Optional[str] = None

    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("### "):
            head = s[4:].strip()
            cur_employer = head.split("|", 1)[0].strip()
            continue
        if not cur_employer:
            continue
        # Role italic line "* Role | dates *"
        m = re.match(r"^(\s*\*)([^*]+)(\*\s*)$", line)
        if not m:
            continue
        inner = m.group(2)
        evidence_text = _role_block_for_employer(facts, cur_employer)
        if not evidence_text:
            continue
        modified = inner
        for desc, pat in _SETTING_DESCRIPTORS.items():
            if not re.search(pat, modified, re.IGNORECASE):
                continue
            ev_patterns = _SETTING_EVIDENCE.get(desc, ())
            has_evidence = any(re.search(ep, evidence_text) for ep in ev_patterns)
            if has_evidence:
                continue
            # Strip the descriptor + a trailing connective.
            modified = re.sub(
                rf"(?:\s+(?:in|at|for)\s+)?{pat}\s*(?:placement|setting|ward|environment)?",
                "",
                modified,
                flags=re.IGNORECASE,
            )
            notes.append(f"{cur_employer}: stripped '{desc}' from role header (no source evidence)")
        if modified != inner:
            modified = re.sub(r"\s{2,}", " ", modified).strip()
            lines[i] = f"{m.group(1)}{modified}{m.group(3)}"

    return "".join(lines), notes


# ---------------------------------------------------------------------------
# Skills-section label pinning
# ---------------------------------------------------------------------------

# Per family: the canonical headline label that the Skills section MUST
# use. The composer LLM tends to emit "Technical Skills" as a default;
# this guard rewrites to the family-correct label.
_FAMILY_HEADLINE_LABEL = {
    "nursing":  "Care Skills",
    "manual":   "Trade Skills",
    "cleaning": "Cleaning Skills",
    "general":  "Core Skills",
}

_SKILL_LABEL_LINE_RE = re.compile(
    r"^(\s*-?\s*\*\*)(Technical\s+Skills|Care\s+Skills|Clinical\s+Skills|Trade\s+Skills|Cleaning\s+Skills|Core\s+Skills)(:\*\*)",
    re.IGNORECASE | re.MULTILINE,
)


def pin_skills_section_labels(md: str, role_family_id: Optional[str]) -> Tuple[str, List[str]]:
    """Force the Skills section headline label to the family's convention.

    For nursing: any ``**Technical Skills:**`` / ``**Clinical Skills:**``
    is rewritten to ``**Care Skills:**``. Tech / master families keep
    ``Technical Skills``. Idempotent.
    """
    target = _FAMILY_HEADLINE_LABEL.get(role_family_id or "")
    if not target:
        return md, []  # tech/master → leave alone

    notes: List[str] = []

    def _sub(m: re.Match) -> str:
        prefix, current, suffix = m.group(1), m.group(2), m.group(3)
        if current.strip().lower() == target.lower():
            return m.group(0)
        notes.append(f"Skills label: '{current.strip()}' → '{target}'")
        return f"{prefix}{target}{suffix}"

    out = _SKILL_LABEL_LINE_RE.sub(_sub, md)
    return out, notes


# ---------------------------------------------------------------------------
# Pre-composition: role-relevance filter
# ---------------------------------------------------------------------------

# Mark a role as irrelevant when its primary_vertical is some occupation
# family the candidate isn't applying for. Keep at least this many roles.
_MIN_ROLES_KEPT = 2


def filter_irrelevant_roles_pre(
    cv_text: str, jd_vertical: Optional[str],
) -> Tuple[str, List[str]]:
    """Strip Experience entries whose primary vertical isn't the JD's.

    Returns (filtered_cv_text, dropped_employer_names). Floor: always
    keep the most recent ``_MIN_ROLES_KEPT`` entries even if irrelevant
    (a bare CV is worse than a slightly off-axis one). No-op when:
      - jd_vertical is None / empty
      - source has <= floor entries
      - no entries with a clear off-vertical primary
    """
    if not jd_vertical or not cv_text:
        return cv_text, []

    facts = extract_source_facts(cv_text)
    if len(facts.entries) <= _MIN_ROLES_KEPT:
        return cv_text, []

    # Decide which entries to drop. An entry is droppable when:
    #   - it has a primary_vertical (some signal),
    #   - that vertical is NOT the JD's vertical,
    #   - AND removing it leaves >= _MIN_ROLES_KEPT.
    droppable = [
        e for e in facts.entries
        if e.primary_vertical and e.primary_vertical != jd_vertical
    ]
    if not droppable:
        return cv_text, []

    # Keep the floor by NOT dropping more than (total - floor).
    max_drop = max(0, len(facts.entries) - _MIN_ROLES_KEPT)
    droppable = droppable[:max_drop]
    if not droppable:
        return cv_text, []

    drop_employers = {_norm_employer(e.employer) for e in droppable}
    dropped_names = [e.employer for e in droppable]

    # Rewrite cv_text: find the matching ### Employer block (or plain-text
    # block) and remove until the next ### / next all-caps section header.
    out = _strip_employer_blocks(cv_text, drop_employers)
    return out, dropped_names


def _strip_employer_blocks(cv_text: str, drop_employers: set) -> str:
    """Remove ``### Employer`` blocks whose name matches a droppable
    employer. Handles BOTH the markdown form (### Employer ... until
    next ###/##) and the plain-text form (Employer\nRole\nDates ... until
    next employer-block or next all-caps section)."""
    if not drop_employers:
        return cv_text

    lines = cv_text.splitlines()
    out: List[str] = []
    skip = False
    cur_norm: Optional[str] = None

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Markdown header form
        if stripped.startswith("### "):
            head = stripped[4:].split("|", 1)[0].strip()
            cur_norm = _norm_employer(head)
            skip = cur_norm in drop_employers
            if skip:
                i += 1
                continue
        elif stripped.startswith("## "):
            # leaving an Experience section — reset
            skip = False
            cur_norm = None
        # Plain-text employer header: look for "Employer name\n...\nDate range"
        # — too brittle to fully handle here; fall back to substring match.
        else:
            if not skip and cur_norm is None:
                low = _norm_employer(stripped)
                if low in drop_employers:
                    # Mark a plain-text block as droppable; skip until the
                    # next blank-line-after-bullets pattern or next header.
                    skip = True
                    cur_norm = low
                    i += 1
                    continue

        if skip:
            # End-of-block heuristic: empty line followed by another
            # candidate header or end of the Experience section.
            if not stripped:
                # Peek ahead — if next non-empty line is a header / new
                # employer, exit skip.
                j = i + 1
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j >= len(lines):
                    break
                nxt = lines[j].strip()
                if nxt.startswith("### ") or nxt.startswith("## ") or nxt.isupper():
                    skip = False
                    cur_norm = None
                    out.append(line)
            i += 1
            continue

        out.append(line)
        i += 1

    return "\n".join(out)


# ---------------------------------------------------------------------------
# Credential-claim guard — strip unverifiable compliance claims from bullets
# ---------------------------------------------------------------------------
#
# The composer occasionally tries to inject credential claims into experience
# bullets ("AIN with current compliance for pre-employment medical, police,
# and NDIS worker clearances in residential aged care settings"). These are
# real-world compliance items that the candidate may or may not hold — the
# composer has no way to know. If the candidate's profile doesn't list the
# credential, the claim is fabrication.
#
# This guard scans bullets for credential-claim phrases and verifies them
# against the user's stored credentials (contact_details["credentials"]).
# Anything claimed but not held is downgraded — the claim phrase is stripped
# from the bullet and the user is notified via the quality_flags badge.

# Credential families. (name, individual_regex, profile_key, holds_check_alone)
# `individual_regex` matches the credential in isolation. `profile_key` is the
# slot in contact_details.credentials we check; None means we have no profile
# evidence either way and must strip when the claim is found.
_CREDENTIAL_FAMILIES = [
    ("pre-employment medical",
     re.compile(r"(?ix)\bpre[-\s]?employment\s+medical\b"),
     None),
    ("ndis worker clearance",
     re.compile(r"(?ix)\bndis(?:\s+worker)?(?:\s+screening)?\b"),
     None),
    ("police clearance",
     re.compile(r"(?ix)\b(?:national\s+)?police\b"),
     "police_check"),
    ("working with children check",
     re.compile(r"(?ix)\b(?:working\s+with\s+children\s+check|wwcc|blue\s+card)\b"),
     "wwcc"),
]

# Match the COMPOUND compliance clause: " with [current] compliance for/with X,
# Y, and Z clearances/checks/etc." — the form composers use to list multiple
# credentials at once. Anchored on the trailing credential noun so we strip
# the whole list at once rather than fragments.
_COMPOUND_CLAIM_RE = re.compile(
    r"(?ix)"
    r"\s*,?\s+with\s+(?:current\s+)?(?:compliance\s+(?:for|with)\s+)?"
    r"[a-z][a-z0-9\-\s,]*?"
    r"\b(?:clearance|check|screening|endorsement|requirements?|compliance)s?\b\.?"
)


def _user_holds(credentials: Dict[str, Any], key: Optional[str]) -> bool:
    if key is None:
        return False  # no profile slot for this credential type
    if not isinstance(credentials, dict):
        return False
    val = credentials.get(key)
    if isinstance(val, str):
        return bool(val.strip())
    return bool(val)


def enforce_credential_claims(
    md: str,
    contact_details: Optional[Dict[str, Any]] = None,
) -> Tuple[str, List[str]]:
    """Strip credential-claim phrases from bullets when the user's profile
    does not evidence holding that credential.

    Two-stage strip:
      1. The compound-clause form ("AIN with current compliance for X, Y,
         and Z clearances.") — match the whole clause via _COMPOUND_CLAIM_RE
         and check each credential family inside it. If NONE of the
         credentials listed are held by the user, the entire clause is
         removed.
      2. Any leftover individual mentions ("Current police check.") are
         stripped per-family.

    Only bullet lines are touched (`- ` / `* ` / `• ` prefix) — never the
    summary, role italic-header, or skills line.

    Returns (rewritten_md, notes). Notes carry the human-readable list of
    stripped claims for the quality_flags badge.
    """
    creds = (contact_details or {}).get("credentials") or {}
    if not isinstance(creds, dict):
        creds = {}

    notes: List[str] = []
    lines = md.splitlines(keepends=True)

    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if not (stripped.startswith("- ") or stripped.startswith("* ") or stripped.startswith("• ")):
            continue

        updated = line

        # ── Stage 1: compound clause strip ───────────────────────────────
        def _strip_compound(match: "re.Match[str]") -> str:
            clause = match.group(0)
            mentioned: List[Tuple[str, Optional[str]]] = []
            for name, family_re, profile_key in _CREDENTIAL_FAMILIES:
                if family_re.search(clause):
                    mentioned.append((name, profile_key))
            if not mentioned:
                return clause  # no known credential family in this clause
            # Strip when AT LEAST ONE mentioned credential is not held —
            # the composer cannot claim "compliance with [unheld]" honestly
            # even if it bundled other credentials the user does hold.
            unheld = [n for n, k in mentioned if not _user_holds(creds, k)]
            if not unheld:
                return clause  # everything mentioned is held → honest claim
            notes.append(
                "Stripped unverifiable compliance claim: " + ", ".join(unheld)
            )
            return ""

        updated = _COMPOUND_CLAIM_RE.sub(_strip_compound, updated)

        # ── Stage 2: leftover individual mentions ────────────────────────
        for name, family_re, profile_key in _CREDENTIAL_FAMILIES:
            # Look for ", X check"  or  " X clearance"  or  "X check"  trailing forms.
            # The trailing noun is required so a stray "police" word (e.g. inside
            # the word "policy") is not stripped.
            trailing = re.compile(
                family_re.pattern + r"\s+(?:clearance|check|screening|endorsement|compliance|requirements?)s?\b\.?",
                family_re.flags,
            )
            if not trailing.search(updated):
                continue
            if _user_holds(creds, profile_key):
                continue
            new_line = trailing.sub("", updated)
            if new_line != updated:
                updated = new_line
                notes.append(f"Stripped unverifiable claim: '{name}'")

        if updated != line:
            # Cosmetic cleanup: collapse the kinds of debris stripping leaves
            # behind so the bullet still reads naturally.
            updated = re.sub(r"\s+,", ",", updated)
            updated = re.sub(r",\s*,", ",", updated)
            updated = re.sub(r"\s+\.", ".", updated)
            updated = re.sub(r"\s{2,}", " ", updated)
            # Strip dangling " with" / " with current" / " in" left behind
            # when a trailing clause is removed.
            updated = re.sub(
                r"\s+(?:with(?:\s+current)?|in)\s*\.?\s*$",
                ".",
                updated.rstrip("\n"),
            ) + ("\n" if line.endswith("\n") else "")
            lines[i] = updated

    return "".join(lines), notes


# ---------------------------------------------------------------------------
# Risk flag for the lift-vs-quality decision
# ---------------------------------------------------------------------------

def assess_honesty_risk(
    cv_text: str, jd_vertical: Optional[str], initial_ats: Optional[int],
) -> Dict[str, Any]:
    """Surface a flag the orchestrator can use to decide whether aggressive
    tailoring is worth doing. Doesn't skip — just flags. Returns a small
    dict logged on the run for quality-of-tailoring tracking.

    Risk is HIGH when:
      - candidate has <3 months of vertical-aligned tenure, AND
      - initial ATS is already below 50 (i.e. JD is genuinely off-axis,
        not a near-miss).
    """
    facts = extract_source_facts(cv_text)
    months = relevant_tenure_months(list(facts.entries), jd_vertical) if jd_vertical else 0
    risk_level = "low"
    if months <= 3 and (initial_ats is not None and initial_ats < 50):
        risk_level = "high"
    elif months < 12:
        risk_level = "medium"
    return {
        "vertical_months": months,
        "initial_ats": initial_ats,
        "risk_level": risk_level,
    }
