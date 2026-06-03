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
from app.services.eval.enforce_w3 import (
    apply_w3_gates,
    restrict_domain_to_direct,
    enforce_summary_identity,
    enforce_summary_breadth_consistency,
    enforce_summary_dedup,
    enforce_summary_title_dedup,
    enforce_summary_skills_dedup,
)
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

# Strip an optional leading list bullet ("- ", "* ", "• ") so category-line
# detection works whether or not enforce_skills_section has stamped the bullet
# prefix that the web/PDF renderers need.
_LEADING_BULLET_RE = re.compile(r"^[-*•]\s+")


def _line_starts_label(line: str, label: str) -> bool:
    """True if `line` (ignoring leading whitespace + an optional list bullet)
    starts with the bold category `label`."""
    return _LEADING_BULLET_RE.sub("", line.lstrip()).startswith(label)


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
            if _line_starts_label(lines[i], label):
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


# Brand-name tools the candidate uses that should NEVER disappear from the
# tailored CV's Skills section, even when the JD doesn't ask for them. The
# writer prompt sometimes drops these in favour of JD-required generic terms
# ("Basic Computer Skills") — but the candidate's named tools are real
# differentiators recruiters scan for.
#
# Pattern: each entry is a regex matched against the original CV text
# (case-insensitive). When matched in the CV but absent from the tailored
# Skills section, the canonical form is appended to the headline-secondary
# (Other Skills for nursing/manual) line.
#
# Conservative list: only proven nursing/care domain tools that match the
# kind of CV content this app sees. Easy to extend per vertical.
_KNOWN_CV_TOOLS: tuple[tuple[str, str], ...] = (
    # Medication administration / clinical apps used in Australian aged care.
    (r"\bBESTMed\b",   "BESTMed"),
    (r"\bMedMobile\b", "MedMobile"),
    (r"\bLeecare\b",   "Leecare"),
    (r"\bManAd\b",     "ManAd"),
    (r"\bePAS\b",      "ePAS"),
    # Common clinical EHRs (US/AU). Match only when literally in the CV.
    (r"\bEpic\b",      "Epic"),
    (r"\bCerner\b",    "Cerner"),
)


def _surface_cv_named_tools(
    markdown: str, original_cv_text: str, role_family
) -> str:
    """Ensure CV-named brand tools (BESTMed, MedMobile, Leecare, ...) appear
    in the tailored Skills section.

    The writer prompt sometimes drops these in favour of JD-required generic
    keywords ("Basic Computer Skills", "Smartphone Usage"), wiping the
    candidate's actual differentiating tools. This runs AFTER the cap-and-
    strip dance and re-injects only tools literally present in the original
    CV. Honest by construction — tools must appear in original_cv_text.

    Routes to:
      - Other Skills (when headline_bucket == "domain_knowledge", i.e. nursing
        / manual): tools sit in the secondary "Other" line by convention.
      - Technical Skills (when headline_bucket == "technical", i.e. tech /
        master): tools ARE the headline.
    """
    if not original_cv_text or not markdown:
        return markdown

    # Match brand tools present in the original CV but NOT yet in the tailored
    # Skills section (anywhere — lowercase substring is enough).
    md_lower = markdown.lower()
    missing: list[str] = []
    for pattern, canonical in _KNOWN_CV_TOOLS:
        if re.search(pattern, original_cv_text, flags=re.IGNORECASE):
            if canonical.lower() not in md_lower:
                missing.append(canonical)

    if not missing:
        return markdown

    # Pick the target category: technical for tech-style families, otherwise
    # domain_knowledge (Other Skills for nursing under the canonical sandwich,
    # since headline_bucket == domain_knowledge places "Care Skills" on the
    # technical line and "Other Skills" on the domain_knowledge line).
    target_cat = "technical" if role_family.headline_bucket == "technical" else "domain_knowledge"

    lines = markdown.split("\n")
    skills_start = next(
        (i for i, l in enumerate(lines) if l.strip() == "## Skills"), None,
    )
    if skills_start is None:
        return markdown
    skills_end = next(
        (j for j in range(skills_start + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )

    target_idx = None
    for i in range(skills_start + 1, skills_end):
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label) and cat == target_cat:
                target_idx = i
                break
        if target_idx is not None:
            break
    if target_idx is None:
        return markdown

    cap = _SURFACE_CAPS.get(target_cat, 8)
    existing_count = len([s for s in lines[target_idx].split(",") if s.strip()])
    appended = 0
    for tool in missing:
        if existing_count >= cap:
            break
        lines[target_idx] = f"{lines[target_idx].rstrip()}, {tool}"
        existing_count += 1
        appended += 1

    if appended:
        logger.info("w8 surfacing: re-added %d CV-named tool(s): %s",
                    appended, missing[:appended])

    return "\n".join(lines)


# Buckets the feasibility classifier marks as eligible to inject.
_APPROVED_BUCKETS = ("inject_directly", "inject_as_extension", "inject_with_inference")


def _approved_skill_entries(feasibility: Optional[Dict[str, Any]]) -> list[tuple[str, str]]:
    """(keyword, category) for every approved keyword in a Skills category.

    Pulls from all three injectable buckets (the SAME set the tailored-rescorer
    treats as "approved" → so anything that would otherwise show as "Approved
    but missed" gets one deterministic, post-cap chance to land in Skills).
    """
    plan = (feasibility or {}).get("feasibility_plan") or {}
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for fb in _APPROVED_BUCKETS:
        for entry in plan.get(fb) or []:
            if not isinstance(entry, dict):
                continue
            kw = str(entry.get("keyword") or "").strip()
            cat = str(entry.get("category") or "").strip().lower()
            if not kw or cat not in _SURFACE_CATS:
                continue
            key = kw.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append((kw, cat))
    return out


def _inject_approved_skills(markdown: str, feasibility: Optional[Dict[str, Any]]) -> str:
    """Deterministic POST-CAP safety net for approved-but-missing skill keywords.

    enforce_skills_section caps each Skills line (soft skills at 6), which can
    drop a JD-approved soft skill (e.g. "verbal communication" / "written
    communication") the writer never surfaced, leaving it stuck on the
    "Approved but missed" list forever. This runs AFTER the cap and re-injects
    such keywords into their own category line, bounded by the (more generous)
    surfacing caps, skipping anything already present or flagged as a non-skill
    phrase. Honest: only keywords the feasibility classifier approved.
    """
    entries = _approved_skill_entries(feasibility)
    if not entries:
        return markdown

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

    cat_to_line_idx: Dict[str, int] = {}
    for i in range(skills_start + 1, skills_end):
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label):
                cat_to_line_idx[cat] = i
                break

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    appended = 0
    for kw, cat in entries:
        target_idx = cat_to_line_idx.get(cat)
        if target_idx is None:
            continue
        if _kw_in_skills(kw, skills_text_lower) or _is_non_skill_phrase(kw):
            continue
        cap = _SURFACE_CAPS.get(cat, 8)
        if len(lines[target_idx].split(",")) >= cap:
            continue
        display = _format_skill_label(kw)
        lines[target_idx] = f"{lines[target_idx].rstrip()}, {display}"
        skills_text_lower += ", " + display.lower()
        appended += 1

    if appended:
        logger.info("w8 approved-skill injector: re-added %d approved keyword(s)", appended)

    return "\n".join(lines)


def _drop_subsumed_generic_skills(markdown: str) -> str:
    """Drop a bare single-word Skills entry when a more specific multi-word
    entry already ends with that word.

    e.g. once "Verbal Communication" and "Written Communication" are present,
    the generic "Communication" is redundant noise. Same for "Care" vs
    "Personal Care", "Management" vs "Time Management". Operates only inside the
    ``## Skills`` section, across all category lines; first-listed wins.
    """
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

    # Collect every (line_idx, item) across the Skills section.
    parsed: list[tuple[int, list[str]]] = []
    multiword_last_words: set[str] = set()
    for i in range(skills_start + 1, skills_end):
        m = _SKILLS_LINE_RE.match(lines[i])
        if not m:
            continue
        items = [p.strip() for p in m.group(2).split(",") if p.strip()]
        parsed.append((i, items))
        for it in items:
            words = it.lower().split()
            if len(words) > 1:
                multiword_last_words.add(words[-1])

    if not multiword_last_words:
        return markdown

    dropped = 0
    for idx, items in parsed:
        kept: list[str] = []
        for it in items:
            words = it.lower().split()
            if len(words) == 1 and words[0] in multiword_last_words:
                dropped += 1
                continue
            kept.append(it)
        m = _SKILLS_LINE_RE.match(lines[idx])
        if m and kept:
            lines[idx] = m.group(1) + ", ".join(kept)

    if dropped:
        logger.info("w8 skills hygiene: dropped %d generic skill(s) subsumed by a specific entry", dropped)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Phase 2 Sprint B — deterministic Experience-section normaliser.
#
# Two modules combined: chronological sort + verb tense normalisation. Run
# AFTER restore_and_order (which orders SECTIONS but not entries within a
# section) and AFTER the awards-split pass.
#
# Why deterministic? The LLM gets these right ~70% of the time but flips
# tense on one bullet in three (the "Transported" regression in the
# Anglicare run is the canonical example), and orders entries by an unclear
# heuristic ("most recently mentioned" vs "most recent start date" vs
# "longest tenure"). Sorting and tense matching are pure functions; no
# reason to leave them to the LLM.
# ---------------------------------------------------------------------------

# Month name → number. Includes the abbreviations the writer prompt uses
# (Sept rather than Sep, June rather than Jun) and their full names.
_MONTH_TO_NUM: Dict[str, int] = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

# Past tense → infinitive/present (3rd-person-singular dropped — bullets are
# usually subjectless, so "Serve" is the bare form). The map is bidirectional
# in spirit: present→past is computed by inverting at module load.
#
# Curated for nursing / clinical / generic CV verbs. Easy to extend per
# vertical. Excludes verbs with irregular present-tense forms that would
# read awkwardly without a subject (e.g. "writes" → "Write" is OK; "wrote"
# stays "Wrote" already).
_PAST_TO_PRESENT_VERBS: Dict[str, str] = {
    "served":         "Serve",
    "delivered":      "Deliver",
    "provided":       "Provide",
    "monitored":      "Monitor",
    "maintained":     "Maintain",
    "collaborated":   "Collaborate",
    "managed":        "Manage",
    "ensured":        "Ensure",
    "supported":      "Support",
    "executed":       "Execute",
    "transported":    "Transport",
    "coordinated":    "Coordinate",
    "assisted":       "Assist",
    "supervised":     "Supervise",
    "documented":     "Document",
    "responded":      "Respond",
    "handled":        "Handle",
    "engaged":        "Engage",
    "promoted":       "Promote",
    "trained":        "Train",
    "liaised":        "Liaise",
    "communicated":   "Communicate",
    "led":            "Lead",
    "developed":      "Develop",
    "implemented":    "Implement",
    "improved":       "Improve",
    "analysed":       "Analyse",
    "analyzed":       "Analyse",
    "reviewed":       "Review",
    "prepared":       "Prepare",
    "tracked":        "Track",
    "reported":       "Report",
    "updated":        "Update",
    "coached":        "Coach",
    "mentored":       "Mentor",
    "educated":       "Educate",
    "partnered":      "Partner",
    "resolved":       "Resolve",
    "escalated":      "Escalate",
    "built":          "Build",
    "designed":       "Design",
    "created":        "Create",
    "identified":     "Identify",
    "conducted":      "Conduct",
    "fostered":       "Foster",
    "facilitated":    "Facilitate",
    "advised":        "Advise",
    "consulted":      "Consult",
    "audited":        "Audit",
    "evaluated":      "Evaluate",
    "investigated":   "Investigate",
    "performed":      "Perform",
    "researched":     "Research",
    "drafted":        "Draft",
    "presented":      "Present",
    "led":            "Lead",
    "guided":         "Guide",
    "led":            "Lead",
    "championed":     "Champion",
    "completed":      "Complete",
    "achieved":       "Achieve",
    "drove":          "Drive",
    "wrote":          "Write",
    "produced":       "Produce",
    "applied":        "Apply",
    "deployed":       "Deploy",
    "negotiated":     "Negotiate",
}
# Invert for present → past lookup. The capitalised past tense is what gets
# emitted at bullet start, so we store the inflected form.
_PRESENT_TO_PAST_VERBS: Dict[str, str] = {
    present.lower(): past.capitalize() for past, present in _PAST_TO_PRESENT_VERBS.items()
}

_DATE_TOKEN_RE = re.compile(
    r"\b([A-Za-z]{3,9})\s+(?:\d{1,2}\s*,?\s*)?(\d{4})\b"
)
_DATE_RANGE_RE = re.compile(
    r"([A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})"
    r"\s*(?:[-–—]|to)\s*"
    r"(Present|present|current|now|ongoing|[A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})",
)


def _parse_month_year(s: str) -> Optional[tuple[int, int]]:
    """Parse 'Mar 2026' / 'Sept 2024' / 'Sept 20, 2024' / 'May 2025' to
    (year, month). Returns None on unparseable input."""
    m = _DATE_TOKEN_RE.search(s.strip())
    if not m:
        return None
    month_name = m.group(1).lower()
    year = int(m.group(2))
    month = _MONTH_TO_NUM.get(month_name)
    return (year, month) if month else None


def _parse_role_date_range(role_line: str) -> Optional[tuple[tuple[int, int], object]]:
    """Extract (start, end) from a role/date line like
    '*Care Worker (Casual) | Mar 2026 – Present*'.

    Returns ((start_year, start_month), end) where end is either the literal
    string "present" or a (year, month) tuple. Returns None if no range
    found. A single date (placement) → start == end.
    """
    m = _DATE_RANGE_RE.search(role_line)
    if m:
        start = _parse_month_year(m.group(1))
        end_raw = m.group(2).strip().lower()
        if not start:
            return None
        if end_raw in ("present", "current", "now", "ongoing"):
            return (start, "present")
        end = _parse_month_year(end_raw)
        return (start, end) if end else None
    # Single date (placement) — treat as a fixed point in time.
    d = _parse_month_year(role_line)
    if d:
        return (d, d)
    return None


def _is_present_role(date_range: Optional[tuple]) -> bool:
    """True when the role end is 'present'."""
    if not date_range:
        return False
    _, end = date_range
    return end == "present"


_EXPERIENCE_HEADING_RE = re.compile(r"^##\s+(Experience|Work Experience|Professional Experience)\s*$", re.IGNORECASE)


def _find_experience_section(lines: list[str]) -> Optional[tuple[int, int]]:
    """Return (heading_index, body_end_index_exclusive). None if no Experience section."""
    start = None
    for i, ln in enumerate(lines):
        if _EXPERIENCE_HEADING_RE.match(ln):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return (start, end)


def _split_into_entries(body_lines: list[str]) -> list[list[str]]:
    """Split an Experience section's body into per-entry blocks.

    An entry starts at an H3 heading (`### `) and runs until the next H3.
    Lines before the first H3 (orphans) are returned as a leading 'pre'
    block — preserved as-is by callers.
    """
    entries: list[list[str]] = []
    indices = [i for i, ln in enumerate(body_lines) if ln.startswith("### ")]
    if not indices:
        return [body_lines]  # no H3 — return whole thing as one block
    if indices[0] > 0:
        entries.append(body_lines[:indices[0]])
    for k, start in enumerate(indices):
        end = indices[k + 1] if k + 1 < len(indices) else len(body_lines)
        entries.append(body_lines[start:end])
    return entries


def _find_role_line(entry_block: list[str]) -> tuple[int, Optional[tuple]]:
    """Return (index_of_role_line, parsed_date_range) for an entry. The role
    line is the italic line `*Role | Dates*` that follows the H3 employer line.
    Returns (-1, None) if no parseable date line found."""
    for idx, ln in enumerate(entry_block):
        if ln.strip().startswith("*") and ln.strip().endswith("*"):
            parsed = _parse_role_date_range(ln)
            if parsed:
                return (idx, parsed)
        # Fall back: any line with a date range pattern.
        if _DATE_RANGE_RE.search(ln) or _DATE_TOKEN_RE.search(ln):
            parsed = _parse_role_date_range(ln)
            if parsed:
                return (idx, parsed)
    return (-1, None)


def sort_experience_chronologically(markdown: str) -> str:
    """Sort Experience entries reverse-chronological:
      1. Present (ongoing) roles by start_date DESC
      2. Then ended roles by end_date DESC, start_date DESC
    Entries with unparseable dates sort to the end, preserving relative order.

    Idempotent — running twice produces identical output.
    """
    lines = markdown.split("\n")
    exp = _find_experience_section(lines)
    if not exp:
        return markdown
    start, end = exp
    body = lines[start + 1:end]
    entry_blocks = _split_into_entries(body)
    if len(entry_blocks) <= 1:
        return markdown

    # The first block may be a 'pre' block (lines before any H3). Keep it pinned at top.
    pre_block: list[str] = []
    if entry_blocks and not entry_blocks[0] or (entry_blocks[0] and not entry_blocks[0][0].startswith("### ")):
        pre_block = entry_blocks[0]
        entry_blocks = entry_blocks[1:]
    if not entry_blocks:
        return markdown

    # Parse date range for each entry.
    parsed: list[tuple[Optional[tuple], list[str], int]] = []
    for idx, block in enumerate(entry_blocks):
        _, dr = _find_role_line(block)
        parsed.append((dr, block, idx))

    def sort_key(item: tuple[Optional[tuple], list[str], int]) -> tuple:
        dr, _, original_idx = item
        if dr is None:
            return (3, original_idx, 0, 0)  # unparseable → end, stable order
        s, e = dr
        if e == "present":
            return (1, -s[0], -s[1], original_idx)  # ongoing, start desc
        # ended → end_date desc, then start desc
        return (2, -e[0], -e[1], -s[0], -s[1])

    parsed.sort(key=sort_key)
    # Idempotency: if sorting produced the SAME order as the input, return
    # markdown unchanged. Prevents the re-emit pass from drifting whitespace
    # on already-correctly-ordered Experience sections (most LLM output now
    # gets this right). The original_idx values are 0,1,2,... in input order;
    # check whether they remain monotone after sort.
    if all(parsed[i][2] == i for i in range(len(parsed))):
        return markdown

    # Re-emit. Trim trailing blank lines on each block, then join with one blank.
    sorted_blocks = [_strip_trailing_blank(b) for _, b, _ in parsed]
    new_body: list[str] = list(pre_block)
    for k, blk in enumerate(sorted_blocks):
        if k > 0 and new_body and new_body[-1].strip():
            new_body.append("")
        new_body.extend(blk)
    # Preserve one trailing blank line so the next section ("## Education")
    # stays separated by a blank line as it was in the input.
    if new_body and new_body[-1].strip():
        new_body.append("")

    out = lines[:start + 1] + new_body + lines[end:]
    return "\n".join(out)


def _strip_trailing_blank(block: list[str]) -> list[str]:
    out = list(block)
    while out and not out[-1].strip():
        out.pop()
    return out


_BULLET_FIRST_WORD_RE = re.compile(r"^(\s*[-*•]\s+)(\w+)(.*)$")


def _convert_bullet_tense(bullet: str, *, want_present: bool) -> str:
    """Convert the first word of a bullet to match the desired tense.
    Only touches the first word; preserves bullet marker, indentation,
    capitalisation rule (every bullet starts capitalised), and the rest.

    Returns the bullet unchanged when:
      • The line isn't a bullet
      • The first word isn't in the verb map
      • The first word is already in the correct tense
    """
    m = _BULLET_FIRST_WORD_RE.match(bullet)
    if not m:
        return bullet
    marker, first_word, rest = m.groups()
    fw_lower = first_word.lower()
    if want_present:
        replacement = _PAST_TO_PRESENT_VERBS.get(fw_lower)
        if replacement:
            return marker + replacement + rest
    else:
        replacement = _PRESENT_TO_PAST_VERBS.get(fw_lower)
        if replacement:
            return marker + replacement + rest
    return bullet


def normalise_experience_tense(markdown: str) -> str:
    """For each Experience entry, force the first verb of every bullet to
    match the role's date status:
      • End == "Present" → first verb in PRESENT tense (Serve, Provide, ...)
      • End is a past date → first verb in PAST tense (Served, Provided, ...)

    Verbs not in the table are left untouched. Idempotent.
    """
    lines = markdown.split("\n")
    exp = _find_experience_section(lines)
    if not exp:
        return markdown
    start, end = exp
    body = lines[start + 1:end]
    entry_blocks = _split_into_entries(body)
    if not entry_blocks:
        return markdown

    changes = 0
    new_body: list[str] = []
    for block in entry_blocks:
        if not block or not block[0].startswith("### "):
            new_body.extend(block)
            continue
        _, dr = _find_role_line(block)
        is_present = _is_present_role(dr)
        new_block: list[str] = []
        for ln in block:
            if ln.lstrip()[:2] in ("- ", "* ") or ln.lstrip()[:1] == "•":
                converted = _convert_bullet_tense(ln, want_present=is_present)
                if converted != ln:
                    changes += 1
                new_block.append(converted)
            else:
                new_block.append(ln)
        new_body.extend(new_block)

    if changes:
        logger.info("sprint-B tense normaliser: rewrote %d bullet verb(s)", changes)

    out = lines[:start + 1] + new_body + lines[end:]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Phase 2 Sprint C — body-text spelling + heading title-case + date format.
#
# Three small deterministic passes that clean LLM drift across the whole
# document (not just Skills, which existing _canonicalise_skill_spelling
# already covers).
#
# • Module 4: extend British/Australian spelling normalisation to body text
#             (Professional Summary, Experience bullets, Education, Awards
#             descriptions). Case-preserving — "Recognized" → "Recognised",
#             "individualized" → "individualised", "Recognise" → "Recognise".
# • Module 5: italic role/qualification lines title-cased properly. Short
#             prepositions/articles (in/of/to/for/and/or/the/a/an/by/with/
#             on/at/as) lowercase EXCEPT at sentence start; preserve ALL-CAPS
#             tokens (IV/NSW/CPR/RN/AHPRA/NDIS) and mixed-case brands.
# • Module 6: strip day-of-month from CV dates ("Sept 20, 2024" → "Sept 2024")
#             — standard CV convention.
# ---------------------------------------------------------------------------

# Module 4 — case-preserving British/Australian spelling map.
#
# Each pair is (american_pattern, british_canonical_lowercase). Replacement
# inflects to the matched input's case style (lowercase / Capitalised /
# ALL-CAPS) so we don't break "recognized for" mid-sentence into "Recognised
# for" (the existing _canonicalise_skill_spelling does that — it's fine for
# Skills line which is always capitalised, but wrong for body prose).
_BR_AM_BODY_SUBS: list[tuple[re.Pattern, str]] = [
    # -ize / -ized / -izing / -ization → -ise / -ised / -ising / -isation
    # Curated word list rather than blanket suffix so we don't break "size",
    # "prize", "seize", etc.
    (re.compile(r"\bspecializ(e[ds]?|ing|ation)\b", re.IGNORECASE), "specialis"),
    (re.compile(r"\borganiz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "organis"),
    (re.compile(r"\bindividualiz(e[ds]?|ing|ation)\b", re.IGNORECASE), "individualis"),
    (re.compile(r"\bpersonaliz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "personalis"),
    (re.compile(r"\boptimiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "optimis"),
    (re.compile(r"\brealiz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "realis"),
    (re.compile(r"\bcategoriz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "categoris"),
    (re.compile(r"\bprioritiz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "prioritis"),
    (re.compile(r"\bstandardiz(e[ds]?|ing|ation)\b", re.IGNORECASE),   "standardis"),
    (re.compile(r"\bmodernis(e[ds]?|ing|ation)\b", re.IGNORECASE),     "modernis"),
    (re.compile(r"\bemphasiz(e[ds]?|ing)\b", re.IGNORECASE),           "emphasis"),
    (re.compile(r"\bcustomiz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "customis"),
    (re.compile(r"\bauthoriz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "authoris"),
    (re.compile(r"\bsynthesiz(e[ds]?|ing|ation)\b", re.IGNORECASE),    "synthesis"),
    (re.compile(r"\butiliz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "utilis"),
    (re.compile(r"\bminimiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "minimis"),
    (re.compile(r"\bmaximiz(e[ds]?|ing|ation)\b", re.IGNORECASE),      "maximis"),
    (re.compile(r"\banalyz(e[ds]?|ing|ation)\b", re.IGNORECASE),       "analys"),
    (re.compile(r"\brecogniz(e[ds]?|ing|ation)\b", re.IGNORECASE),     "recognis"),
    # -or → -our (curated to avoid false hits on "actor", "doctor", "factor")
    (re.compile(r"\bcolor(s|ed|ing|ful)?\b", re.IGNORECASE),  "colour"),
    (re.compile(r"\bbehavior(s|al|ally)?\b", re.IGNORECASE),  "behaviour"),
    (re.compile(r"\bfavor(s|ed|ing|ite|able|ably)?\b", re.IGNORECASE), "favour"),
    (re.compile(r"\bhonor(s|ed|ing|able|ably)?\b", re.IGNORECASE),     "honour"),
    (re.compile(r"\blabor(s|ed|ing|ious)?\b", re.IGNORECASE),          "labour"),
    # -er → -re (curated)
    (re.compile(r"\bcenter(s|ed|ing)?\b", re.IGNORECASE),  "centre"),
    # Other common spelling pairs
    (re.compile(r"\benrol(l)(ed|ing|ment)\b", re.IGNORECASE),  "enrol"),  # double-l → single (UK)
    (re.compile(r"\bfulfil(l)(ed|ing|ment)\b", re.IGNORECASE), "fulfil"),
    (re.compile(r"\bskillful\b", re.IGNORECASE),               "skilful"),
    (re.compile(r"\benroll\b", re.IGNORECASE),                 "enrol"),
]


def _case_preserve_replace(match: "re.Match", british_lower: str) -> str:
    """Apply case style of the matched substring to the British canonical.
    Suffix-extending substitutions (-ize family) keep the matched suffix
    intact: 'Specialized' → 'Specialised' (match='Specialized', british_lower
    ='specialis', captured suffix='ed' → 'Specialised')."""
    matched = match.group(0)
    # For substitutions that capture a tail group (the -ize family), splice
    # the tail back in. Otherwise the british_lower is the full replacement.
    suffix = ""
    if match.groups():
        # Use group(1) verbatim if present (e.g. "ed", "ing", "ation").
        captured = match.group(1)
        if captured:
            suffix = captured.lower()
    full_lower = british_lower + suffix
    # Detect case style of the matched word.
    if matched.isupper():
        return full_lower.upper()
    if matched[0].isupper():
        return full_lower[0].upper() + full_lower[1:]
    return full_lower


def canonicalise_body_spelling(markdown: str) -> str:
    """Apply British/Australian spelling to body text, preserving each
    matched substring's case (lowercase / Capitalised / ALL-CAPS).

    Skips:
      • Fenced code blocks (` ``` … ``` `) — no relevant CV content but
        keeps the pass safe to run on any markdown.
      • Inline code spans (`` `…` ``)
      • The Registration & Licences section's middot-delimited line
        (Already canonical from stamp_credentials.)
    """
    if not markdown:
        return markdown

    lines = markdown.split("\n")
    in_code = False
    out: list[str] = []
    for ln in lines:
        stripped = ln.strip()
        # Fenced code block toggle.
        if stripped.startswith("```"):
            in_code = not in_code
            out.append(ln)
            continue
        if in_code:
            out.append(ln)
            continue
        # Replace OUTSIDE inline-code spans only. Cheap split-on-backtick.
        if "`" in ln:
            parts = ln.split("`")
            for i in range(0, len(parts), 2):  # even indices are non-code
                parts[i] = _apply_body_spelling_subs(parts[i])
            out.append("`".join(parts))
        else:
            out.append(_apply_body_spelling_subs(ln))
    return "\n".join(out)


def _apply_body_spelling_subs(text: str) -> str:
    """Run every body spelling substitution with case-preserving replacement."""
    if not text:
        return text
    for pat, british_lower in _BR_AM_BODY_SUBS:
        text = pat.sub(
            lambda m, _b=british_lower: _case_preserve_replace(m, _b),
            text,
        )
    return text


# ---------------------------------------------------------------------------
# Module 5 — heading title-case normaliser.
#
# Targets italic role / qualification lines and H3 headings. Stop-words that
# should be lowercase in non-leading position. Preserves ALL-CAPS tokens
# (IV, NSW, CPR, RN, AHPRA, NDIS, BSc) and known mixed-case brand names
# (BESTMed, MedMobile, eHealth, iPhone).
# ---------------------------------------------------------------------------

_TITLE_CASE_STOPWORDS: set[str] = {
    "in", "of", "to", "for", "and", "or", "the", "a", "an", "by", "with",
    "on", "at", "as", "but", "nor", "via",
}

# Tokens whose case must be preserved exactly (acronyms, brand names, roman
# numerals, qualifiers). Lowercased for lookup but emitted as the canonical
# stored form.
_PRESERVE_CASE_TOKENS: dict[str, str] = {
    "nsw": "NSW", "vic": "VIC", "qld": "QLD", "wa": "WA", "sa": "SA",
    "act": "ACT", "tas": "TAS", "nt": "NT",
    "iv": "IV", "iii": "III", "ii": "II", "vi": "VI", "vii": "VII", "viii": "VIII",
    "cpr": "CPR", "rn": "RN", "en": "EN", "ain": "AIN",
    "ahpra": "AHPRA", "ndis": "NDIS", "wwcc": "WWCC", "hltaid011": "HLTAID011",
    "uk": "UK", "usa": "USA", "us": "US", "eu": "EU", "uae": "UAE", "anz": "ANZ",
    "bsc": "BSc", "msc": "MSc", "ba": "BA", "ma": "MA", "phd": "PhD",
    "bestmed": "BESTMed", "medmobile": "MedMobile", "leecare": "Leecare",
    "ehealth": "eHealth", "iphone": "iPhone", "ipad": "iPad",
    "sql": "SQL", "aws": "AWS", "gcp": "GCP", "api": "API", "rest": "REST",
}

_TITLE_CASE_LINE_RE = re.compile(
    r"^(\s*\*)([^*]+)(\*\s*)$"  # *...* (italic block, allow trailing whitespace)
)
_H3_HEADING_RE = re.compile(r"^(###\s+)(.*?)(\s*)$")


def _title_case_token(token: str, *, is_first: bool, is_last: bool) -> str:
    """Title-case a single token with the stop-word and preserve-case rules.

    Hyphenated compounds ("Person-Centred", "Co-worker") are title-cased
    segment by segment.
    """
    if not token:
        return token
    # Preserve ALL-CAPS tokens (NSW, IV, CPR…) or known mixed-case brands.
    lower = token.lower()
    if lower in _PRESERVE_CASE_TOKENS:
        return _PRESERVE_CASE_TOKENS[lower]
    # If the token is already ALL-CAPS and contains digits/letters mix (e.g.
    # HLTAID011, ISO27001), preserve as-is.
    if token.isupper() and any(c.isalpha() for c in token):
        return token
    # Hyphenated compound: recurse on each segment.
    if "-" in token:
        segs = token.split("-")
        return "-".join(_title_case_token(s, is_first=False, is_last=False) for s in segs)
    # Stop-word in non-leading/non-trailing position → lowercase.
    if not is_first and not is_last and lower in _TITLE_CASE_STOPWORDS:
        return lower
    # Default: Capitalise first letter, preserve the rest (handles brand-
    # internal capitalisation if any sneaks through).
    return token[0].upper() + token[1:].lower() if len(token) > 1 else token.upper()


def _title_case_phrase(phrase: str) -> str:
    """Title-case a phrase like 'assistant in nursing' → 'Assistant in Nursing'.
    Splits on whitespace; punctuation (commas, parens, pipes) is preserved as
    boundaries."""
    if not phrase or not phrase.strip():
        return phrase

    # Tokenise: keep punctuation as separate tokens so they don't affect
    # is_first/is_last logic per "word".
    tokens = re.findall(r"[\w'-]+|[^\w\s]+|\s+", phrase)
    word_positions = [i for i, t in enumerate(tokens) if re.match(r"[\w'-]+", t)]
    if not word_positions:
        return phrase
    first_word = word_positions[0]
    last_word = word_positions[-1]

    out = []
    for i, t in enumerate(tokens):
        if re.match(r"[\w'-]+", t):
            is_first = (i == first_word)
            is_last = (i == last_word)
            out.append(_title_case_token(t, is_first=is_first, is_last=is_last))
        else:
            out.append(t)
    return "".join(out)


def normalise_heading_title_case(markdown: str) -> str:
    """Title-case italic role/qualification lines (`*…*`).

    Targets the lines we've seen LLM drift on:
      *Assistant In Nursing (Casual) | May 2025 – Present*
      *Bachelor Of Science | Sept 2019 – June 2022*
      *Certificate IV In Ageing Support | May 2025*

    H3 employer/institution lines are deliberately SKIPPED — they're
    proper-noun heavy ("Uniting – The Marion", "Jesmond Miranda Nursing
    Home", "Anglicare Mildred Symons House") where stop-word rules
    don't apply cleanly. Lowercasing "the" in "Uniting – The Marion"
    broke a brand-internal capitalisation (Sprint C hotfix learnt the
    hard way: title-case on H3s is collateral damage, not the target).
    """
    lines = markdown.split("\n")
    out: list[str] = []
    in_code = False
    changed = 0
    for ln in lines:
        if ln.lstrip().startswith("```"):
            in_code = not in_code
            out.append(ln)
            continue
        if in_code:
            out.append(ln)
            continue

        # Italic single-line `*…*` — the only target.
        m = _TITLE_CASE_LINE_RE.match(ln)
        if m:
            prefix, body, suffix = m.groups()
            new_body = _title_case_phrase(body)
            if new_body != body:
                changed += 1
            out.append(prefix + new_body + suffix)
            continue

        # H3 headings deliberately skipped — proper nouns, brand-internal
        # capitalisation must be preserved.
        out.append(ln)

    if changed:
        logger.info("sprint-C title-case: normalised %d italic line(s)", changed)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Module 6 — date format normaliser.
#
# Strip day-of-month from CV dates. "Sept 20, 2024" → "Sept 2024". The
# day-of-month is non-standard for CV resume dates and looks out of place
# next to month-only siblings.
# ---------------------------------------------------------------------------

_DATE_WITH_DAY_RE = re.compile(
    r"\b([A-Za-z]{3,9})\s+\d{1,2}\s*,\s*(\d{4})\b"
)


def normalise_date_formats(markdown: str) -> str:
    """Strip day-of-month from `Month DD, YYYY` patterns to `Month YYYY`.

    Conservative — only matches month names + 1-2 digit day + comma + 4-digit
    year. Doesn't touch single-month-name dates or month-year ranges.
    """
    if not markdown:
        return markdown
    # Replace only when the leading token is a recognised month abbreviation/name.
    def _sub(m: "re.Match") -> str:
        month = m.group(1)
        year = m.group(2)
        if month.lower() not in _MONTH_TO_NUM:
            return m.group(0)  # not a month name → leave alone
        return f"{month} {year}"
    return _DATE_WITH_DAY_RE.sub(_sub, markdown)


# ---------------------------------------------------------------------------
# End-of-tailoring report
# ---------------------------------------------------------------------------


def _log_tailoring_report(
    *,
    family_id: str,
    feasibility: Optional[Dict[str, Any]],
    matching: Optional[Dict[str, Any]],
    tailored_md: str,
) -> None:
    """One-line summary of where keywords ended up. Used for post-hoc debugging.

    Reports: role family / feasibility-bucket counts / # honest gaps /
    Skills-section length / first few honest gaps verbatim. The full landings
    can always be reconstructed by reading tailored_md; this exists so
    "why did keyword X go missing?" doesn't require grepping 10 per-pass logs.
    """
    plan = (feasibility or {}).get("feasibility_plan") or {}
    direct = len(plan.get("inject_directly") or [])
    ext    = len(plan.get("inject_as_extension") or [])
    inf    = len(plan.get("inject_with_inference") or [])
    gaps   = (feasibility or {}).get("summary", {}).get("honest_gaps") or []

    # Count keywords surfaced in the Skills section (rough: sum of comma-separated
    # entries across all category lines).
    skills_entries = 0
    in_skills = False
    for line in tailored_md.split("\n"):
        if line.strip() == "## Skills":
            in_skills = True
            continue
        if in_skills and line.startswith("## "):
            break
        if in_skills and "**" in line and ":" in line:
            after_colon = line.split(":", 1)[1]
            skills_entries += len([s for s in after_colon.split(",") if s.strip()])

    counts = (matching or {}).get("counts") or {}
    req = counts.get("required") or {}
    req_matched = sum(int((req.get(c) or {}).get("matched") or 0) for c in
                      ("technical", "soft_skills", "domain_knowledge"))
    req_total = sum(int((req.get(c) or {}).get("total") or 0) for c in
                    ("technical", "soft_skills", "domain_knowledge"))

    logger.info(
        "tailoring report: family=%s | req_matched=%d/%d | feasibility direct=%d ext=%d inf=%d gaps=%d | "
        "skills_entries=%d | first_gaps=%s",
        family_id, req_matched, req_total, direct, ext, inf, len(gaps),
        skills_entries, ", ".join(gaps[:5]) or "—",
    )


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
    # Workplace Health & Safety with/without the (WHS) suffix. WHS is a domain
    # category, not a discrete competency — the real skill is e.g. "Infection
    # Control", "Manual Handling".
    "workplace health and safety", "workplace health and safety (whs)",
    "work health and safety", "whs",
}
# Entries beginning with these are JD-phrasing fillers, not skills.
_NON_SKILL_PREFIXES: tuple[str, ...] = (
    "experience in", "experienced in", "experience as", "experience working",
    "knowledge of", "understanding of",
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

# Strips "August 2025." or "2025." from the START of a description string.
# The date already appears on the name line, so a leading repetition is noise.
_LEADING_DATE_RE = re.compile(
    r"^(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
    r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
    r"|Nov(?:ember)?|Dec(?:ember)?)\s+)?\d{4}[.\s,]+",
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


def _add_desc_sentence(desc: str, new_sent: str) -> str:
    """Append new_sent to desc only if it is not case-insensitively and
    character-wise (ignoring punctuation/spaces) already present as a
    sentence in desc.
    """
    new_sent = new_sent.strip()
    if not new_sent:
        return desc
    if not desc:
        return new_sent
    # Simple split by punctuation followed by space or end of string
    existing_sentences = [s.strip() for s in re.split(r'\s*\.\s*', desc) if s.strip()]
    norm_new = re.sub(r'[^a-zA-Z0-9]', '', new_sent).lower()
    for s in existing_sentences:
        norm_s = re.sub(r'[^a-zA-Z0-9]', '', s).lower()
        if norm_s == norm_new or norm_s.startswith(norm_new) or norm_new.startswith(norm_s):
            return desc
    return f"{desc.rstrip('.')}. {new_sent}"


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
        parsed_name, parsed_org = _split_award_name_org(left)
        if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
            description = _add_desc_sentence(description, parsed_org)
            name, org = _split_award_name_org(parsed_name)
        else:
            name = parsed_name
            org = parsed_org
    else:
        m = re.search(r"\(([^()]+)\)", content)
        if m:
            date = m.group(1).strip()
            before = content[:m.start()].strip()
            after = content[m.end():].strip().lstrip(",").strip()
            description = after
            parsed_name, parsed_org = _split_award_name_org(before)
            if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                description = _add_desc_sentence(description, parsed_org)
                name, org = _split_award_name_org(parsed_name)
            else:
                name = parsed_name
                org = parsed_org
        else:
            parsed_name, parsed_org = _split_award_name_org(content)
            if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                description = _add_desc_sentence(description, parsed_org)
                name, org = _split_award_name_org(parsed_name)
            else:
                name = parsed_name
                org = parsed_org
    return name.strip(), org.strip(), date.strip(), description.strip()


_AU_LOCATION_TAIL_RE = re.compile(
    # Strips ", [Suburb,] State[, Australia]" or ", Country" from the end of an
    # org name. The suburb part is optional and matched only when a state or
    # country follows, so it never strips a comma-suburb pattern that lacks the
    # state anchor (e.g. "Some Foundation, Inc." stays intact).
    r",\s*(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*)?"  # optional suburb name
    r"(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
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
    """Produce the canonical bullet-list entry for ## Awards.

    Output shape (name and organisation separated by a comma, rendered flat in
    both the web and PDF renderers):
      * Award Name, Organisation (Date)
        Description sentence.

    Trailing two spaces on the first line create a <br> in ReactMarkdown so
    the description appears on its own visual line inside the same list item.
    Falls back gracefully when any field is missing:
      - no org   →  '* Award Name (Date)'
      - no date  →  '* Award Name, Organisation'
      - no description → single-line bullet, no second line
    """
    org_clean = _strip_au_location(org) if org else ""

    # Strip trailing date from org when the same date will also be appended
    # in parentheses — fixes "Jesmond Miranda Nursing Home, August 2025
    # (August 2025)" duplicates that arise when the upstream parser leaves
    # the date in the org field AND also extracts it separately.
    if org_clean and date:
        # Match either a literal trailing copy of `date` or a generic
        # "Month YYYY"/"YYYY"/"YYYY-YYYY" tail (with optional preceding
        # comma/space). Anchor to end so we don't trim a date that happens
        # to also appear inside the org name.
        date_norm = re.escape(date.strip())
        org_clean = re.sub(
            r"\s*,?\s*" + date_norm + r"\s*$",
            "",
            org_clean,
            flags=re.IGNORECASE,
        ).rstrip(" ,")
        # Generic month-year tail (covers cases where org has "August 2025"
        # but date is normalised to "Aug 2025" or similar — still a duplicate
        # in spirit).
        org_clean = re.sub(
            r"\s*,?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
            r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
            r"Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\s*$",
            "",
            org_clean,
            flags=re.IGNORECASE,
        ).rstrip(" ,")

    first = name or "(unnamed award)"
    if org_clean:
        first = f"{first}, {org_clean}"
    if date:
        first = f"{first} ({date})"

    if description:
        desc = description.strip()
        # Strip any leading "Month YYYY. " or "YYYY. " that sometimes gets
        # prepended to descriptions (the date already appears on the name line).
        desc = _LEADING_DATE_RE.sub("", desc).strip()
        # Strip stray leading punctuation — e.g. ". Recognised for..." when
        # verify_claims appends description directly after a closing paren date.
        desc = desc.lstrip(".,;").strip()
        # Strip trailing " |" left over from old pipe-delimiter format conversion.
        desc = desc.rstrip("|").strip().rstrip(".")
        if desc:
            if desc.isupper():
                # ALL-CAPS noise → sentence-case it.
                desc = desc[0].upper() + desc[1:].lower() if len(desc) > 1 else desc.upper()
            else:
                # Preserve original casing — blanket .lower() destroyed proper
                # nouns and acronyms (NDIS, RN, place/person names). Just ensure
                # the first character is capitalised.
                desc = desc[0].upper() + desc[1:] if len(desc) > 1 else desc.upper()
            desc = _canonicalise_skill_spelling(desc)
            # Trailing "  " = hard line break (<br>) in ReactMarkdown so the
            # description appears on its own line within the same list item.
            lines = [f"* {first}  ", f"  {desc}."]
        else:
            lines = [f"* {first}"]
    else:
        lines = [f"* {first}"]

    return lines


# Keep the old name as an alias so any external callers are not broken.
def _format_award_bullet(name: str, org: str, date: str) -> str:
    return "\n".join(_format_award_entry(name, org, date))


# Words/phrases that mean a line is a DESCRIPTION (not an award name). Used
# to detect the "swapped" shape verify_claims sometimes produces, where the
# description gets promoted to ### and the name lands as plain text.
_DESCRIPTION_PREFIX_RE = re.compile(
    r"^(?:Recogni[sz]ed|Awarded|Received|Nominated|Presented|Given|Honou?red|For)\b",
    re.IGNORECASE,
)


def _classify_entry_line(line: str) -> tuple:
    """Classify a non-blank line inside ## Awards.

    Returns (kind, content) where kind ∈ {h3, italic, bullet, plain}.
    """
    s = line.strip()
    if s.startswith("### "):
        return "h3", s[4:].strip()
    if s.startswith("*") and s.endswith("*") and len(s) > 2:
        return "italic", s.strip("*").strip()
    if s.startswith(("- ", "* ")):
        return "bullet", s[2:].strip()
    return "plain", s


# Anchors for "this is a location, not an organisation". When a side of the
# pipe matches this, it should be discarded (or treated as location to strip)
# rather than promoted to the org field.
_LOCATION_ANCHOR_RE = re.compile(
    r"\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT"
    r"|New South Wales|Victoria|Queensland|Western Australia|South Australia"
    r"|Tasmania|Australian Capital Territory|Northern Territory|Australia)\b",
    re.IGNORECASE,
)


def _looks_like_location(text: str) -> bool:
    """True when text contains an Australian state/territory/country anchor —
    i.e. it's a location string and NOT an org name."""
    return bool(text and _LOCATION_ANCHOR_RE.search(text))


def _split_award_name_org(text: str) -> tuple:
    """Split 'Award – Org' (dash separator) or 'Award, Org' (comma, no trailing
    date) into (name, org). Returns (text, '') when no separator present.

    The AI commonly emits 'Staff Excellence Award – Jesmond Miranda Nursing
    Home' as a single h3/plain string; this helper extracts the org so the
    layout can put it in the right column instead of mashing it with the name.
    """
    for sep in (" – ", " — ", " - "):
        if sep in text:
            name, org = text.split(sep, 1)
            return name.strip(), org.strip()
    if "," in text and not _DATE_TAIL_RE.search(text):
        name, org = text.split(",", 1)
        return name.strip(), org.strip()
    return text.strip(), ""


def _parse_award_raw_entry(entry_lines: list) -> dict:
    """Parse one raw entry (a group of consecutive non-empty lines from inside
    ## Awards) into {name, org, date, description}.

    Handles every observed shape — bullet (pipe/paren/plain), h3+italic block,
    h3-only with trailing date, and the malformed "swapped" shape where the
    name is plain text and the description is promoted to ###.
    """
    name = org = date = description = ""

    for line in entry_lines:
        kind, content = _classify_entry_line(line)

        if kind == "h3":
            if not name:
                # First h3 = the award name (possibly with date / org / location).
                if "|" in content:
                    left, right = content.split("|", 1)
                    candidate_right = right.strip()
                    # Always try to split left into name+org first — AI emits
                    # 'Award – Org | …' as the dominant shape.
                    parsed_name, parsed_org = _split_award_name_org(left.strip())
                    if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                        description = _add_desc_sentence(description, parsed_org)
                        name, org = _split_award_name_org(parsed_name)
                    else:
                        name = parsed_name
                        if parsed_org and not org:
                            org = parsed_org
                    # Now classify the right side.
                    if _is_valid_date(candidate_right):
                        date = candidate_right
                    elif _looks_like_location(candidate_right) and org:
                        # Org already came from dash split → right is pure
                        # location residue, discard.
                        pass
                    elif not org:
                        # Right may be 'Org, Suburb, State, Country' — accept
                        # and let _format_award_entry strip the location tail.
                        org = candidate_right
                else:
                    parsed_name, parsed_org = _split_award_name_org(content)
                    if parsed_org:
                        if _DESCRIPTION_PREFIX_RE.match(parsed_org):
                            description = _add_desc_sentence(description, parsed_org)
                            name, org = _split_award_name_org(parsed_name)
                        else:
                            name = parsed_name
                            if not org:
                                org = parsed_org
                    else:
                        m_date = _DATE_TAIL_RE.search(content)
                        if m_date:
                            name = content[:m_date.start()].strip()
                            date = m_date.group(1).strip()
                        else:
                            name = content
            else:
                # Second h3 in same entry = description that was wrongly
                # promoted to a heading by verify_claims. Fold it back.
                m_date = _DATE_TAIL_RE.search(content)
                if m_date:
                    candidate_desc = content[:m_date.start()].strip().rstrip(",|").strip()
                    if not date:
                        date = m_date.group(1).strip()
                else:
                    candidate_desc = content
                description = _add_desc_sentence(description, candidate_desc)

        elif kind == "italic":
            if "|" in content:
                left, right = content.rsplit("|", 1)
                if _is_valid_date(right.strip()):
                    description = _add_desc_sentence(description, left.strip())
                    if not date:
                        date = right.strip()
                elif not org:
                    org = content
            elif _DESCRIPTION_PREFIX_RE.match(content):
                description = _add_desc_sentence(description, content)
            elif not org:
                org = content
            # else: org is already set. A second italic line here is almost
            # always a leftover location residue (e.g. '*Miranda*' after a
            # location strip) or a redundant org repeat — DISCARD it rather
            # than letting it bleed into the description field.

        elif kind == "bullet":
            # If we already have a name and the bullet starts with description
            # language (Recognised for/Awarded/etc.), treat it as a description
            # continuation instead of trying to parse name/org again.
            if name and _DESCRIPTION_PREFIX_RE.match(content):
                m_date = _DATE_TAIL_RE.search(content)
                if m_date:
                    desc_text = content[:m_date.start()].strip().rstrip(",|").strip()
                    if not date:
                        date = m_date.group(1).strip()
                else:
                    desc_text = content
                description = _add_desc_sentence(description, desc_text)
            else:
                n, o, d, desc = _parse_award_parts(content)
                if not name:        name = n
                if not org:         org = o
                if not date and _is_valid_date(d):
                    date = d
                if desc:
                    description = _add_desc_sentence(description, desc)

        else:  # plain
            m_date = _DATE_TAIL_RE.search(content)
            if not name:
                # First plain line — could be "Name – Org | Date" /
                # "Name – Org" / "Name | Date" / "Name | Org" / bare name.
                if "|" in content:
                    left, right = content.split("|", 1)
                    candidate_right = right.strip()
                    parsed_name, parsed_org = _split_award_name_org(left.strip())
                    if parsed_org and _DESCRIPTION_PREFIX_RE.match(parsed_org):
                        description = _add_desc_sentence(description, parsed_org)
                        name, org = _split_award_name_org(parsed_name)
                    else:
                        name = parsed_name
                        if parsed_org and not org:
                            org = parsed_org
                    if _is_valid_date(candidate_right):
                        date = candidate_right
                    elif _looks_like_location(candidate_right) and org:
                        # Org already came from dash split → right is just
                        # location residue, discard.
                        pass
                    elif not org:
                        # Let _format_award_entry strip any trailing location.
                        org = candidate_right
                else:
                    parsed_name, parsed_org = _split_award_name_org(content)
                    if parsed_org:
                        if _DESCRIPTION_PREFIX_RE.match(parsed_org):
                            description = _add_desc_sentence(description, parsed_org)
                            name, org = _split_award_name_org(parsed_name)
                        else:
                            name = parsed_name
                            if not org:
                                org = parsed_org
                    elif m_date:
                        name = content[:m_date.start()].strip()
                        date = m_date.group(1).strip()
                    else:
                        name = content
            elif _DESCRIPTION_PREFIX_RE.match(content):
                # Description-style language — never an org.
                if m_date and not date:
                    description = _add_desc_sentence(description, content[:m_date.start()].strip().rstrip(",|").strip())
                    date = m_date.group(1).strip()
                else:
                    description = _add_desc_sentence(description, content)
            elif not org:
                org = content
            else:
                if m_date and not date:
                    description = _add_desc_sentence(description, content[:m_date.start()].strip().rstrip(",|").strip())
                    date = m_date.group(1).strip()
                else:
                    description = _add_desc_sentence(description, content)

    return {
        "name": name.strip(),
        "org": org.strip(),
        "date": date.strip(),
        "description": description.strip(),
    }


def _is_description_only_entry(entry: dict) -> bool:
    """An entry is description-only when:
      - its name starts with description language (Recognised for / Awarded / …)
      - OR it has no name + no org but a description
    """
    n = entry.get("name", "")
    if n and _DESCRIPTION_PREFIX_RE.match(n):
        return True
    if not n and not entry.get("org") and entry.get("description"):
        return True
    return False


def _normalise_awards_entries(markdown: str) -> str:
    """Normalise every entry inside ## Awards to the simple bullet format:

      * Award Name - Organisation (Date)
        Description sentence.

    Robust to all observed production shapes (bullet, h3+italic, h3-only) AND
    to the "swapped" shape verify_claims sometimes produces (name as plain
    text, description promoted to ###). Idempotent — running twice on already-
    structured input is a no-op. No-op when ## Awards is absent.
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

    # Step 1: split section body into RAW ENTRIES. A new entry starts on a blank
    # line OR on a new bullet/h3 line — so adjacent award bullets with no blank
    # line between them (as verify_claims sometimes emits) are NOT merged into a
    # single entry (which silently dropped the second award). EXCEPTION: a
    # description-language line (Recognised for / Awarded / …) is a continuation
    # of the current award, not a new entry, even when the AI emits it as its own
    # bullet or promotes it to a `### ` heading (the "swapped" shape). Indented
    # continuation lines and `*italic*` lines never trigger a split (they lack the
    # trailing space the `* `/`- ` check needs).
    body = lines[start + 1:end]
    raw_entries: list[list[str]] = []
    current: list[str] = []
    for ln in body:
        stripped = ln.strip()
        if not stripped:
            if current:
                raw_entries.append(current)
                current = []
            continue
        starts_entry = stripped.startswith(("* ", "- ", "### "))
        if starts_entry:
            entry_content = stripped.lstrip("*-# ").strip()
            if _DESCRIPTION_PREFIX_RE.match(entry_content):
                starts_entry = False
        if starts_entry and current:
            raw_entries.append(current)
            current = []
        current.append(ln)
    if current:
        raw_entries.append(current)

    if not raw_entries:
        return markdown

    # Step 2: parse each raw entry into structured fields. Fail loud when a
    # non-empty raw entry yields no usable field — that's an unrecognised shape
    # the parser silently swallowed, not legitimately-empty content.
    parsed = [_parse_award_raw_entry(e) for e in raw_entries]
    for raw, entry in zip(raw_entries, parsed):
        if not (entry.get("name") or entry.get("org") or entry.get("description")):
            logger.warning("awards: unparsed entry shape: %r", raw)

    # Step 3: merge description-only entries back into the previous entry
    # (handles the swapped shape: name+org as plain, description as own ### block).
    merged: list[dict] = []
    for entry in parsed:
        if (merged and _is_description_only_entry(entry)
                and not merged[-1].get("description")):
            # Promote this entry's contents into the previous entry's description.
            prev = merged[-1]
            new_desc = entry.get("description") or entry.get("name")
            prev["description"] = new_desc
            if entry.get("date") and not prev.get("date"):
                prev["date"] = entry["date"]
        else:
            merged.append(entry)

    # Step 4: drop entries with no usable content; emit the structured shape.
    new_entries: list[str] = []
    for entry in merged:
        if not (entry.get("name") or entry.get("org") or entry.get("description")):
            continue
        for ln in _format_award_entry(
            entry["name"], entry["org"], entry["date"], entry["description"]
        ):
            new_entries.append(ln)

    if not new_entries:
        return markdown

    # Blank line between entries (keeps list items parseable as separate
    # entries on a re-run), trailing blank before the next section.
    spaced: list[str] = []
    for ln in new_entries:
        if ln.startswith("* ") and spaced:
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
# Sprint A — Awards / Certifications disambiguator (Phase 2 Module 7).
#
# The Phase-1 _relabel_awards_only_certifications only handles the pure case
# (every entry is an award → rename heading). It does NOT split a MIXED
# section. So when GPT-5.1 generates:
#
#   ## Certifications
#   First Aid Certification
#   Staff Excellence Award, Jesmond Miranda Nursing Home
#     Recognised for hard work, caring nature, and positive attitude.
#
# …the relabel pass sees the cert entry, refuses to rename, and the award
# entry ends up under the wrong heading. This is the Anglicare run bug.
#
# Sprint A: classify EACH entry, then SPLIT.
#   • Pure award (match _AWARD_RE, not _CERT_LIKE_RE) → ## Awards
#   • Credential ALREADY in Registration & Licences (literal substring) → drop
#     (duplicate; the canonical home is Registration)
#   • Industry cert (_CERT_LIKE_RE only, not already in Registration) → keep
#     under Certifications
#   • Section empty after split → drop heading entirely
#
# Result: Awards always shows when an award exists; Certifications only
# appears when there's a real industry-cert entry no other section covers.
# ---------------------------------------------------------------------------


def _entry_is_award(text: str) -> bool:
    """Award-shaped entry: matches award vocabulary AND not cert vocabulary."""
    return bool(_AWARD_RE.search(text)) and not bool(_CERT_LIKE_RE.search(text))


def _entry_is_cert(text: str) -> bool:
    """Credential-shaped entry (certificate/licence/first aid/cpr/etc.)."""
    return bool(_CERT_LIKE_RE.search(text))


def _registration_section_text(markdown: str) -> str:
    """Lowercased body text of ## Registration & Licences (and aliases),
    used to detect when a Certifications entry duplicates a credential
    already canonically listed in Registration. Returns "" when no such
    section exists."""
    aliases = {
        "registration & licences", "registration and licences",
        "registration", "registrations", "licences", "licenses",
        "licences and registrations", "credentials & checks",
    }
    lines = markdown.split("\n")
    out: list[str] = []
    collecting = False
    for ln in lines:
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            collecting = heading in aliases
            continue
        if collecting and ln.strip():
            out.append(ln.lower())
    return "\n".join(out)


def _credential_already_in_registration(entry: str, registration_blob: str) -> bool:
    """True if the credential phrase already appears in Registration & Licences.

    Conservative match: looks for the credential's canonical word stem
    (first aid / cpr / police check / driver licence / vaccination /
    medication competency / wwcc) in the registration blob. Exact-phrase
    matching would miss synonyms ("First Aid Certification" vs
    "First Aid (HLTAID011)")."""
    if not registration_blob:
        return False
    t = entry.lower()
    # Canonical credential anchors — if entry contains one AND registration
    # also contains it, treat as duplicate. Keeps the check tight (avoids
    # over-matching on generic words).
    anchors = (
        "first aid", "cpr", "police check", "working with children", "wwcc",
        "driver licence", "drivers license", "driver license", "drivers licence",
        "medication competency", "ndis worker", "covid", "influenza",
        "vaccination", "police clearance", "work rights",
    )
    for anchor in anchors:
        if anchor in t and anchor in registration_blob:
            return True
    return False


def split_awards_and_certifications(markdown: str) -> str:
    """Sprint A core pass: classify each entry under a Certifications/Recognition/
    Achievements/Honours heading, then split into clean ## Awards + ## Certifications
    sections (dropping credential entries already covered by Registration).

    Idempotent — running twice produces identical output.

    Source section detection: any heading in _AWARDS_SOURCE_HEADINGS. Multiple
    such sections are merged.

    Entry classification:
      • award-shaped → Awards bucket
      • cert-shaped AND duplicate of Registration entry → DROP
      • cert-shaped AND not in Registration → Certifications bucket (real industry cert)
      • ambiguous (neither matches) → Awards bucket (default — better to over-include awards
        than drop content; the Awards renderer is more permissive of free-form text)
    """
    lines = markdown.split("\n")
    # Find every candidate source section (Certifications, Recognition, etc.)
    # so we can merge multi-section content from chatty LLM output.
    section_ranges: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("## "):
            heading = ln[3:].strip().lower().rstrip(":")
            if heading in _AWARDS_SOURCE_HEADINGS:
                start = i
                j = i + 1
                while j < len(lines) and not lines[j].startswith("## "):
                    j += 1
                section_ranges.append((start, j, heading))
                i = j
                continue
        i += 1

    if not section_ranges:
        return markdown

    # Collect every entry across all source sections. Track which source
    # heading each entry came from so ambiguous (neither award nor cert
    # vocabulary) entries default sensibly: source "certifications" → keep
    # as cert; source "awards"/"recognition"/"honours" → award.
    raw_entries: list[tuple[str, str]] = []  # (entry_text, source_heading)
    for start, end, source_heading in section_ranges:
        block_lines = lines[start + 1:end]
        # Group lines into entries. A new entry starts on a non-indented,
        # non-bullet, non-blank line. Lines that are indented (2+ leading
        # spaces, a tab) OR start with a bullet marker (-, *, •) are
        # CONTINUATIONS of the previous entry. Blank lines also flush.
        current: list[str] = []

        def flush():
            if current:
                raw_entries.append(("\n".join(current).rstrip(), source_heading))

        for bl in block_lines:
            stripped = bl.strip()
            if not stripped:
                flush()
                current = []
                continue
            is_continuation = (
                bl[:1] in (" ", "\t")            # indented
                or stripped[:1] in ("-", "*", "•")  # bullet → could be either,
                # but bullet items lead a NEW entry only when current is empty
            )
            # Special-case: if the line starts with a bullet AND current is
            # empty, treat as a new entry (e.g. "- Award Name").
            if stripped[:1] in ("-", "*", "•") and not current:
                current.append(bl)
                continue
            if is_continuation and current:
                current.append(bl)
            else:
                flush()
                current = [bl]
        flush()

    if not raw_entries:
        # All source sections empty — just drop the headings.
        return _drop_sections_by_ranges(lines, section_ranges)

    registration_blob = _registration_section_text(markdown)

    awards_entries: list[str] = []
    cert_entries: list[str] = []
    dropped_dup: list[str] = []

    _CERT_SOURCE_HEADINGS = {
        "certifications", "certification", "certs", "cert",
        "credentials", "credential",
    }

    for entry, source_heading in raw_entries:
        flat = entry.replace("\n", " ")
        if _entry_is_award(flat):
            awards_entries.append(entry)
        elif _entry_is_cert(flat):
            if _credential_already_in_registration(flat, registration_blob):
                dropped_dup.append(flat[:80])
                continue
            cert_entries.append(entry)
        else:
            # Ambiguous — default to the source heading's category.
            # "## Certifications" + ambiguous entry → keep as cert (might be
            # an industry cert like "CKAD" the regex doesn't recognise).
            # "## Recognition" / "## Honours" + ambiguous → award.
            if source_heading in _CERT_SOURCE_HEADINGS:
                cert_entries.append(entry)
            else:
                awards_entries.append(entry)

    # Re-emit: drop all source-section blocks, then append new Awards + Certifications
    # at the position of the FIRST source section (preserves rough layout). The
    # downstream _reorder_sections pass repositions to canonical order anyway.
    insertion_point = section_ranges[0][0]
    out_lines = _drop_sections_by_ranges(lines, section_ranges)
    new_blocks: list[str] = []
    if awards_entries:
        new_blocks.append("## Awards\n\n" + "\n\n".join(awards_entries).rstrip())
    if cert_entries:
        new_blocks.append("## Certifications\n\n" + "\n\n".join(cert_entries).rstrip())

    if not new_blocks:
        # Everything was deduplicated — log and return without source sections.
        if dropped_dup:
            logger.info(
                "sprint-A awards-split: dropped %d credential duplicate(s) of Registration",
                len(dropped_dup),
            )
        return "\n".join(out_lines)

    # Find the insertion line in the reduced out_lines. We tracked the original
    # insertion_point but the array has been edited; find a stable anchor.
    # Simplest: append before the next non-source ## heading that follows the
    # original position; otherwise append at end.
    new_text = "\n\n".join(new_blocks)
    # Splice: walk the reduced output, find where we should insert (matching
    # the original first-source position by counting headings).
    result = "\n".join(out_lines).rstrip() + "\n\n" + new_text + "\n"

    if dropped_dup:
        logger.info(
            "sprint-A awards-split: split %d source section(s) → %d award + %d cert; dropped %d duplicate(s)",
            len(section_ranges), len(awards_entries), len(cert_entries), len(dropped_dup),
        )
    else:
        logger.info(
            "sprint-A awards-split: split %d source section(s) → %d award + %d cert",
            len(section_ranges), len(awards_entries), len(cert_entries),
        )
    return result


def _drop_sections_by_ranges(lines: list[str], ranges: list[tuple[int, int, str]]) -> list[str]:
    """Return `lines` with the (start, end) ranges removed. Ranges are
    sorted/de-overlapped before applying so multiple sections drop cleanly."""
    keep = [True] * len(lines)
    for start, end, _ in ranges:
        for k in range(start, min(end, len(lines))):
            keep[k] = False
    out = [ln for ln, k in zip(lines, keep) if k]
    # Collapse runs of >2 blank lines that the drop may have left.
    cleaned: list[str] = []
    blank_run = 0
    for ln in out:
        if not ln.strip():
            blank_run += 1
            if blank_run <= 2:
                cleaned.append(ln)
        else:
            blank_run = 0
            cleaned.append(ln)
    return cleaned


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
    # 3a-pre. CV-named brand tools the writer dropped (BESTMed, MedMobile,
    #     Leecare, ...). Independent of the JD — these are the candidate's
    #     differentiators and must never disappear, even when the writer
    #     prompt biases toward JD-required generics ("Basic Computer Skills").
    if role_family.injection_policy != "none":
        md = _surface_cv_named_tools(md, cv_text, role_family)
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
    # 3a-quinquies. Post-cap safety net for approved-but-missing skill keywords
    #     (e.g. "verbal communication" / "written communication") the cap
    #     dropped, then drop generics the specific entries now subsume.
    md = _inject_approved_skills(md, up["feasibility"])
    md = _drop_subsumed_generic_skills(md)
    md = _normalise_skills_case(md)
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
    #     This handles the PURE case (every entry is award-shaped). The MIXED
    #     case (award entry + cert entry under one heading) survives this pass.
    final_md = _relabel_awards_only_certifications(final_md)
    # 4c. Stamp user-supplied credentials into ## Registration & Licences
    #     (nursing/healthcare/care families only; no-op when role family is
    #     tech/manual/general or when the user has saved no credentials).
    #     Replaces any AI-emitted body in that section — the user's profile
    #     is authoritative for what they actually hold. Run BEFORE the
    #     awards-split pass so it can dedupe against Registration content.
    final_md = stamp_credentials(final_md, contact_details, role_family.id)
    # 4c-bis. Sprint A — split MIXED Certifications sections into clean Awards
    #     + Certifications, dropping cert entries already duplicated in
    #     Registration & Licences. Fixes the Anglicare run where "First Aid
    #     Certification" + "Staff Excellence Award" landed under one heading;
    #     the relabel pass at 4b refused to rename (mixed), so the award sat
    #     under the wrong heading and the cert duplicated Registration.
    final_md = split_awards_and_certifications(final_md)
    # 4d. Normalise every entry in ## Awards to a single clean bullet
    #     `- Name – Organisation (Date)` — collapses the two-line H3+italic
    #     block shape the writer sometimes emits, and strips trailing
    #     "Recognised for hard work…" descriptive text from verbose bullets.
    #     Run AFTER the awards-split so newly-created Awards sections get
    #     normalised too.
    final_md = _normalise_awards_entries(final_md)
    # 4e. Sprint B — sort Experience entries reverse-chronological. The LLM
    #     gets this right ~70% of the time; locking it down deterministically
    #     ensures Uniting (Mar 2026) → Jesmond (May 2025) → Anglicare (Sept
    #     2024) regardless of the model. Ongoing roles first, then ended.
    final_md = sort_experience_chronologically(final_md)
    # 4f. Sprint B — normalise verb tense on Experience bullets. For "Present"
    #     roles every first verb is present-tense (Serve / Deliver / Provide);
    #     for ended roles past-tense (Served / Delivered / Provided). Fixes
    #     the "Transported residents…" regression where one bullet drifted
    #     past-tense even though the role is still active.
    final_md = normalise_experience_tense(final_md)
    # 4g. Sprint C — apply British/Australian spelling to body text
    #     (Summary, Experience bullets, Education, Awards). Case-preserving,
    #     so "Recognized" → "Recognised" and "individualized" → "individualised"
    #     in mid-sentence positions. Existing _canonicalise_skill_spelling on
    #     Skills entries is unchanged; this pass picks up everything else.
    final_md = canonicalise_body_spelling(final_md)
    # 4h. Sprint C — title-case italic role/qualification lines and H3
    #     headings. "Assistant In Nursing" → "Assistant in Nursing"; preserves
    #     ALL-CAPS tokens (IV, NSW, CPR) and mixed-case brands (BESTMed).
    final_md = normalise_heading_title_case(final_md)
    # 4i. Sprint C — strip day-of-month from CV dates. "Sept 20, 2024" →
    #     "Sept 2024". Standard CV convention.
    final_md = normalise_date_formats(final_md)

    # W8.2 — knockout pass (deterministic, no AI). Honest hard-requirement report
    # (mandatory licence / minimum years / work rights) that a CV edit can't fix.
    knockouts = detect_knockouts(jd_text, up["jd_analysis"], cv_text)

    # End-of-tailoring report — one log line summarising where every JD keyword
    # landed. Makes "why did keyword X go missing?" debuggable without grepping
    # 10 per-pass logs. Deliberately concise: family / counts / first few honest
    # gaps. Full landings are deducible from the tailored_md when needed.
    _log_tailoring_report(
        family_id=role_family.id,
        feasibility=up["feasibility"],
        matching=up["matching"],
        tailored_md=final_md,
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
    # Summary title slot — strip a conjoined synonymous role from S1
    # ("Assistant in Nursing and Care Worker" → "Assistant in Nursing").
    # Only fires when both titles belong to the same curated synonym cluster.
    verified_md = enforce_summary_title_dedup(verified_md)
    # Summary breadth/single-employer consistency — when S1 frames breadth
    # ("multiple settings"), strip a cherry-picked single employer from S2.
    verified_md = enforce_summary_breadth_consistency(verified_md)
    # Summary S1↔S2 de-duplication — drop any S2 clause that merely restates S1
    # (a near-repeat that just re-lists the Skills section as prose).
    verified_md = enforce_summary_dedup(verified_md)
    # Summary-vs-Skills de-duplication — drop any S2 clause where every content
    # word already appears in the ## Skills section (the clause is prose-form
    # skill re-list). Always keeps at least one S2 clause.
    verified_md = enforce_summary_skills_dedup(verified_md)
    # Re-run the awards/section normalisers — verify_claims is an AI step that
    # can rewrite the Awards/Certifications section into a messy shape (e.g.
    # description promoted to ###). These deterministic passes are idempotent
    # and ensure the structured Awards layout reaches the renderer.
    verified_md = _relabel_awards_only_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    # Re-run skills hygiene — verify_claims can rewrite the Skills section:
    # merging all three categories back onto one line (so the PDF renders them
    # as a single paragraph), adding junk entries like "Person-Centred Care
    # Principles" or care-setting descriptors, and breaking case consistency.
    # These passes are idempotent; the cost is negligible.
    verified_md = enforce_skills_section(verified_md)
    verified_md = _strip_non_skill_phrases(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # Post-cap safety net: re-inject any approved keyword the cap dropped, then
    # drop generics the now-present specific entries subsume. Final word on
    # Skills so approved soft skills (verbal/written communication) actually land.
    verified_md = _inject_approved_skills(verified_md, result.feasibility)
    verified_md = _drop_subsumed_generic_skills(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
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
    # Summary consistency parity with w8_verified: title-slot synonym trim, then
    # align S1/S2 (breadth), then drop any S2 clause that merely restates S1
    # or merely re-lists the Skills section as prose.
    verified_md = enforce_summary_title_dedup(verified_md)
    verified_md = enforce_summary_breadth_consistency(verified_md)
    verified_md = enforce_summary_dedup(verified_md)
    verified_md = enforce_summary_skills_dedup(verified_md)
    # Re-run the awards/section normalisers — verify_claims can rewrite the
    # Awards/Certifications section back to a messy shape; these deterministic
    # idempotent passes guarantee the structured Awards layout survives.
    verified_md = _relabel_awards_only_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    # Re-run skills hygiene — verify_claims can rewrite the Skills section:
    # merging all three categories back onto one line (so the PDF renders them
    # as a single paragraph), adding junk entries like "Person-Centred Care
    # Principles" or care-setting descriptors, and breaking case consistency.
    # These passes are idempotent; the cost is negligible.
    verified_md = enforce_skills_section(verified_md)
    verified_md = _strip_non_skill_phrases(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # Post-cap safety net: re-inject any approved keyword the cap dropped, then
    # drop generics the now-present specific entries subsume. Final word on
    # Skills so approved soft skills (verbal/written communication) actually land.
    verified_md = _inject_approved_skills(verified_md, result.feasibility)
    verified_md = _drop_subsumed_generic_skills(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
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
