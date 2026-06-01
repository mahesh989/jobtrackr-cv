"""
Writer variant registry (Track W).

A writer takes the raw CV + JD (and BYOK client) and returns a WriterResult:
the tailored markdown plus the intermediate artifacts the runner needs to
score and report (jd_analysis, matching, initial ats, feasibility).

Variants:
  W1  current production  — full pipeline + production tailoring prompt.
  W2  generalised         — full pipeline + role-agnostic prompt (no baked
                            examples, no AI-suppression machinery).
  W4  chat single-call    — ONE rich AI call with raw CV+JD + lean prompt.
                            jd_analysis/matching/feasibility still run upstream
                            so the metrics/scoring are apples-to-apples with
                            W1/W2; the tailoring call itself never sees them.

W3 (composition) plugs in here later.

W1 reuses production code verbatim (no copies). W2 and W4 reuse the production
deterministic post-processors (_enforce_structure, _inject_missing_skills,
stamp_contact_line) so structural caps and the safety-net skills injection
behave identically across variants — the only thing that changes between
writers is the AI prompt that produced the markdown.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    TAILORED_CV_SYSTEM,
    TAILORED_CV_USER_TEMPLATE,
)
from app.services.ai.prompts.variants.tailored_cv_general import (
    TAILORED_CV_GENERAL_SYSTEM,
)
from app.services.ai.prompts.variants.tailored_cv_w6 import (
    TAILORED_CV_W6_SYSTEM,
)
from app.services.ai.prompts.variants.tailored_cv_chat import (
    TAILORED_CV_CHAT_SYSTEM,
    TAILORED_CV_CHAT_USER_TEMPLATE,
)
from app.services.ai.prompts.variants.composition import (
    build_composition_system,
    COMPOSITION_USER_TEMPLATE,
    build_surfacing_system,
    COMPOSITION_SURFACING_USER_TEMPLATE,
)
from app.services.eval.enforce import enforce_skills_section
from app.services.eval.enforce_w3 import apply_w3_gates, restrict_domain_to_direct, enforce_summary_identity
from app.services.eval.enforce_w8 import to_canonical, restore_and_order, ensure_bachelor
from app.services.eval.verify import verify_claims
from app.services.eval.critique import critique_and_repair
from app.services.eval.knockout import detect_knockouts
from app.services.eval.role_families import (
    resolve_role_family,
    resolve_seniority,
    apply_equivalences,
)
from app.services.cv.contact_line import stamp_contact_line, stamp_credentials
from app.services.pipeline.steps.jd_analysis import run_jd_analysis
from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
from app.services.pipeline.steps.ats_scoring import run_ats_scoring
from app.services.pipeline.steps.input_recommendations import run_input_recommendations
from app.services.pipeline.steps.keyword_feasibility import run_keyword_feasibility
from app.services.pipeline.steps.ai_recommendations import run_ai_recommendations
from app.services.pipeline.steps.tailored_cv import (
    run_tailored_cv,
    _enforce_structure,        # production-stable post-processor — reused for fairness
    _inject_missing_skills,    # production-stable safety net
    _upload_to_storage,        # production-stable Supabase upload (same path contract)
    _SKILLS_CATEGORY_LABEL,    # canonical "**Technical/Soft/Other Skills:**" labels
    _kw_in_skills,             # word-boundary "already listed?" check
    _format_skill_label,       # title-case while preserving acronyms
)

logger = logging.getLogger(__name__)

_EVAL_USER_ID = uuid.UUID(int=0)  # sentinel: W1's storage uploads live under 0000…/


@dataclass
class WriterResult:
    tailored_md: str
    jd_analysis: Dict[str, Any]
    matching: Dict[str, Any]
    initial_ats_internal: Dict[str, Any]
    feasibility: Dict[str, Any]
    extras: Dict[str, Any] = field(default_factory=dict)


# Writers are called as: writer(client, cv_text, jd_text, contact_details, vertical=...)
# The `vertical` hint (from the beta screen) is used only by W3's router; the
# other writers accept and ignore it.
WriterFn = Callable[..., Awaitable[WriterResult]]


# ---------------------------------------------------------------------------
# Shared upstream — every writer needs the same metric scaffolding around it
# so initial/final ATS and the rescore/grounding reports are apples-to-apples.
# ---------------------------------------------------------------------------


async def _run_upstream(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    jd_analysis = await run_jd_analysis(client, jd_text)
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)
    ats = run_ats_scoring(cv_text, jd_analysis, matching)
    input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)
    feasibility = await run_keyword_feasibility(
        client, cv_text, jd_analysis, matching, input_recs, contact_details=contact_details,
    )
    return {
        "jd_analysis": jd_analysis,
        "matching":    matching,
        "ats":         ats,
        "input_recs":  input_recs,
        "feasibility": feasibility,
    }


def _inject_keyword_set(feasibility: Optional[Dict[str, Any]]) -> set[str]:
    """Lowercased inject_directly keywords — the feasibility/equivalence terms the
    plan authorised to surface. Used to exempt honest child→parent inferences
    (e.g. SQL→PostgreSQL) from the deterministic skills entity-grounding strip."""
    plan = (feasibility or {}).get("feasibility_plan") or {}
    out: set[str] = set()
    for e in (plan.get("inject_directly") or []):
        if isinstance(e, dict):
            kw = str(e.get("keyword") or "").strip().lower()
            if kw:
                out.add(kw)
    return out


def _postprocess(
    markdown: str,
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]],
) -> str:
    """Apply the production deterministic post-processors. Same for every variant."""
    enforced = _enforce_structure(markdown.strip())
    with_skills = _inject_missing_skills(enforced, feasibility)
    return stamp_contact_line(with_skills, contact_details)


# ---------------------------------------------------------------------------
# W1 — current production (calls into the existing pipeline step verbatim)
# ---------------------------------------------------------------------------


async def _writer_w1_current(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,  # ignored by W1
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    recs_md = await run_ai_recommendations(
        client, cv_text, up["jd_analysis"], up["matching"], up["input_recs"], up["feasibility"],
    )
    # run_tailored_cv uploads to Supabase storage; that side effect is fine
    # for eval (artifacts go under the sentinel _EVAL_USER_ID).
    tailored_md, _storage_path = await run_tailored_cv(
        client,
        _EVAL_USER_ID,
        uuid.uuid4(),
        cv_text,
        up["jd_analysis"],
        recs_md,
        up["feasibility"],
        contact_details=contact_details,
    )
    return WriterResult(
        tailored_md=tailored_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={"input_recommendations": up["input_recs"], "ai_recommendations_md": recs_md},
    )


# ---------------------------------------------------------------------------
# W2 — generalised: same pipeline, lean role-agnostic prompt
# ---------------------------------------------------------------------------


async def _writer_w2_general(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,  # ignored by W2
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    recs_md = await run_ai_recommendations(
        client, cv_text, up["jd_analysis"], up["matching"], up["input_recs"], up["feasibility"],
    )
    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}
    user_prompt = TAILORED_CV_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(up["jd_analysis"], indent=2),
        ai_recommendations_md=recs_md,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=TAILORED_CV_GENERAL_SYSTEM,
        user=user_prompt,
        max_tokens=6144,
        temperature=0.3,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W2 tailored CV: response too short")
    final_md = _postprocess(raw, up["feasibility"], contact_details)
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={"input_recommendations": up["input_recs"], "ai_recommendations_md": recs_md},
    )


# ---------------------------------------------------------------------------
# W4 — chat single-call: ONE tailoring call with raw CV+JD only
# Upstream still runs so the metrics stay apples-to-apples with W1/W2.
# ---------------------------------------------------------------------------


async def _writer_w4_chat(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,  # ignored by W4
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    user_prompt = TAILORED_CV_CHAT_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_text=jd_text,
    )
    raw = await client.complete(
        system=TAILORED_CV_CHAT_SYSTEM,
        user=user_prompt,
        max_tokens=6144,
        # A touch warmer than W1/W2 — short principle prompts benefit from a
        # little more latitude. Still constrained enough to be stable.
        temperature=0.4,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W4 tailored CV: response too short")
    final_md = _postprocess(raw, up["feasibility"], contact_details)
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={"input_recommendations": up["input_recs"], "single_call": True},
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# W3 — composition: role-family-aware single rich call + deterministic enforcement
# Combines W4's lean single-call writer (best prose) with a role-family pack
# (restores the honesty guardrails W2 lost) and deterministic skills hygiene.
# ---------------------------------------------------------------------------


async def _writer_w3_composition(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    up["feasibility"] = restrict_domain_to_direct(up["feasibility"])  # domain expertise can't be inferred

    role_family = resolve_role_family(vertical, up["jd_analysis"])
    seniority = resolve_seniority(up["jd_analysis"])
    system_prompt = build_composition_system(role_family, seniority)

    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}
    user_prompt = COMPOSITION_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_text=jd_text,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=system_prompt,
        user=user_prompt,
        max_tokens=6144,
        temperature=0.35,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W3 tailored CV: response too short")

    # Production post-processors, then deterministic W3 gates (the rules that
    # kept failing as prompt prose), then skills hygiene.
    final_md = _postprocess(raw, up["feasibility"], contact_details)
    final_md = apply_w3_gates(
        final_md,
        jd_text=jd_text,
        jd_analysis=up["jd_analysis"],
        # Suppression no-ops when the JD has AI signal; harmless for non-tech.
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
    )
    # drop_ungrounded only for the strictest policy (manual = "none") to avoid
    # pruning legitimate methodology terms in tech/master.
    final_md = enforce_skills_section(
        final_md,
        original_cv_text=cv_text,
        drop_ungrounded=(role_family.injection_policy == "none"),
    )
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={
            "input_recommendations": up["input_recs"],
            "role_family": role_family.id,
            "seniority": seniority,
        },
    )


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
            if lines[i].lstrip().startswith(label):
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


# ---------------------------------------------------------------------------
# Skills hygiene — drop "non-skill" entries that the matcher surfaces or the
# base classifier mislabels. These are JD keywords that match for scoring but
# read as junk in a Skills list: qualifications (belong in Education; a higher
# cert subsumes a lower one — Cert IV ⊇ Cert III), eligibility/compliance
# phrases (work rights, police checks), bare sector names (Aged Care), and
# JD-phrasing fillers ("Experience in…", "Knowledge of…"). Stripping them from
# Skills does not lose the keyword for ATS — the scorer still matches it from
# Education/Summary/Experience, or re-derives cert equivalences via promotion.
# ---------------------------------------------------------------------------

# Exact (lowercased) entries that are sector/setting names, not skills.
_NON_SKILL_EXACT: set[str] = {
    "aged care", "aged care practices", "aged care practice",
    "aged care experience", "ageing support", "ageing",
    "residential aged care", "home care", "community care",
}
# Entries beginning with these are JD-phrasing fillers, not skills.
_NON_SKILL_PREFIXES: tuple[str, ...] = (
    "experience in", "experienced in", "knowledge of", "understanding of",
    "ability to", "familiarity with", "demonstrated ", "proven ",
    "willingness to", "commitment to", "passion for",
)
# Qualification / eligibility / compliance signals — never genuine skills.
# Also catches JD-phrasing "experience in/with/of X" anywhere in the term
# (the prefix list only catches it at the START of the term, so phrases like
# "professional experience in aged care" or "personal experience in disability"
# slip past — they describe a requirement, not a competency the candidate has).
_NON_SKILL_PATTERN = re.compile(
    r"\b(certificate|cert|diploma|degree|bachelor|qualification|or equivalent"
    r"|work rights|right to work|police check|working with children|wwcc"
    r"|compliance|eligibility|eligible to work|visa|clearance"
    # "experience in/with/of/working/across …" anywhere — JD-phrasing filler.
    # Matches "experience in aged care", "personal experience in disability",
    # "hands-on experience with dementia", "broad experience working in NDIS",
    # etc. These are role-requirement phrases, never a single skill.
    r"|experience\s+(in|with|of|working|across|supporting)\b"
    # Bare "X experience" where X is a qualifier the JD uses to describe a
    # candidate background ("personal experience", "professional experience",
    # "lived experience", "prior experience"). On their own they are not a
    # skill — they are a category of background.
    r"|(?:professional|personal|lived|prior|previous|extensive|hands[- ]on)\s+experience"
    # "Working / Supporting / Caring for [population]" — JD-phrasing for WHO
    # the work is with, not a discrete skill. "Working with Seniors",
    # "Supporting Older People", "Caring for Children". The audience belongs
    # in the summary; the actual skills (Personal Care, Dementia Care,
    # Behavioural Management) live in the appropriate Skills line. "with"
    # is optional — natural English has both "supporting seniors" and
    # "working with seniors".
    r"|(?:working|supporting|caring\s+for|engaging)(?:\s+with)?\s+"
    r"(?:the\s+)?"
    r"(?:seniors|elderly|aged|older\s+(?:people|adults|persons|australians)"
    r"|children|adolescents|adults|youth|patients|residents|clients"
    r"|families|consumers|participants|vulnerable\s+(?:people|adults)"
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


_SKILLS_LINE_RE = re.compile(r"^(\s*\*\*[^*]+:\*\*\s*)(.*)$")


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
        kept = [p for p in parts if p and not _is_non_skill_phrase(p)]
        removed += len([p for p in parts if p]) - len(kept)
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
        new_line = prefix + ", ".join(kept) if kept else ""
        if kept:
            lines[i] = new_line
    if dropped:
        logger.info("w8: deduped %d cross-line Skills entr(ies)", dropped)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Awards-only Certifications → "Awards". The source CV often parks an award
# (e.g. "Staff Excellence Award") under a "Certifications" heading. When every
# entry is an award/recognition and none is an actual credential, relabel the
# heading so it reads honestly. Mixed or cert-bearing sections are left alone.
# ---------------------------------------------------------------------------

_AWARD_RE = re.compile(
    # award/prize/honour/medal/dean's-list/scholarship — exact nouns.
    # Plus recognition/recognised/recognize/recognised — the italic
    # continuation line of two-line H3+italic entries often uses the
    # past-tense verb ("Recognised for hard work…") instead of the noun,
    # and without it, the all() check rejects the entry as non-award.
    r"\b(award|recognition|recognise[d]?|recognize[d]?|prize|honou?r|medal"
    r"|dean'?s list|scholarship|commendation|excellence)\b",
    re.IGNORECASE,
)
_CERT_LIKE_RE = re.compile(
    r"\b(certificate|certification|certified|licen[sc]e|diploma|accreditation"
    r"|police check|first aid|cpr|working with children|wwcc|registration"
    r"|qualification)\b",
    re.IGNORECASE,
)


_AWARDS_SOURCE_HEADINGS = {
    "certifications",
    "recognition",
    "recognitions",
    "achievements",
    "achievement",
    "honours",
    "honors",
    "accolades",
}


_DATE_TAIL_RE = re.compile(
    r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
    r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
    r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*$",
    re.IGNORECASE,
)


def _is_valid_date(d: str) -> bool:
    if not d:
        return False
    has_digit = any(c.isdigit() for c in d)
    has_month = bool(re.search(
        r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b",
        d,
        re.IGNORECASE
    ))
    return has_digit or has_month


def _parse_award_parts(content: str) -> tuple:
    """Extract (name, org, date, description) from any observed award text.

    Handles the four production shapes seen in awards bullets/h3 bodies:
      pipe form:   "Name – Org | Date – Description"
      paren form:  "Name – Org (Date), description"
      plain form:  "Name – Org (Date)"
      bare name:   "Dean's List"
    """
    name = org = date = description = ""
    if "|" in content:
        left, right = content.rsplit("|", 1)
        right = right.strip()
        for sep in (" – ", " — ", " - ", ", "):
            if sep in right:
                date, description = right.split(sep, 1)
                date = date.strip()
                description = description.strip()
                break
        else:
            date = right
        left = left.strip()
        for sep in (" – ", " — ", " - "):
            if sep in left:
                name, org = left.split(sep, 1)
                break
        else:
            name = left
    else:
        m = re.search(r"\(([^()]+)\)", content)
        if m:
            date = m.group(1).strip()
            before = content[:m.start()].strip()
            after = content[m.end():].strip().lstrip(",").strip()
            description = after
            for sep in (" – ", " — ", " - "):
                if sep in before:
                    name, org = before.split(sep, 1)
                    break
            else:
                name = before
        else:
            for sep in (" – ", " — ", " - "):
                if sep in content:
                    name, org = content.split(sep, 1)
                    break
            else:
                name = content
    return name.strip(), org.strip(), date.strip(), description.strip()


_AU_LOCATION_TAIL_RE = re.compile(
    # Strips ", State[, Australia]" or ", Country" from the end of an org name.
    # A trailing suburb (e.g. "…Home Miranda, NSW") may leave the suburb word
    # behind — that is an acceptable trade-off vs. mis-stripping org words.
    r",\s*(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
    r"|New South Wales|Victoria|Queensland|Western Australia|South Australia"
    r"|Tasmania|Australian Capital Territory|Northern Territory"
    r"|Australia)\b.*$",
    re.IGNORECASE,
)


def _strip_au_location(org: str) -> str:
    """Remove trailing Australian suburb/state/country from an org name."""
    cleaned = _AU_LOCATION_TAIL_RE.sub("", org).strip().rstrip(",").strip()
    return cleaned if cleaned else org


def _format_award_entry(name: str, org: str, date: str, description: str = "") -> list:
    """Produce the canonical structured Awards entry lines for ## Awards.

    Output shape (mirrors Experience header layout):
      ### Award Name | Date
      *Organisation*
      Description sentence.
    """
    header = f"### {name} | {date}" if date else f"### {name}"
    lines = [header]
    if org:
        lines.append(f"*{_strip_au_location(org)}*")
    if description:
        desc = description.strip().rstrip(".")
        # Sentence-case the description (title-cased from italic is noisy).
        desc = desc[0].upper() + desc[1:].lower() if len(desc) > 1 else desc.upper()
        desc = _canonicalise_skill_spelling(desc)
        lines.append(f"{desc}.")
    return lines


# Keep the old name as an alias so any external callers are not broken.
def _format_award_bullet(name: str, org: str, date: str) -> str:
    return "\n".join(_format_award_entry(name, org, date))


def _normalise_awards_entries(markdown: str) -> str:
    """Normalise every entry inside ## Awards to the structured header format:

      ### Award Name | Date
      *Organisation*
      Description sentence.

    Handles all production input shapes (verbose bullet with pipe/paren date,
    two-line H3+italic block, already-structured H3 entries). No-op when the
    Awards section is absent.
    """
    lines = markdown.split("\n")
    start = next(
        (i for i, l in enumerate(lines)
         if l.strip().lower().rstrip(":") == "## awards"),
        -1,
    )
    if start < 0:
        return markdown
    end = next(
        (j for j in range(start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    new_entries: list[str] = []
    i = start + 1
    while i < end:
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue

        if stripped.startswith("### "):
            # H3 shape — could be old "Award, Org | Location" or new "Award | Date".
            h3 = stripped[4:].strip()
            # Peek at the next line(s) for italic (org) and plain (description).
            italic_text = plain_text = ""
            j = i + 1
            if j < end and lines[j].strip().startswith("*") and lines[j].strip().endswith("*"):
                italic_text = lines[j].strip().strip("*").strip()
                j += 1
            if j < end and lines[j].strip() and not lines[j].strip().startswith(("*", "### ", "## ", "-")):
                plain_text = lines[j].strip()
                j += 1

            # Decide if this is the NEW shape (h3 = "Name | Date") or OLD
            # shape (h3 = "Name, Org | Location", italic = "Desc | Date").
            if "|" in h3 and (italic_text.startswith("*") or not italic_text
                               or re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b", h3)):
                # NEW shape or h3 with explicit date — keep as structured.
                name_part, date_part = h3.split("|", 1)
                name = name_part.strip()
                date = date_part.strip()
                org = italic_text
                description = plain_text
            else:
                # OLD shape: h3 = "Name, Org | Location", italic = "Desc | Date"
                h3_core = h3.split("|", 1)[0].strip() if "|" in h3 else h3
                if "," in h3_core:
                    name, org = h3_core.split(",", 1)
                    name = name.strip()
                    org = org.strip()
                else:
                    name, org = h3_core, ""
                # Date is right of LAST "|" in italic; text before is description.
                # When there is no italic line, fall back to plain_text and
                # extract a trailing month+year or year as the date.
                if "|" in italic_text:
                    desc_part, date = italic_text.rsplit("|", 1)
                    description = desc_part.strip()
                    date = date.strip()
                elif italic_text:
                    date = ""
                    description = italic_text
                elif plain_text:
                    # Plain-text companion line: "Desc… Month YYYY" — split off date.
                    m_date = _DATE_TAIL_RE.search(plain_text)
                    if m_date:
                        date = m_date.group(1).strip()
                        description = plain_text[:m_date.start()].strip().rstrip(",").strip()
                    else:
                        date = ""
                        description = plain_text
                    # plain_text already consumed above — advance j past it.
                    # (j was already incremented when plain_text was set)
                else:
                    date = ""
                    description = ""

            # Location filtering and org rescue for H3 branch
            if date and not _is_valid_date(date):
                if not org:
                    # Extract org name before first comma of the non-date string
                    org = date.split(",", 1)[0].strip()
                date = ""
            
            # If date is now empty, see if we can extract it from description
            if not date and description:
                m_date = _DATE_TAIL_RE.search(description)
                if m_date:
                    date = m_date.group(1).strip()
                    description = description[:m_date.start()].strip().rstrip(",").strip()
            
            # Final safety check on date
            if not _is_valid_date(date):
                date = ""

            for ln in _format_award_entry(name, org, date, description):
                new_entries.append(ln)
            i = j

        else:
            # It's a bullet or a plain paragraph!
            # Strip any leading bullet character (e.g. • or - or * or whitespace)
            content = stripped.lstrip("-*• ").strip()
            
            # Look ahead to see if the next line is a description bullet/paragraph
            j = i + 1
            next_bullet_desc = ""
            while j < end and not lines[j].strip():
                j += 1
            if j < end and not lines[j].strip().startswith("### "):
                next_stripped = lines[j].strip()
                next_content = next_stripped.lstrip("-*• ").strip()
                if re.match(
                    r"^(?:recognised|recognized|awarded|received|nominated|presented|given)\b",
                    next_content,
                    re.IGNORECASE
                ):
                    next_bullet_desc = next_content
                    i = j  # consume the next line

            name, org, date, description = _parse_award_parts(content)

            # Location filtering: if the parsed date is not valid, discard both date and description
            if not _is_valid_date(date):
                # If org is not set, rescue the non-date part of right side as org
                if not org and date:
                    org = date.split(",", 1)[0].strip()
                date = ""
                description = ""

            if next_bullet_desc:
                next_date = ""
                m_date = _DATE_TAIL_RE.search(next_bullet_desc)
                if m_date:
                    next_date = m_date.group(1).strip()
                    next_desc = next_bullet_desc[:m_date.start()].strip().rstrip(",").strip()
                else:
                    next_desc = next_bullet_desc

                if not date and _is_valid_date(next_date):
                    date = next_date
                
                if description:
                    description = f"{description}. {next_desc}"
                else:
                    description = next_desc

            if not _is_valid_date(date):
                date = ""

            for ln in _format_award_entry(name, org, date, description):
                new_entries.append(ln)
            i += 1

    if not new_entries:
        return markdown

    # Blank line between entries, then a trailing blank before the next section.
    spaced: list[str] = []
    for ln in new_entries:
        if ln.startswith("### ") and spaced:
            spaced.append("")
        spaced.append(ln)

    rebuilt = [lines[start], ""] + spaced + [""]
    return "\n".join(lines[:start] + rebuilt + lines[end:])


def _relabel_awards_only_certifications(markdown: str) -> str:
    """Rename a credentials-style heading to ``## Awards`` when its entries
    are all award/recognition lines and none is an actual credential.

    Catches Certifications AND the AI's recurring alternatives — Recognition,
    Achievements, Honours. Without this, an ## Recognition section emitted by
    the writer (production Sanctuary CV) escapes the relabel and persists as
    an off-rolepack heading, breaking section_order semantics."""
    lines = markdown.split("\n")
    start = None
    end = len(lines)
    for i, line in enumerate(lines):
        if line.startswith("## "):
            heading = line[3:].strip().lower().rstrip(":")
            if heading in _AWARDS_SOURCE_HEADINGS and start is None:
                start = i
                continue
            if start is not None:
                end = i
                break
    if start is None:
        return markdown

    content = [ln.strip() for ln in lines[start + 1:end] if ln.strip()]
    if not content:
        return markdown
    if all(_AWARD_RE.search(e) for e in content) and not any(
        _CERT_LIKE_RE.search(e) for e in content
    ):
        original_heading = lines[start][3:].strip().rstrip(":")
        lines[start] = "## Awards"
        logger.info(
            "w8: relabelled awards-only %s section to Awards",
            original_heading,
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Awards / certifications recovery — deterministic, grounded in the original CV.
# The composition writer occasionally drops the whole Certifications/Awards
# section (run-to-run variance), silently losing genuine achievements the
# candidate listed. Like ensure_bachelor for the degree, this re-adds any
# original Certifications/Awards entry that is missing from the tailored CV.
# Honest by construction: entries are copied verbatim from the source CV and
# only re-added when absent (so it never duplicates or invents).
# ---------------------------------------------------------------------------

# Headings (markdown or plain) whose entries we treat as awards/credentials.
_CRED_KEYWORDS = {
    "certifications", "certification", "cert", "certs", "awards", "award",
    "honours", "honors", "recognition", "recognitions", "accolades",
    "clearances", "clearance", "checks", "check", "licences", "licence",
    "licenses", "license", "registration", "registrations", "achievements",
    "achievement", "credential", "credentials", "development",
}
# Other common CV headings — used to detect where a credentials section ends.
_OTHER_SECTION_WORDS = {
    "education", "experience", "work experience", "professional experience",
    "clinical experience", "skills", "summary", "professional summary",
    "profile", "projects", "references", "interests", "languages", "contact",
    "objective", "career highlights", "registration & licences",
}


def _is_cred_heading(heading: str, is_explicit: bool = False) -> bool:
    h = heading.lower()
    if h in _OTHER_SECTION_WORDS:
        return False
    if not is_explicit:
        if h.startswith(("-", "*", "•")):
            return False
        if len(h.split()) > 5:
            return False
    tokens = re.findall(r"\b\w+\b", h)
    return any(t in _CRED_KEYWORDS for t in tokens)


def _cv_heading_word(line: str) -> Optional[str]:
    """If `line` is a section heading (markdown '## X' or a bare label line),
    return its lowercased label; else None."""
    s = line.strip()
    if s.startswith("## "):
        label = s[3:].strip().lower().rstrip(":")
        if _is_cred_heading(label, is_explicit=True) or label in _OTHER_SECTION_WORDS:
            return label
        return None
    low = s.lower().rstrip(":").strip()
    if _is_cred_heading(low, is_explicit=False) or low in _OTHER_SECTION_WORDS:
        return low
    return None


def _extract_original_credentials(cv_text: str) -> list[str]:
    """Entries listed under a Certifications/Awards-type heading in the source CV."""
    entries: list[str] = []
    collecting = False
    for raw in (cv_text or "").split("\n"):
        word = _cv_heading_word(raw)
        if word is not None:
            collecting = _is_cred_heading(word, is_explicit=True)
            continue
        if not collecting:
            continue
        item = raw.strip().lstrip("-*•").strip()
        if item and len(item) <= 160:
            entries.append(item)
    seen: set[str] = set()
    return [e for e in entries if not (e.lower() in seen or seen.add(e.lower()))]


def _awards_section_text(markdown: str) -> str:
    """Return the lowercased text of every credential/awards section in the
    markdown, joined. Used to decide if an award is already surfaced as a
    DEDICATED entry (Certifications/Awards/Achievements section), not just
    mentioned inline in an Experience bullet. Returns "" when no such section
    exists."""
    lines = markdown.split("\n")
    parts: list[str] = []
    collecting = False
    for ln in lines:
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            collecting = _is_cred_heading(heading, is_explicit=True)
            continue
        if collecting and ln.strip():
            parts.append(ln.lower())
    return "\n".join(parts)


def ensure_awards(markdown: str, original_cv_text: str) -> str:
    """Re-add original-CV *award/recognition* entries the tailoring dropped.

    Award-only by design: trainings, certificates, licences and checks are NOT
    recovered here (the writer/structure path owns real credentials, and
    re-adding them tends to resurrect verbose JD-phrasing junk). No-op when the
    original lists no awards, or every award already appears as a dedicated
    entry in a Certifications/Awards section (an inline mention inside an
    Experience bullet does NOT count — the dedicated entry is what we recover).
    """
    entries = [e for e in _extract_original_credentials(original_cv_text)
               if _AWARD_RE.search(e) and not _CERT_LIKE_RE.search(e)]
    if not entries:
        return markdown
    # Scope the "already present" check to credential/awards sections only.
    # Bullets like "Received Staff Excellence Award at Jesmond…" in Experience
    # are NOT a substitute for a dedicated Awards entry — we still recover.
    awards_text = _awards_section_text(markdown)
    missing: list[str] = []
    for e in entries:
        core = re.split(r"\s[–—-]\s|\(|,", e)[0].strip().lower()
        if (core and core in awards_text) or e.lower() in awards_text:
            continue
        missing.append(e)
    if not missing:
        return markdown
    missing = missing[:4]

    lines = markdown.rstrip("\n").split("\n")
    # Append into an existing credentials section if present, else create one.
    sec_start = None
    sec_end = len(lines)
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and _is_cred_heading(ln[3:].strip().rstrip(":"), is_explicit=True):
            sec_start = i
            sec_end = next(
                (j for j in range(i + 1, len(lines)) if lines[j].startswith("## ")),
                len(lines),
            )
            break

    bullets = [f"- {m}" for m in missing]
    if sec_start is not None:
        insert_at = sec_end
        while insert_at - 1 > sec_start and not lines[insert_at - 1].strip():
            insert_at -= 1
        new_lines = lines[:insert_at] + bullets + lines[insert_at:]
    else:
        new_lines = lines + ["", "## Certifications"] + bullets
    logger.info("w8: recovered %d dropped credential/award entr(ies) from CV", len(missing))
    return "\n".join(new_lines)


# Sections whose bullet entries must be grounded in the original CV. The AI
# composer sometimes invents credentials/checks (e.g. "First Aid Training –
# [Provider not specified]", "Driver Licence (NSW)") that the candidate never
# listed. We drop any bullet that carries a placeholder marker or whose lead
# phrase is absent from the source CV, and remove a section left empty.
_GROUNDED_SECTION_WORDS = {
    "certifications", "certification", "checks & clearances",
    "checks and clearances", "clearances", "checks", "licences", "licenses",
    "registration", "registrations", "registration & licences",
    "professional development",
}
_PLACEHOLDER_RE = re.compile(
    r"\[[^\]]*\]|not\s+specified|not\s+provided|tbc|to\s+be\s+confirmed",
    re.IGNORECASE,
)


def _strip_ungrounded_credentials(markdown: str, original_cv_text: str) -> str:
    """Drop AI-fabricated entries from credential/checks sections.

    For any section whose heading is a credential/checks word, remove bullet
    entries that (a) contain a placeholder marker, or (b) whose distinctive lead
    phrase is not a substring of the original CV. A section emptied of bullets is
    removed entirely."""
    cv_low = (original_cv_text or "").lower()
    lines = markdown.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith("## ") and line[3:].strip().lower().rstrip(":") in _GROUNDED_SECTION_WORDS:
            j = i + 1
            while j < n and not lines[j].startswith("## "):
                j += 1
            body = lines[i + 1:j]
            kept: list[str] = []
            dropped = 0
            kept_bullet = False
            for bl in body:
                stripped = bl.strip()
                is_bullet = stripped[:1] in ("-", "*", "•")
                if not is_bullet:
                    kept.append(bl)
                    continue
                entry = stripped.lstrip("-*•").strip()
                core = re.split(r"\s[–—-]\s|\(|,", entry)[0].strip().lower()
                grounded = bool(core) and core in cv_low
                if _PLACEHOLDER_RE.search(entry) or not grounded:
                    dropped += 1
                    continue
                kept.append(bl)
                kept_bullet = True
            if dropped:
                logger.info(
                    "w8: dropped %d ungrounded credential entr(ies) from %s",
                    dropped, line[3:].strip(),
                )
            if kept_bullet:
                out.append(line)
                out.extend(kept)
            # else: section had no grounded bullets → drop heading + body.
            i = j
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


async def _writer_w5_surfacing(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)

    role_family = resolve_role_family(vertical, up["jd_analysis"])
    seniority = resolve_seniority(up["jd_analysis"])
    system_prompt = build_surfacing_system(role_family, seniority)

    terms = _matched_surface_terms(up["matching"])
    surface_block = ", ".join(terms) if terms else "(none — surface only what the CV already states)"
    user_prompt = COMPOSITION_SURFACING_USER_TEMPLATE.format(
        cv_text=cv_text, jd_text=jd_text, surface_terms=surface_block,
    )
    raw = await client.complete(
        system=system_prompt, user=user_prompt, max_tokens=6144, temperature=0.3,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W5 tailored CV: response too short")

    final_md = _postprocess(raw, up["feasibility"], contact_details)
    final_md = apply_w3_gates(
        final_md,
        jd_text=jd_text,
        jd_analysis=up["jd_analysis"],
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
        keep_skills=_inject_keyword_set(up["feasibility"]),
    )
    final_md = enforce_skills_section(
        final_md,
        original_cv_text=cv_text,
        drop_ungrounded=(role_family.injection_policy == "none"),
    )
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={
            "role_family": role_family.id,
            "seniority": seniority,
            "surfaced_terms": len(terms),
        },
    )


# ---------------------------------------------------------------------------
# W6 — re-engineered general W1. SAME pipeline + SAME post-processors as W1/W2;
# only the system prompt changes (de-biased, generalised, ATS-research-informed).
# No role-pack machinery, no extra gates — this tests whether a single well-
# crafted general prompt fixes W1 without the W3 architecture.
# ---------------------------------------------------------------------------


async def _writer_w6_general(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,  # not needed — the prompt is field-agnostic
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    up["feasibility"] = restrict_domain_to_direct(up["feasibility"])  # domain expertise can't be inferred
    recs_md = await run_ai_recommendations(
        client, cv_text, up["jd_analysis"], up["matching"], up["input_recs"], up["feasibility"],
    )
    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}
    user_prompt = TAILORED_CV_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(up["jd_analysis"], indent=2),
        ai_recommendations_md=recs_md,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=TAILORED_CV_W6_SYSTEM,
        user=user_prompt,
        max_tokens=6144,
        temperature=0.3,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W6 tailored CV: response too short")
    final_md = _postprocess(raw, up["feasibility"], contact_details)
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={"input_recommendations": up["input_recs"], "ai_recommendations_md": recs_md},
    )


# ---------------------------------------------------------------------------
# W7 — convergence. W6's generation prompt (best writing: clean 2-sentence
# Highlights, honest lift, fast, general) run through W3's deterministic gates
# (suppression / degree relevance / ungrounded-strip / skills hygiene) — the
# things proven not to hold as prompt prose. Best of both, in one variant.
# ---------------------------------------------------------------------------


async def _writer_w7_converged(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text, contact_details)
    up["feasibility"] = restrict_domain_to_direct(up["feasibility"])  # domain expertise can't be inferred
    recs_md = await run_ai_recommendations(
        client, cv_text, up["jd_analysis"], up["matching"], up["input_recs"], up["feasibility"],
    )
    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}
    user_prompt = TAILORED_CV_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(up["jd_analysis"], indent=2),
        ai_recommendations_md=recs_md,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=TAILORED_CV_W6_SYSTEM,   # W6's generation prompt
        user=user_prompt,
        max_tokens=6144,
        temperature=0.3,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W7 tailored CV: response too short")

    role_family = resolve_role_family(vertical, up["jd_analysis"])

    # Production post-processors → W3 deterministic gates → skills hygiene.
    final_md = _postprocess(raw, up["feasibility"], contact_details)
    final_md = apply_w3_gates(
        final_md,
        jd_text=jd_text,
        jd_analysis=up["jd_analysis"],
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
        keep_skills=_inject_keyword_set(up["feasibility"]),
    )
    final_md = enforce_skills_section(
        final_md,
        original_cv_text=cv_text,
        drop_ungrounded=(role_family.injection_policy == "none"),
    )
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={
            "input_recommendations": up["input_recs"],
            "role_family": role_family.id,
            "ai_recommendations_md": recs_md,
        },
    )


# ---------------------------------------------------------------------------
# W8 — production-contract integration of the role-family engine.
#
# The deliverable of the "document production → integrate into the new engine →
# adapt for nursing" task. It is the role-family COMPOSITION writer (W3's
# architecture: [universal engine] + [role-family pack] + [seniority overlay],
# correct per-family section order and skills taxonomy) run through the EXACT
# FROZEN production presentation contract — reproduced 1:1 via the canonical
# sandwich (enforce_w8): rename the family's section headings to the production
# canonical names, run the verbatim production post-processors + the proven W3
# gates + skills hygiene, rename back, then reorder to the family's section
# order. No production code is forked or re-implemented, so the PDF format,
# bullet-writing method, bullet counts, and the 2-sentence/35-50-word summary
# method are identical to production. Fixes W7's one residual: W8 leads nursing
# with "Registration & Licences" and honours every family's section order.
#
# Honesty stack (same as W7): domain_knowledge restricted to direct-only,
# suppression for tech/master, degree relevance, ungrounded-strip, skills caps.
# ---------------------------------------------------------------------------


async def _writer_w8_integrated(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
    upstream: Optional[Dict[str, Any]] = None,
) -> WriterResult:
    # `upstream` lets the production orchestrator hand in its already-computed
    # jd_analysis/matching/ats/input_recs/feasibility so the w8 path doesn't
    # re-pay those AI calls. The eval harness passes nothing → recompute.
    up = dict(upstream) if upstream is not None else await _run_upstream(client, cv_text, jd_text, contact_details)
    up["feasibility"] = restrict_domain_to_direct(up["feasibility"])  # domain expertise can't be inferred

    role_family = resolve_role_family(vertical, up["jd_analysis"])
    seniority = resolve_seniority(up["jd_analysis"])
    # W8.3 — promote JD terms the CV honestly justifies via the family's verified
    # equivalence table (replaces over-permissive AI guessing for these terms).
    up["feasibility"] = apply_equivalences(up["feasibility"], cv_text, jd_text, role_family)
    system_prompt = build_composition_system(role_family, seniority)

    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}
    user_prompt = COMPOSITION_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_text=jd_text,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=system_prompt,
        user=user_prompt,
        max_tokens=6144,
        temperature=0.35,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W8 tailored CV: response too short")

    # ── Canonical sandwich — reproduce the FROZEN production contract 1:1 ──
    # 1. Rename the family's section headings to the production canonical names.
    md = to_canonical(raw.strip(), role_family)
    # 2. Run the VERBATIM production post-processors (structural caps, bullet
    #    method, summary clamp, education rules, skills safety-net injector).
    md = _enforce_structure(md)
    md = _inject_missing_skills(md, up["feasibility"])
    md = stamp_contact_line(md, contact_details)
    # 3. Proven W3 deterministic gates (suppression / degree relevance /
    #    ungrounded-strip) + skills hygiene — all expect canonical names.
    md = apply_w3_gates(
        md,
        jd_text=jd_text,
        jd_analysis=up["jd_analysis"],
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
        keep_skills=_inject_keyword_set(up["feasibility"]),
    )
    md = enforce_skills_section(
        md,
        original_cv_text=cv_text,
        drop_ungrounded=(role_family.injection_policy == "none"),
    )
    # 3a. Re-surface JD terms the matcher confirmed but the rewrite dropped, so the
    #     tailored CV never scores BELOW the original on keywords it already had.
    #     Honest (matched-only) and AFTER the hygiene cap so it can't be stripped.
    #     Skipped for the "none" policy (trades) where minimalism is intentional.
    if role_family.injection_policy != "none":
        md = _surface_matched_skills(md, up["matching"])
    # 3a-bis. Strip non-skill entries (qualifications, eligibility/compliance,
    #     bare sector names, JD-phrasing fillers) from the Skills section, no
    #     matter whether the base classifier or the surfacing pass added them.
    md = _strip_non_skill_phrases(md)
    # 3a-ter. Normalise case across all Skills entries — Title Case with
    #     preservation rules for acronyms (SQL/NDIS), digit tokens (GA4), and
    #     mixed-case product names (BESTMed/MedMobile). Fixes inconsistent
    #     casing between AI-written entries and surfacing-pass entries.
    md = _normalise_skills_case(md)
    # 3a-quater. Canonicalise British/American spellings AND dedupe duplicates
    #     across Skills lines. "Person-Centered Care" in Other Skills + "Person-
    #     Centred Care" in Care Skills are the same skill — keep only the
    #     earlier-line entry, drop the later. Applies British spelling
    #     (Australian default) to all surviving entries.
    md = _dedupe_skills_across_lines(md)
    # 3b. Deterministic Bachelor recovery — re-add a dropped baseline degree from
    #     the original CV (the writer occasionally drops it despite the prompt).
    md = ensure_bachelor(md, cv_text)
    # 3c. Deterministic award/credential recovery — re-add a Certifications/Awards
    #     entry from the original CV that the rewrite silently dropped.
    md = ensure_awards(md, cv_text)
    # 4. Rename canonical headings back to the family's names and apply the
    #    family's section order (fixes W7's nursing section-order residual).
    final_md = restore_and_order(md, role_family)
    # 4a. Drop AI-fabricated credential/checks entries not grounded in the CV
    #     (e.g. "First Aid – [Provider not specified]", "Driver Licence (NSW)").
    final_md = _strip_ungrounded_credentials(final_md, cv_text)
    # 4b. Relabel an awards-only "Certifications" / "Recognition" section to "Awards".
    final_md = _relabel_awards_only_certifications(final_md)
    # 4b-bis. Normalise every entry in ## Awards to a single clean bullet
    #     `- Name – Organisation (Date)` — collapses the two-line H3+italic
    #     block shape the writer sometimes emits, and strips trailing
    #     "Recognised for hard work…" descriptive text from verbose bullets.
    final_md = _normalise_awards_entries(final_md)
    # 4c. Stamp user-supplied credentials into ## Registration & Licences
    #     (nursing/healthcare/care families only; no-op when role family is
    #     tech/manual/general or when the user has saved no credentials).
    #     Replaces any AI-emitted body in that section — the user's profile
    #     is authoritative for what they actually hold.
    final_md = stamp_credentials(final_md, contact_details, role_family.id)

    # W8.2 — knockout pass (deterministic, no AI). Honest hard-requirement report
    # (mandatory licence / minimum years / work rights) that a CV edit can't fix.
    knockouts = detect_knockouts(jd_text, up["jd_analysis"], cv_text)

    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={
            "input_recommendations": up["input_recs"],
            "role_family": role_family.id,
            "seniority": seniority,
            "section_order": role_family.section_order,
            "knockouts": knockouts,
        },
    )


# ---------------------------------------------------------------------------
# W8-verified — W8 + Stage-6 per-claim entailment verification (W8.1).
# Identical to w8_integrated, then runs one focused entailment pass that repairs
# or drops any tailored bullet not entailed by the source CV. Shipped as a
# separate variant so the beta screen can A/B the honesty lift (W8 vs W8+verify)
# and prove it before the verifier is promoted into the single production path.
# ---------------------------------------------------------------------------


async def _writer_w8_verified(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
    upstream: Optional[Dict[str, Any]] = None,
) -> WriterResult:
    result = await _writer_w8_integrated(
        client, cv_text, jd_text, contact_details, vertical=vertical, upstream=upstream,
    )
    verified_md, vreport = await verify_claims(client, result.tailored_md, cv_text)
    # Re-assert the field-agnostic lead-identity trim as the LAST word:
    # verify_claims' summary repair can honestly (CV-true) re-introduce an
    # off-axis conjoined identity the integrated gate already trimmed. Anchored
    # on the JD title, deterministic, touches only the summary's lead role.
    verified_md = enforce_summary_identity(verified_md, result.jd_analysis)
    result.tailored_md = verified_md
    result.extras["verify"] = vreport
    return result


# ---------------------------------------------------------------------------
# W8-critique — W8 + Stage-5 AI critique-and-repair + Stage-6 entailment verify.
# Strongest honest path: compose + deterministic enforce (the integrated draft),
# then ONE JD-aware critique pass that re-targets and sharpens the draft using
# only truthful material, then the SAME deterministic enforce layer re-run as a
# safety net (so any fact the critique slips in is mechanically stripped), then
# the per-claim entailment verifier as the final honesty gate. One extra AI call
# over w8_verified; shipped as a separate variant to A/B the quality lift.
# ---------------------------------------------------------------------------


async def _writer_w8_critique(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
) -> WriterResult:
    # 1. Compose + deterministic enforce (no verify yet) — the integrated draft.
    result = await _writer_w8_integrated(
        client, cv_text, jd_text, contact_details, vertical=vertical,
    )
    role_family = resolve_role_family(vertical, result.jd_analysis)

    # 2. AI critique-and-repair: JD-aware quality lift, honesty-gated by prompt.
    revised, creport = await critique_and_repair(
        client, result.tailored_md, cv_text, jd_text, role_family,
    )
    result.extras["critique"] = creport

    # 3. Deterministic safety net on the revised draft — the SAME proven gates as
    #    the integrated path (ungrounded-strip, suppression, skills hygiene,
    #    structure, family order). Any fact the critique slipped in is removed.
    if creport.get("applied"):
        md = to_canonical(revised, role_family)
        md = _enforce_structure(md)
        # Parity with the integrated path: re-assert the deterministic skills
        # injector and the authoritative contact line, in case the critique
        # dropped an injected keyword or touched the contact/H1 lines.
        md = _inject_missing_skills(md, result.feasibility)
        md = stamp_contact_line(md, contact_details)
        md = apply_w3_gates(
            md,
            jd_text=jd_text,
            jd_analysis=result.jd_analysis,
            suppress=role_family.id in ("tech", "master"),
            original_cv_text=cv_text,
            keep_skills=_inject_keyword_set(result.feasibility),
        )
        md = enforce_skills_section(
            md,
            original_cv_text=cv_text,
            drop_ungrounded=(role_family.injection_policy == "none"),
        )
        md = _strip_non_skill_phrases(md)
        md = _normalise_skills_case(md)
        md = ensure_bachelor(md, cv_text)
        md = ensure_awards(md, cv_text)
        revised = restore_and_order(md, role_family)
        revised = _strip_ungrounded_credentials(revised, cv_text)
        revised = _relabel_awards_only_certifications(revised)
    else:
        revised = result.tailored_md

    # 4. Final honesty gate: per-claim entailment on the (possibly) revised CV.
    verified_md, vreport = await verify_claims(client, revised, cv_text)
    # Re-assert the field-agnostic lead-identity trim as the LAST word — same
    # rationale as w8_verified: verify's summary repair can re-add an off-axis
    # conjoined identity that's CV-true but not the JD's role.
    verified_md = enforce_summary_identity(verified_md, result.jd_analysis)
    result.tailored_md = verified_md
    result.extras["verify"] = vreport
    return result


WRITER_VARIANTS: Dict[str, WriterFn] = {
    "w1_current":     _writer_w1_current,
    "w2_general":     _writer_w2_general,
    "w3_composition": _writer_w3_composition,
    "w4_chat":        _writer_w4_chat,
    "w5_surfacing":   _writer_w5_surfacing,
    "w6_general":     _writer_w6_general,
    "w7_converged":   _writer_w7_converged,
    "w8_integrated":  _writer_w8_integrated,
    "w8_verified":    _writer_w8_verified,
    "w8_critique":    _writer_w8_critique,
}


def get_writer(writer_variant: str) -> WriterFn:
    fn = WRITER_VARIANTS.get(writer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown writer_variant '{writer_variant}'. "
            f"Known: {sorted(WRITER_VARIANTS)}"
        )
    return fn


# ---------------------------------------------------------------------------
# Production entry point — drop-in replacement for run_tailored_cv that routes
# the tailoring step through the validated w8_verified writer while preserving
# the exact (markdown, storage_path) contract the orchestrator depends on.
#
# The orchestrator hands in the upstream artifacts it already computed
# (jd_analysis/matching/ats/input_recs/feasibility) so this adds only the
# composition + entailment-verify calls — no duplicate upstream AI calls. The
# markdown is uploaded to the SAME storage path (<user_id>/<run_id>.md) via the
# production uploader, so the PDF render and storage path stay identical.
# ---------------------------------------------------------------------------


async def run_tailored_cv_w8_verified(
    client: AIClient,
    user_id: uuid.UUID,
    run_id: uuid.UUID,
    cv_text: str,
    jd_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    ats: Dict[str, Any],
    input_recs: Dict[str, Any],
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]] = None,
) -> tuple[str, str]:
    """Returns (markdown, storage_path) — same contract as run_tailored_cv."""
    upstream = {
        "jd_analysis": jd_analysis,
        "matching":    matching,
        "ats":         ats,
        "input_recs":  input_recs,
        "feasibility": feasibility,
    }
    result = await _writer_w8_verified(
        client, cv_text, jd_text, contact_details,
        vertical=None, upstream=upstream,
    )
    md = result.tailored_md
    if not md or len(md.strip()) < 200:
        raise ValueError("w8_verified tailored CV: response too short")
    storage_path = _upload_to_storage(user_id, run_id, md)
    return md, storage_path
