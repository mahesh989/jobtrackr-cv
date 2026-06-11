"""Skills-section hygiene — extracted from writers._impl.

Deterministic filtering + normalisation of the Skills section: non-skill phrase
detection/stripping (sector names, eligibility phrases, JD fillers), qualifier
tidying, smart-casing, British/Australian skill spelling, and cross-line dedup.
Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Exact (lowercased) entries that are sector/setting names, not skills.
_NON_SKILL_EXACT: set[str] = {
    "aged care", "aged care practices", "aged care practice",
    "aged care experience", "ageing support", "ageing",
    "residential aged care", "community care",
    # Bare care-sector / setting names — these say WHERE the work happens,
    # not WHAT the candidate can do. "Residential Care" was leaking into the
    # Other Skills line; the real competencies (Personal Care, Dementia Care)
    # live on the Skills lines, the setting belongs in the summary/experience.
    "residential care", "nursing home", "care facility",
    "aged care facility", "residential aged care facility",
    # Sonnet 4.6 generates these creative sector/sector-concatenation variants
    # that GPT-5.1 does not. All are sector descriptors, not skills.
    "aged care delivery", "retirement community care",
    "retirement living and community aged care",
    "home care or disability support work",
    "home care or disability support",
    "retirement living", "aged care services", "aged care work",
    "community aged care",
    # Opus 4.7/4.8 nursing run (2026-06-03 post Phase 1) leaked these.
    # "ageing care" is a casual variant of "aged care" — same sector descriptor.
    # "home care support" is the sector + "support" — names a category of work,
    # not a discrete competency the candidate has.
    "ageing care", "home care support",
    # Sector/setting descriptors — not skills.
    "aged care sector", "disability sector", "health sector",
    "community services sector",
    # Bare profession name / over-generic descriptors — not skills.
    "nursing", "nursing care", "nursing studies", "clinical care",
    "nursing practice",  # profession name, not a discrete skill
    "clinical placement experience",  # student status, not a skill
    "undergraduate nursing education",  # education status, not a skill
    "work under supervision of registered nurse",  # work arrangement descriptor
    "driver licensing requirements",  # credential requirement descriptor
    "evidence-based nursing care",  # framework descriptor, not a named skill
    "alignment with organisational core values",  # values statement, not a skill
    "ndis worker screening requirements", "working with children check requirements",
    "rn studies", "en studies",  # student enrollment status
    "allied health training", "assistant in nursing skills", "aged care worker skills",
    # JD-sourced setting/sector phrase variants not yet covered above.
    "aged care support",
    # Non-skill: describes basic equipment access, not a competency.
    "use of laptop or tablet", "use of computer and tablet", "use of tablet",
    # JD-phrasing: aspirations / values / availability — not a competency.
    "interest in leadership development pathways", "interest in leadership development",
    "interest in career development", "interest in professional development",
    "commitment to excellence", "commitment to quality care",
    "commitment to high-quality care", "commitment to best-practice care",
    "commitment to patient-centred care", "commitment to organisational values",
    "work ethic suitable for rotating rosters",
    "nursing studies in progress",
    "willingness to engage in ongoing learning and development",
    "understanding of residential care community operations",
    "understanding of residential aged care operations",
    "ethical conduct", "ethical behaviour",
    # Pre-employment requirements — not a skill.
    "pre-employment medical", "pre employment medical",
    "ability to complete pre-employment medical",
    "ability to complete police check",
    "ability to pass pre-employment medical", "ability to pass police check",
    "ability to use sector-leading care systems and technology",
    "ability to use sector-leading care systems",
    # OHS / compliance / institutional — not a competency.
    "occupational health and safety in healthcare",
    "work health and safety in healthcare",
    "work health and safety practices", "work health and safety compliance",
    "worker health and safety compliance",
    "quality improvement in healthcare", "quality and safety in healthcare",
    "accreditation requirements",
    "nsw health policies and procedures",
    "child safe standards", "child safety and protection practices",
    "child-safe practice principles", "child safe practice",
    "public health sector work environment",
    "awareness of public sector inclusion and diversity principles",
    "multi-purpose service model", "rural and regional healthcare context",
    "acute surgical care environment", "rehabilitation care environment",
    "ndis worker clearance requirements",
    "infection control and immunity requirements",
    "compliance with vaccination and screening protocols",
    "vaccine preventable diseases compliance",
    "infection prevention and vaccination awareness",
    # Student / qualification descriptions — not skills.
    "overseas nursing qualification", "overseas qualified nurse",
    "nursing assistance in residential aged care",
    "rn student", "en student", "nursing student clinical skills",
    "female gender as per client request",
    # Eligibility appearing in skills — not a competency.
    "permanent residency or citizenship in australia",
    "australian or new zealand work rights", "australian work rights requirements",
    # Workplace Health & Safety with/without the (WHS) suffix. WHS is a domain
    # category, not a discrete competency — the real skill is e.g. "Infection
    # Control", "Manual Handling".
    "workplace health and safety", "workplace health and safety (whs)",
    "workplace health and safety in healthcare",  # OHS category, not a discrete skill
    "work health and safety", "work health and safety policies",
    "work health and safety procedures", "whs", "whs policies",
    "health and safety policies", "health and safety procedures",
    "health and safety guidelines",  # generic compliance phrase, not a skill
    # Task/duty descriptor — describes what a carer does, not a competency.
    "transport to appointments",
}
# Entries beginning with these are JD-phrasing fillers, not skills.
_NON_SKILL_PREFIXES: tuple[str, ...] = (
    "experience in", "experienced in", "experience as", "experience working",
    "knowledge of", "understanding of",
    "ability to", "familiarity with", "demonstrated ", "proven ",
    "willingness to", "commitment to", "passion for",
    "use of ",  # "use of laptop/tablet/computer" — describes access, not competency
    "availability for ",  # "availability for day/night/morning shifts X-Y" — requirement, not skill
    "nursing student",  # "nursing student with aged care placement" — candidate attribute, not skill
    "interest in ",  # "interest in leadership / career / professional development" — aspiration, not skill
    "ability to complete ",  # "ability to complete police check / pre-employment medical" — requirement
    "ability to obtain ",  # "ability to obtain NDIS screening" — requirement
)
# Qualification / eligibility / compliance signals — never genuine skills.
# Also catches JD-phrasing "experience in/with/of X" anywhere in the term
# (the prefix list only catches it at the START of the term, so phrases like
# "professional experience in aged care" or "personal experience in disability"
# slip past — they describe a requirement, not a competency the candidate has).
_NON_SKILL_PATTERN = re.compile(
    r"\b(certificate|cert|diploma|degree|bachelor|qualification|or equivalent"
    r"|work rights|right to work|police check|working with children|wwcc"
    r"|compliance|eligibility|eligible to work|visa|clearance|licence|license"
    # "experience in/with/of/working/across …" anywhere — JD-phrasing filler.
    # Matches "experience in aged care", "personal experience in disability",
    # "hands-on experience with dementia", "broad experience working in NDIS",
    # etc. These are role-requirement phrases, never a single skill.
    r"|experience\s+(in|with|of|as|working|across|supporting)\b"
    # Bare "X experience" where X is a qualifier the JD uses to describe a
    # candidate background ("personal experience", "professional experience",
    # "lived experience", "prior experience"). On their own they are not a
    # skill — they are a category of background.
    r"|(?:professional|personal|lived|prior|previous|extensive|hands[- ]on)\s+experience"
    # "Working / Supporting / Caring/Support/Care for [population]" — JD-phrasing for WHO
    # the work is with, not a discrete skill. "Working with Seniors",
    # "Supporting Older People", "Care for Older People", "Caring for Children".
    # The audience belongs in the summary; the actual skills (Personal Care, Dementia Care,
    # Behavioural Management) live in the appropriate Skills line. "with/for/of"
    # is optional.
    r"|(?:working|supporting|caring|support|care|engaging)(?:\s+(?:with|for|of))?\s+"
    r"(?:the\s+)?"
    r"(?:(?:disadvantaged|vulnerable|homeless|marginali[sz]ed|diverse|frail|aged|older|elderly)(?:\s+(?:and|or)\s+(?:disadvantaged|vulnerable|homeless|marginali[sz]ed|diverse|frail|aged|older|elderly))?\s+)?"
    r"(?:seniors|elderly|aged|older\s+(?:people|adults|persons|australians)"
    r"|children|adolescents|adults|youth|patients|residents|clients"
    r"|families|consumers|participants|people|adults"
    r"|the\s+aged|the\s+elderly)"
    # Bare "[sector] [audience]" — same JD-phrasing class without a verb
    # prefix. "Aged Care Clients", "Nursing Home Residents", "NDIS
    # Participants", "Disability Clients", "Home Care Clients" — these are
    # WHO the work serves, not a skill. The candidate's actual competencies
    # (Personal Care, Dementia Care, Medication Assistance) live in Care
    # Skills; the audience never belongs on a Skills line.
    r"|(?:aged\s+care|nursing\s+home|residential\s+(?:aged\s+care|care)"
    r"|ndis|disability|home\s+care|community\s+care|in[- ]home|"
    r"hospital|clinical|palliative)\s+"
    r"(?:clients|residents|participants|patients|consumers|persons"
    r"|people)"
    # Work-context / environment descriptors — these are WHERE you work, not WHAT
    # you can do. No genuine discrete skill ends with "environment", "setting",
    # "facility", or "ward". Catches:
    #   "Acute Healthcare Environment", "Residential Aged Care Setting",
    #   "Clinical Environment", "Hospital Setting", "Community Setting",
    #   "Aged Care Environment", "Rehabilitation Ward", "Acute Care Facility".
    r"|(?:environment|setting[s]?|facility|facilities|ward[s]?)\s*$"
    # "X Principles" — the principles are not the skill; the underlying competency
    # is. "Person-Centred Care Principles" → base skill is "Person-Centred Care".
    # "Infection Control Principles" → skill is "Infection Control". No meaningful
    # skills line entry ends with the word "principles".
    r"|\bprinciples\s*$"
    # Professional-framework / boundary concepts — NOT discrete skills.
    # "Nursing Scope of Practice", "Scope of Practice", "Duty of Care",
    # "Code of Conduct", "Standards of Practice", "Model of Care". The
    # underlying skill (e.g. "Clinical Documentation", "Wound Care") is what
    # belongs on a Skills line — never the governing framework itself.
    r"|\bscope\s+of\b"
    r"|\bduty\s+of\s+care\b"
    r"|\bcode\s+of\s+conduct\b"
    r"|(?:of\s+(?:practice|conduct|care))\s*$"
    # Care-values / philosophy statements — NOT discrete skills. "Resident
    # Dignity and Independence", "Dignity of Risk", "Client Wellbeing",
    # "Quality of Life", "Respect and Dignity". The concrete competency
    # (Person-Centred Care, Personal Care) is the skill; the value it upholds
    # is not. "dignity"/"wellbeing" never form part of a genuine skill label;
    # "quality of life" is a care outcome, not a competency.
    r"|\bdignity\b"
    r"|\bwell[\s-]?being\b"
    r"|\bquality\s+of\s+life\b"
    # Driver licence variants — the licence itself belongs in Registration &
    # Licences (already populated by stamp_credentials when the user has it).
    # Listing "Driving NSW C Class Motor Vehicle" / "Driving Motor Vehicle" /
    # "C Class Driver Licence" on the Skills line is duplicate JD-phrasing for
    # the same thing. The candidate's real driving skill is the licence held.
    r"|\bdriving\s+(?:[a-z]+\s+){0,3}(?:motor\s+vehicle|class\s+[a-z]+(?:\s+vehicle)?|licen[cs]e)\b"
    r"|(?:c|p|hr|mr|hc)\s+class\s+(?:motor\s+vehicle|driver|licen[cs]e|vehicle)\b"
    # Sector + activity-noun ending — sector descriptors disguised as skills.
    # "Aged Care Delivery", "Home Care Provision", "Retirement Living Services",
    # "Community Care Work", "Residential Aged Care Services". The bare sector
    # exact-blocklist catches the simple cases; this catches sector + activity.
    r"|(?:aged\s+care|home\s+care|residential\s+(?:aged\s+care|care)"
    r"|community\s+care|retirement\s+(?:living|community)|disability\s+support)"
    r"\s+(?:delivery|provision|services?|work|operations|coverage)\b"
    # Multi-sector concatenations joined with And/Or — Sonnet stitches two
    # sector names into one Skills entry. "Retirement Living and Community
    # Aged Care", "Home Care or Disability Support Work", "Aged Care and
    # Disability Services". The candidate's REAL skills (Personal Care,
    # Dementia Care) belong on the Skills line; these are sector pairings.
    r"|(?:aged|home|residential|community|disability|retirement|nursing)"
    r"(?:\s+\w+)*?\s+(?:and|or)\s+"
    r"(?:aged|home|residential|community|disability|retirement|nursing)\s+\w+"
    # Credentials/certifications/vaccinations — these belong in Registration &
    # Licences (which already lists them). Stripping prevents duplication.
    # "Covid and Flu Vaccination", "First Aid and CPR Certification",
    # "Vaccination Status", "Police Check Certification".
    r"|\bvaccinations?\b"
    r"|\bcertifications?\s*$"
    # "Promotion of X" / "Maintenance of X" — care values stated as actions,
    # not concrete competencies. "Promotion of Independence for Older People",
    # "Maintenance of Dignity", "Promotion of Wellbeing".
    r"|\b(?:promotion|maintenance|enhancement|preservation)\s+of\b"
    # "X Usage/Use For Y" / "X For Rostering" — JD verb phrases describing
    # what tools are used for, not the tool skill itself. "Mobile App Usage
    # for Rostering" — the candidate's actual skill is rostering, or the app
    # name (BESTMed, MedMobile). Bare "for [activity]" tail patterns.
    r"|\b(?:usage|use)\s+for\b"
    r"|\bapp\s+(?:usage|use)\b"
    # Availability, shifts, schedules, hours, and days of the week
    r"|availability|available\b"
    r"|roster(?:ed)?\b(?![- ](?:management|planning|coordination|system|software|prep|creation|admin|lead|officer|design|building|maintenance|run))"
    r"|(?:\b\d{1,2}(?:am|pm)?\s*(?:-|to)\s*\d{1,2}(?:am|pm)\b)"
    r"|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?\b"
    r"|\b(?:day|night|evening|afternoon|morning|weekend|rotating|casual|part[- ]time|full[- ]time)\s+shift[s]?\b"
    r")\b",
    re.IGNORECASE,
)


def _is_non_skill_phrase(term: str) -> bool:
    """True if `term` is a sector name / qualification / eligibility phrase /
    filler that should not appear as a Skills entry."""
    t = term.strip().lower()
    if not t:
        return True
    if t in _NON_SKILL_EXACT:
        return True
    if any(t.startswith(p) for p in _NON_SKILL_PREFIXES):
        return True
    return bool(_NON_SKILL_PATTERN.search(t))


_SKILLS_LINE_RE = re.compile(r"^(\s*(?:[-*•]\s+)?\*\*[^*]+:\*\*\s*)(.*)$")

# Leading evaluative qualifiers the AI sometimes prepends to a soft skill
# ("Strong Communication", "Excellent Time Management"). The qualifier is the
# AI grading itself — it is not part of the skill. Strip it so entries read as
# bare competencies consistent with their neighbours.
_LEADING_SKILL_QUALIFIER_RE = re.compile(
    r"^(?:strong|excellent|good|great|effective|proven|exceptional|outstanding"
    r"|solid|superior|advanced|highly\s+developed|well[\s-]developed)\s+",
    re.IGNORECASE,
)
# A redundant trailing "Skills" word inside the Skills section is only
# meaningful to strip when the base is itself a recognised competency word
# ("Communication Skills" → "Communication", "Interpersonal Skills" →
# "Interpersonal"). For entries whose base is a generic noun that NEEDS the
# "Skills" word to read sensibly ("Computer Skills", "Basic Computer Skills",
# "People Skills"), stripping produces broken-looking output ("Basic Computer")
# — keep the suffix.
_STRIPPABLE_SKILL_BASE_RE = re.compile(
    r"^(?:"
    r"communication|interpersonal|analytical|organisational|organizational"
    r"|leadership|management|negotiation|presentation|teamwork|collaboration"
    r"|problem[\s-]solving|critical[\s-]thinking|time[\s-]management"
    r"|stakeholder|writing|verbal|written"
    r")$",
    re.IGNORECASE,
)
_TRAILING_SKILLS_WORD_RE = re.compile(r"^(.*?)\s+skills$", re.IGNORECASE)


def _tidy_skill_qualifiers(entry: str) -> str:
    """Strip a leading evaluative qualifier and a redundant trailing "Skills"
    word from a single Skills-line entry. Never returns empty — if stripping
    would empty the entry, the original token is preserved.

    The trailing-"Skills" strip is conditional: only when the base IS a
    recognised competency word (Communication/Interpersonal/Analytical/...).
    Generic bases that need "Skills" to read sensibly (Computer / People /
    Technology) keep the suffix."""
    t = entry.strip()
    stripped_lead = _LEADING_SKILL_QUALIFIER_RE.sub("", t).strip()
    if stripped_lead:
        t = stripped_lead
    m = _TRAILING_SKILLS_WORD_RE.match(t)
    if m:
        base = m.group(1).strip()
        # Strip "skills" suffix only when the base alone is itself a real
        # competency name. "Basic Computer Skills" → base="Basic Computer" →
        # not in allowlist → keep "Skills". "Communication Skills" →
        # base="Communication" → in allowlist → strip → "Communication".
        if base and _STRIPPABLE_SKILL_BASE_RE.match(base):
            t = base
    return t


def _strip_non_skill_phrases(markdown: str) -> str:
    """Remove non-skill entries from each category line in the canonical
    ``## Skills`` section. Drops a category line entirely if it ends up empty."""
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

    out: list[str] = []
    removed = 0
    for i, line in enumerate(lines):
        if not (skills_start < i < skills_end):
            out.append(line)
            continue
        m = _SKILLS_LINE_RE.match(line)
        if not m:
            out.append(line)
            continue
        prefix, body = m.group(1), m.group(2)
        parts = [p.strip() for p in body.split(",")]
        non_empty = [p for p in parts if p]
        kept: list[str] = []
        seen: set[str] = set()
        for p in non_empty:
            if _is_non_skill_phrase(p):
                continue
            tidied = _tidy_skill_qualifiers(p)
            key = tidied.lower()
            if key in seen:
                continue
            seen.add(key)
            kept.append(tidied)
        removed += len(non_empty) - len(kept)
        if kept:
            out.append(prefix + ", ".join(kept))
        # else: drop the now-empty category line entirely.
    if removed:
        logger.info("w8 skills hygiene: removed %d non-skill phrase(s)", removed)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Skills-section case normalisation. The AI writer and the surfacing helper
# emit entries in inconsistent case ("Communication" alongside "time
# management" and "Person-centred care"). This pass forces consistent Title
# Case across every entry in every ## Skills category line while preserving:
#   - all-uppercase acronyms (SQL, AWS, NDIS, AHPRA)
#   - internal-uppercase product names (BESTMed, MedMobile, eHealth, iCare)
#   - digit-containing tokens (GA4, AS400, YOLOv8)
# Hyphenated words are title-cased per part ("person-centred" → "Person-Centred").
# Idempotent.
# ---------------------------------------------------------------------------

# Known acronyms — upper-cased regardless of input case. Conservative list
# focused on the role families we tailor for (healthcare, tech, manual).
# Distinguishes real acronyms from common all-caps English ("TEAMWORK", "CARE"),
# which should be title-cased instead.
_KNOWN_ACRONYMS = frozenset({
    # Healthcare / nursing
    "AHPRA", "NDIS", "NDIA", "ACFI", "CPR", "BLS", "ACLS", "ICU", "ED",
    "OHS", "WHS", "ADL", "ADLS", "SBAR", "ISBAR", "PCA", "ANTT", "PEG",
    "NGT", "MMSE", "RN", "EN", "AIN", "GP", "IV", "IM", "PRN", "MET",
    "NEWS", "ECG", "EKG", "BP",
    # Tech / IT
    "SQL", "AWS", "GCP", "AI", "ML", "NLP", "API", "REST", "JSON", "XML",
    "YAML", "CSS", "HTML", "JS", "TS", "IDE", "CI", "CD", "QA", "BI", "CV",
    "ETL", "ELT", "EDA", "EDW", "OLAP", "OLTP", "IOT", "AR", "VR", "XR",
    "RBAC", "ABAC", "JVM", "JDK",
    # Manual / trades / general
    "HR", "MR", "MC", "LR", "HC", "RSA", "RCG", "EWP", "VOC", "ABN", "ACN",
    "GST", "BAS",
    # Australian States/Territories
    "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT",
})


def _smartcase_atom(atom: str) -> str:
    """Case-normalise a single alphanumeric atom (one of the parts produced by
    splitting an entry on whitespace AND hyphens)."""
    if not atom:
        return atom
    # Digit-containing tokens — preserve as-is (GA4, AS400, YOLOv8).
    if any(ch.isdigit() for ch in atom):
        return atom
    # Known acronym — upper-case regardless of input case.
    if atom.isalpha() and atom.upper() in _KNOWN_ACRONYMS:
        return atom.upper()
    # Mixed-case product names — uppercase letter after position 0 AND not
    # entirely upper (BESTMed, MedMobile, eHealth, iCare). All-caps inputs
    # (TEAMWORK, CARE) fall through to title-case.
    if any(ch.isupper() for ch in atom[1:]) and not atom.isupper():
        return atom
    # Default: Title case ("communication" → "Communication", "TEAMWORK" →
    # "Teamwork", "ndis" → "Ndis" unless it's on the acronym list above).
    return atom[:1].upper() + atom[1:].lower()


def _smartcase_skill(entry: str) -> str:
    """Title-case a Skills-line entry consistently while preserving acronyms,
    mixed-case product names, and digit tokens. Hyphenated words are
    title-cased per part: ``person-centred care`` → ``Person-Centred Care``."""
    out_tokens: list[str] = []
    for tok in entry.strip().split():
        if not tok:
            continue
        # Split on hyphens, smart-case each atom, rejoin so each hyphenated
        # part is title-cased independently.
        out_tokens.append("-".join(_smartcase_atom(p) for p in tok.split("-")))
    return " ".join(out_tokens)


def _normalise_skills_case(markdown: str) -> str:
    """Apply consistent Title Case to every entry in each ## Skills category
    line. Preserves acronyms, digit tokens, and mixed-case product names.
    Idempotent — running it twice yields the same output."""
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

    changed = 0
    for i in range(skills_start + 1, skills_end):
        m = _SKILLS_LINE_RE.match(lines[i])
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        parts = [p.strip() for p in body.split(",") if p.strip()]
        new_parts = [_smartcase_skill(p) for p in parts]
        new_line = prefix + ", ".join(new_parts)
        if new_line != lines[i]:
            lines[i] = new_line
            changed += 1
    if changed:
        logger.info("w8: normalised case on %d Skills category line(s)", changed)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# British/American spelling canonicalisation + cross-line dedup. The writer
# sometimes emits the British form on one Skills line ("Person-Centred Care"
# on Care Skills) and the American form on another ("Person-Centered Care" on
# Other Skills). They are the same skill — dedup needs them to compare equal.
#
# Australian CVs use British spelling, so we canonicalise to British. Limited
# to a curated set of skill-phrase replacements (not generic letter swaps) to
# avoid touching brand names like "Optimizely" or "Customer Behavior Analytics".
# ---------------------------------------------------------------------------

_BR_AM_SKILL_SUBS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bperson[- ]centered\b", re.IGNORECASE),         "Person-Centred"),
    (re.compile(r"\bperson[- ]centred\b", re.IGNORECASE),          "Person-Centred"),
    (re.compile(r"\bpatient[- ]centered\b", re.IGNORECASE),         "Person-Centred"),
    (re.compile(r"\bpatient[- ]centred\b", re.IGNORECASE),          "Person-Centred"),
    (re.compile(
        r"\badvocacy\s+for\s+(?:patients|residents|clients|people)(?:\s+(?:and|or)\s+(?:patients|residents|clients|people))?\b",
        re.IGNORECASE
    ), "Patient Advocacy"),
    (re.compile(r"\bbehavioral\b", re.IGNORECASE),                 "Behavioural"),
    (re.compile(r"\bspecialized\b", re.IGNORECASE),                "Specialised"),
    (re.compile(r"\borganized\b", re.IGNORECASE),                  "Organised"),
    (re.compile(r"\bindividualized\b", re.IGNORECASE),             "Individualised"),
    (re.compile(r"\bpersonalized\b", re.IGNORECASE),               "Personalised"),
    (re.compile(r"\boptimized\b", re.IGNORECASE),                  "Optimised"),
    (re.compile(r"\banalyze\b", re.IGNORECASE),                    "Analyse"),
    (re.compile(r"\bcolor\b", re.IGNORECASE),                      "Colour"),
    (re.compile(r"\brecognized\b", re.IGNORECASE),                 "Recognised"),
    (re.compile(r"\brecognise\b", re.IGNORECASE),                  "Recognise"),
    (re.compile(r"\brecognize\b", re.IGNORECASE),                  "Recognise"),
    (re.compile(r"\brecognised\b", re.IGNORECASE),                 "Recognised"),
]


def _canonicalise_skill_spelling(skill: str) -> str:
    """Replace American spellings with British/Australian equivalents.
    Applies only to the curated skill-phrase patterns above; brand names
    that happen to contain American spellings are left alone."""
    out = skill
    for pat, repl in _BR_AM_SKILL_SUBS:
        out = pat.sub(repl, out)
    return out


def _dedupe_skills_across_lines(markdown: str) -> str:
    """Remove duplicate entries that appear on multiple ## Skills category
    lines after spelling canonicalisation. Within each line, also dedupe
    case-insensitively. Earlier lines win — a skill already in Care Skills
    is dropped from Soft / Other; a skill in Soft is dropped from Other.

    Runs AFTER _normalise_skills_case so we work on canonical-cased entries,
    and applies the British-spelling map before comparing so 'Person-Centred
    Care' (Care Skills) and 'Person-Centered Care' (Other) deduplicate."""
    lines = markdown.split("\n")
    skills_start = next((i for i, l in enumerate(lines) if l.strip() == "## Skills"), -1)
    if skills_start < 0:
        return markdown
    skills_end = next(
        (j for j in range(skills_start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    seen: set[str] = set()
    dropped = 0
    for i in range(skills_start + 1, skills_end):
        m = _SKILLS_LINE_RE.match(lines[i])
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        kept: list[str] = []
        for raw in body.split(","):
            p = raw.strip()
            if not p:
                continue
            canonical = _canonicalise_skill_spelling(p)
            key = canonical.lower()
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
            kept.append(canonical)
        if kept:
            lines[i] = prefix + ", ".join(kept)
        else:
            lines[i] = ""
    # Filter out empty lines inside ## Skills
    non_empty_lines = []
    for i, line in enumerate(lines):
        if skills_start < i < skills_end and line == "":
            continue
        non_empty_lines.append(line)
    if dropped:
        logger.info("w8: deduped %d cross-line Skills entr(ies)", dropped)
    return "\n".join(non_empty_lines)
