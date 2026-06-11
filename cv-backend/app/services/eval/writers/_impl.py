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
from app.services.eval.enforce import enforce_skills_section, DEFAULT_SKILL_CAPS, reroute_skills_by_lexicon, _ROLE_CATEGORY_LABELS
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
    category_labels,
)
from app.services.cv.contact_line import stamp_contact_line, stamp_credentials, stamp_references
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
    build_family_label_map,    # convert RoleFamilyProfile → bold label map for injector
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
    role_family_id: Optional[str] = None,
) -> str:
    """Apply the production deterministic post-processors. Same for every variant."""
    enforced = _enforce_structure(markdown.strip())
    with_skills = _inject_missing_skills(enforced, feasibility)
    return stamp_contact_line(with_skills, contact_details, role_family_id=role_family_id)


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
    role_family_id = up["jd_analysis"].get("role_family")
    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family_id)
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
    role_family_id = up["jd_analysis"].get("role_family")
    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family_id)
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
    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family.id)
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

    # Bug fix (Sprint G+): scope the "already present" check to the SKILLS
    # SECTION only. Previous behaviour scanned the whole markdown — so when
    # BESTMed/MedMobile appeared in Summary / Experience bullets but were
    # absent from the Skills section, the surfacer thought they were "found"
    # and skipped. The candidate's named tools belong on the Skills line
    # regardless of being mentioned in body prose.
    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    missing: list[str] = []
    for pattern, canonical in _KNOWN_CV_TOOLS:
        if re.search(pattern, original_cv_text, flags=re.IGNORECASE):
            # Must appear in the SKILLS SECTION, not just anywhere.
            if canonical.lower() not in skills_text_lower:
                missing.append(canonical)

    if not missing:
        return markdown

    # Pick the target category: for tech roles 'technical' maps to the
    # 'Technical Skills' line (headline). For nursing/manual the LLM emits
    # 'Care Skills' / 'Core Skills' (NOT in _SKILLS_CATEGORY_LABEL); the
    # canonical mapping has 'domain_knowledge' → 'Other Skills' which is
    # where tools land in nursing/manual. So:
    #   • tech: target = 'technical' (Technical Skills line)
    #   • nursing/manual: target = 'domain_knowledge' (Other Skills line)
    target_cat = "technical" if role_family.headline_bucket == "technical" else "domain_knowledge"

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


# Skills entries whose category placement is obvious — anything matching
# these patterns belongs in the TECHNICAL bucket (= Other Skills for
# nursing/manual, = Technical Skills for tech), never Soft or Care Skills.
# The LLM occasionally misfiles these (post-Sprint-G Anglicare run put
# 'Basic Smartphone Skills' under Soft Skills). This pass moves them.
_TECHNICAL_SKILL_PATTERNS = re.compile(
    r"\b("
    r"computer|smartphone|tablet|mobile\s+app|mobile\s+apps|software|hardware"
    r"|laptop|desktop|operating\s+system|database|spreadsheet"
    r"|bestmed|medmobile|leecare|manad|epas|epic|cerner"
    r")\b",
    re.IGNORECASE,
)


def _move_misplaced_technical_skills(markdown: str, role_family) -> str:
    """Move obviously-technical Skills entries (computer / smartphone / app /
    named brand tools) from Soft Skills or Care Skills to the technical-bucket
    line (Other Skills for nursing/manual; Technical Skills for tech).

    Honest by construction: only moves entries that match a hardcoded
    technical-vocabulary pattern. Idempotent — re-running produces same
    output. No-op when no misplaced entries are detected.
    """
    if not markdown:
        return markdown
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

    # Find the target line (where tools belong) via the canonical label map.
    # For nursing, the Care Skills line label is NOT in _SKILLS_CATEGORY_LABEL
    # (it's family-specific), so we can't depend on cat_to_line_idx covering
    # all Skills lines. Locate target via the canonical label, then enumerate
    # ALL other Skills lines as candidates regardless of label.
    target_cat = "technical" if role_family.headline_bucket == "technical" else "domain_knowledge"
    target_label = _SKILLS_CATEGORY_LABEL.get(target_cat, "")
    target_idx = None
    for i in range(skills_start + 1, skills_end):
        if target_label and _line_starts_label(lines[i], target_label):
            target_idx = i
            break
    if target_idx is None:
        return markdown  # no target line to move into

    # Source lines: every Skills line EXCEPT the target. Detect Skills lines
    # by the **Label:** pattern so family-specific labels (Care Skills /
    # Clinical Skills / Core Skills) are included.
    source_indices: list[int] = []
    for i in range(skills_start + 1, skills_end):
        if i == target_idx:
            continue
        if _SKILLS_LINE_RE.match(lines[i]):
            source_indices.append(i)

    moved: list[str] = []
    for src_idx in source_indices:
        m = _SKILLS_LINE_RE.match(lines[src_idx])
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        parts = [p.strip() for p in body.split(",")]
        kept: list[str] = []
        for p in parts:
            if not p:
                continue
            if _TECHNICAL_SKILL_PATTERNS.search(p):
                # Move to target line; preserve canonical form.
                moved.append(p)
            else:
                kept.append(p)
        if moved and len(kept) != len(parts):
            # The body changed; re-emit the source line.
            if kept:
                lines[src_idx] = prefix + ", ".join(kept)
            else:
                # Don't leave an empty category line — mark it for later drop
                # by enforce_skills_section (which handles the empty-line drop).
                lines[src_idx] = prefix.rstrip() + " "  # blank body → cap pass will drop

    if not moved:
        return markdown

    # Append moved entries to target line (deduping against existing content).
    # Strip the '**Label:**' prefix before splitting so the first entry isn't
    # bundled into the label token.
    target_m = _SKILLS_LINE_RE.match(lines[target_idx])
    if target_m:
        target_body = target_m.group(2)
    else:
        target_body = lines[target_idx]
    existing = {p.strip().lower() for p in target_body.split(",") if p.strip()}
    additions = []
    for entry in moved:
        if entry.lower() not in existing:
            additions.append(entry)
            existing.add(entry.lower())
    if additions:
        lines[target_idx] = f"{lines[target_idx].rstrip()}, " + ", ".join(additions)
        logger.info("w8: moved %d misplaced technical skill(s) to %s line: %s",
                    len(additions), target_cat, additions)

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
            if key in _ROLE_CATEGORY_LABELS:
                continue  # Role-category label: inject into bullets/summary only, never Skills
            seen.add(key)
            out.append((kw, cat))
    return out


_INJECT_LINE_RE = re.compile(r"^(\s*(?:[-*•]\s+)?\*\*[^*]+:\*\*\s*)(.*)$")


def _norm_item(item: str) -> str:
    """Lower + collapse non-alphanumerics for cross-form comparison."""
    return re.sub(r"[^a-z0-9]+", " ", item.lower()).strip()


def _inject_approved_skills(markdown: str, feasibility: Optional[Dict[str, Any]]) -> str:
    """Cap-aware POST-CAP safety net for approved-but-missing skill keywords.

    Must run AFTER the final ``enforce_skills_section`` so the cap is already
    applied. This function RESPECTS the cap — it classifies existing items as
    approved-keep vs writer-only, places new approved keywords ahead of
    writer-only items, and truncates to ``DEFAULT_SKILL_CAPS`` (14/6/6
    position-based). Writer-only tail items are displaced when the line is
    full; approved-existing peers are preserved.

    Effect: approved soft skills the writer never surfaced (verbal/written
    communication, work planning) land in the Skills section even when the
    line is already at cap — without exceeding the cap, so no follow-up
    ``enforce_skills_section`` is needed (and would be harmful — it would
    truncate the just-placed approved items off the tail).
    """
    entries = _approved_skill_entries(feasibility)
    if not entries:
        return markdown

    # Full approved set (all three buckets) for "is this item approved?" checks.
    approved_set: set = {_norm_item(kw) for kw, _ in entries}
    by_cat: Dict[str, list] = {}
    for kw, cat in entries:
        by_cat.setdefault(cat, []).append(kw)

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

    # Map category → (line_idx, position) — position drives DEFAULT_SKILL_CAPS.
    # Also handle nursing headline labels (Care Skills / Clinical Skills / Core
    # Skills) which don't appear in _SKILLS_CATEGORY_LABEL.
    cat_to: Dict[str, tuple] = {}
    pos = 0
    for i in range(skills_start + 1, skills_end):
        stripped = _LEADING_BULLET_RE.sub("", lines[i].lstrip())
        if not stripped.startswith("**") or ":**" not in stripped:
            continue
        matched_cat = None
        for cat, label in _SKILLS_CATEGORY_LABEL.items():
            if _line_starts_label(lines[i], label):
                matched_cat = cat
                break
        if matched_cat is None and pos == 0 and "domain_knowledge" not in cat_to:
            # Nursing headline (Care Skills / Clinical Skills / Core Skills)
            matched_cat = "domain_knowledge"
        if matched_cat is not None and matched_cat not in cat_to:
            cat_to[matched_cat] = (i, pos)
        pos += 1

    skills_text_lower = "\n".join(lines[skills_start:skills_end]).lower()
    appended = 0
    displaced = 0

    for cat, target in cat_to.items():
        target_idx, target_pos = target
        line = lines[target_idx]
        m = _INJECT_LINE_RE.match(line)
        if not m:
            continue
        prefix, body = m.group(1), m.group(2)
        items = [it.strip() for it in body.split(",") if it.strip()]
        if not items:
            continue

        cap = (
            DEFAULT_SKILL_CAPS[target_pos]
            if target_pos < len(DEFAULT_SKILL_CAPS)
            else DEFAULT_SKILL_CAPS[-1]
        )

        # Split existing items: approved-keep vs writer-only.
        approved_existing: list = []
        writer_only: list = []
        seen_existing: set = set()
        for it in items:
            key = _norm_item(it)
            if key in seen_existing:
                continue
            seen_existing.add(key)
            if key in approved_set:
                approved_existing.append(it)
            else:
                writer_only.append(it)

        # Pending = approved for THIS category, not already present.
        pending: list = []
        for kw in by_cat.get(cat, []):
            if _is_non_skill_phrase(kw):
                continue
            if _kw_in_skills(kw, skills_text_lower):
                continue
            display = _format_skill_label(kw)
            if _norm_item(display) in seen_existing:
                continue
            seen_existing.add(_norm_item(display))
            pending.append(display)
            skills_text_lower += ", " + display.lower()

        if not pending and len(items) <= cap:
            continue

        # Final list = approved-keep + new approved + writer-only, truncated.
        merged = approved_existing + pending + writer_only
        before = len(items)
        truncated = merged[:cap]
        after = len(truncated)
        new_count = sum(1 for p in pending if p in truncated)
        appended += new_count
        if before > after:
            displaced += before - after

        lines[target_idx] = prefix + ", ".join(truncated)

    if appended or displaced:
        logger.info(
            "w8 approved-skill injector: added %d approved keyword(s), displaced %d writer-only",
            appended, displaced,
        )

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

# Experience-section processing (month/date parse, chronological sort, tense
# normalisation) was extracted to writers.experience. Re-imported so _impl's
# remaining code + the test-suite keep referencing these unqualified.
from app.services.eval.writers.experience import (  # noqa: E402
    _MONTH_TO_NUM, _PAST_TO_PRESENT_VERBS, _PRESENT_TO_PAST_VERBS, _DATE_TOKEN_RE,
    _DATE_RANGE_RE, _EXPERIENCE_HEADING_RE, _BULLET_FIRST_WORD_RE, _parse_month_year,
    _parse_role_date_range, _is_present_role, _find_experience_section,
    _split_into_entries, _find_role_line, sort_experience_chronologically,
    _strip_trailing_blank, _convert_bullet_tense, normalise_experience_tense,
)
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
# Body spelling + heading title-case were extracted to writers.spelling_case.
# Re-imported so _impl's remaining code + the test-suite keep referencing them
# unqualified.
from app.services.eval.writers.spelling_case import (  # noqa: E402,F401
    _BR_AM_BODY_SUBS, _case_preserve_replace, canonicalise_body_spelling, _apply_body_spelling_subs, _TITLE_CASE_STOPWORDS, _PRESERVE_CASE_TOKENS, _TITLE_CASE_LINE_RE, _H3_HEADING_RE, _title_case_token, _title_case_phrase, normalise_heading_title_case,
)
# Date-format normaliser lives with the other date logic in writers.experience
# (it uses _MONTH_TO_NUM, defined there). Re-imported for unqualified references.
from app.services.eval.writers.experience import (  # noqa: E402,F401
    _DATE_WITH_DAY_RE, normalise_date_formats,
)

# ---------------------------------------------------------------------------
# Phase 2 Sprint E — Professional Summary S2 enforcer.
#
# The Summary's second sentence (S2) is supposed to ground the candidate's
# capabilities in CONCRETE evidence — a named employer, a named tool, or a
# numeric metric. The writer prompt asks for this, but the LLM frequently
# emits generic filler:
#
#   "Provides safe, respectful support for older people in facility environments."
#   "Delivered safe medication assistance and comprehensive personal care to
#    elderly residents using electronic systems and behavioural management
#    techniques and during placement across these settings."
#
# Both score the same on ATS (no extra keywords) but waste the recruiter's
# 8-second skim window. Sprint E: when S2 contains NO concrete evidence
# (no employer name from Experience, no CV-named brand tool, no metric),
# REPLACE it with a deterministic employer/tool-naming sentence built from
# the original CV.
# ---------------------------------------------------------------------------

_SUMMARY_HEADINGS = ("professional summary", "summary", "profile", "career highlights")
_SENT_END_RE = re.compile(r"(?<=[.!?])\s+")
_METRIC_TOKEN_RE = re.compile(r"\b\d+(?:[\.,]\d+)?\s*(?:%|years|yrs|hours|hrs|residents|patients|beds|shifts|clients|sites|rooms)\b", re.IGNORECASE)


def _find_summary_section(lines: list[str]) -> Optional[tuple[int, int]]:
    """Return (heading_index, body_end_exclusive). None if no Summary section."""
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and ln[3:].strip().lower() in _SUMMARY_HEADINGS:
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if lines[j].startswith("## "):
                    end = j
                    break
            return (i, end)
    return None


def _extract_summary_prose(lines: list[str], start: int, end: int) -> tuple[str, list[int]]:
    """Return (full_prose_string, list_of_line_indices_that_contained_prose)."""
    prose_idx: list[int] = []
    for i in range(start + 1, end):
        s = lines[i].strip()
        if s and not s.startswith(("- ", "* ", "•")):
            prose_idx.append(i)
    if not prose_idx:
        return ("", [])
    text = " ".join(lines[i].strip() for i in prose_idx)
    return (text.strip(), prose_idx)


def _extract_present_employers_from_experience(cv_text: str) -> list[str]:
    """Pull employer/institution names from the CV's Experience section,
    prioritising ongoing ('Present') roles. Returns unique names in their
    original order.

    Scans for the pattern: an Experience-section H3 line followed by a date
    range ending in "Present". The employer is the leading segment of the
    H3 before " | " or comma. Falls back to all employers when no Present
    role is detected.
    """
    if not cv_text:
        return []
    lines = cv_text.split("\n")
    in_experience = False
    present: list[str] = []
    all_emps: list[str] = []
    seen_present: set[str] = set()
    seen_all: set[str] = set()

    # Walk: when we see an H3, capture the employer; look ahead a few lines
    # for a Present-tense date range; if found, mark as ongoing.
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("## "):
            heading = s[3:].strip().lower()
            in_experience = heading in (
                "experience", "work experience", "professional experience",
                "clinical experience",
            )
            continue
        if not in_experience:
            continue
        if s.startswith("### "):
            # Extract employer: split on " | " (the canonical H3 separator).
            # DON'T split on em-dash — "Uniting – The Marion" is a single
            # brand name with an internal em-dash that must be preserved.
            head = s[4:].strip()
            employer = head.split("|", 1)[0].split(",")[0].strip()
            if not employer or len(employer) < 4:
                continue
            # Look ahead up to 5 lines for a date range with "Present".
            is_present = False
            for j in range(i + 1, min(i + 6, len(lines))):
                if re.search(r"\b(?:Present|current|ongoing)\b", lines[j], re.IGNORECASE):
                    is_present = True
                    break
                if lines[j].strip().startswith(("### ", "## ")):
                    break
            if employer.lower() not in seen_all:
                seen_all.add(employer.lower())
                all_emps.append(employer)
            if is_present and employer.lower() not in seen_present:
                seen_present.add(employer.lower())
                present.append(employer)

    return present if present else all_emps


def _extract_cv_named_tools_for_summary(cv_text: str) -> list[str]:
    """Pull brand-name tools (BESTMed, MedMobile, ...) that appear in the
    original CV. Reuses _KNOWN_CV_TOOLS — same list the Skills surfacer uses."""
    if not cv_text:
        return []
    out: list[str] = []
    for pattern, canonical in _KNOWN_CV_TOOLS:
        if re.search(pattern, cv_text, re.IGNORECASE):
            if canonical not in out:
                out.append(canonical)
    return out


def _employer_block_text(cv_text: str, employer: str) -> str:
    """Extract the block of CV text scoped to one employer's Experience entry,
    i.e. from the H3 line naming the employer down to the next H3 or H2.

    Returns "" when the employer's section can't be located. Used to verify
    that a CV-named tool was ACTUALLY used at a specific employer before the
    S2 composer attributes it to them ("Currently delivering care at X using Y"
    is a FABRICATION when Y was used at a previous employer, not at X).
    """
    if not cv_text or not employer:
        return ""
    lines = cv_text.split("\n")
    # Distinctive employer tokens — match on the proper-noun parts only, so
    # the lookup survives the writer's heading rendering variations.
    emp_tokens = _distinctive_employer_tokens(employer)
    if not emp_tokens:
        # Fall back to whole-name substring if there's no distinctive token
        # (e.g. an org name made entirely of generic words). Conservative.
        emp_lower = employer.lower()
        for i, ln in enumerate(lines):
            if ln.strip().startswith("### ") and emp_lower in ln.lower():
                return _block_until_next_section(lines, i)
        return ""
    for i, ln in enumerate(lines):
        if not ln.strip().startswith("### "):
            continue
        head_lower = ln.lower()
        # H3 must contain at least one distinctive token of the employer.
        if any(re.search(r"\b" + re.escape(tok) + r"\b", head_lower)
               for tok in emp_tokens):
            return _block_until_next_section(lines, i)
    return ""


def _block_until_next_section(lines: list[str], start_idx: int) -> str:
    """Slice from `start_idx` until the next `###` or `##` heading."""
    out: list[str] = [lines[start_idx]]
    for ln in lines[start_idx + 1:]:
        s = ln.strip()
        if s.startswith("### ") or s.startswith("## "):
            break
        out.append(ln)
    return "\n".join(out)


def _tools_attributable_to_employer(
    cv_text: str, tailored_md: str, employer: str, all_tools: list[str],
) -> list[str]:
    """Return the subset of `all_tools` that appear inside `employer`'s block
    in either the original CV or the tailored markdown.

    Honest attribution: only name "X using TOOL" when the CV evidences that
    TOOL was used at X. If neither source has the tool in the employer's
    block, it stays OUT of the "using" clause (the tool may still be named
    elsewhere — Skills section, separate sentence — by other passes).
    """
    if not all_tools:
        return []
    md_block = _employer_block_text(tailored_md, employer)
    cv_block = _employer_block_text(cv_text, employer)
    if not md_block and not cv_block:
        return []
    blob = (md_block + "\n" + cv_block).lower()
    kept: list[str] = []
    for tool in all_tools:
        if re.search(r"\b" + re.escape(tool.lower()) + r"\b", blob):
            kept.append(tool)
    return kept


_EMPLOYER_GENERIC_TOKENS = {
    # Tokens that appear in many org names and therefore are NOT distinctive
    # enough on their own to mean "this employer is named". A standalone
    # 'Home' or 'Care' in S2 doesn't prove the employer is mentioned.
    "the", "and", "of", "for", "to", "at", "in", "on", "or",
    "care", "home", "house", "centre", "center", "facility", "facilities",
    "nursing", "aged", "village", "services", "service", "support",
    "hospital", "clinic", "community", "agency", "group", "company",
    "pty", "ltd", "inc", "limited", "co", "association",
}


def _distinctive_employer_tokens(employer: str) -> set[str]:
    """Return the distinctive (proper-noun) tokens of an employer name.

    'Uniting – The Marion' → {'uniting', 'marion'}
    'Jesmond Miranda Nursing Home' → {'jesmond', 'miranda'}
    'Anglicare Mildred Symons House' → {'anglicare', 'mildred', 'symons'}

    Generic CV-org words ('Nursing', 'Home', 'Care', 'Centre', 'The', ...)
    are filtered so they can't accidentally trigger a 'concrete' match.
    Tokens must be 4+ chars to ensure they're meaningful.
    """
    out: set[str] = set()
    for tok in re.split(r"[\s\-–—,/()]+", employer):
        tok = tok.strip().lower()
        if len(tok) < 4:
            continue
        if tok in _EMPLOYER_GENERIC_TOKENS:
            continue
        out.add(tok)
    return out


def _s2_has_concrete_evidence(s2: str, employer_names: list[str], cv_tools: list[str]) -> bool:
    """True if S2 contains an employer's DISTINCTIVE token or a numeric metric.

    NOTE: tool presence DOES NOT count as concrete evidence. The composition
    prompt explicitly forbids naming tools in S2 ("NO TOOL NAMES in S2 —
    tools live in the Skills section"). If the AI ignores that rule and
    emits a tool-named S2 like "...using BESTMed and MedMobile...", we
    treat it as NOT concrete so ``enforce_summary_concreteness`` rebuilds
    it via ``_compose_concrete_s2`` into a brief employer-anchored
    sentence. The cv_tools parameter is retained for signature stability
    (callers still pass it) but no longer counts toward concreteness.

    Partial matching (distinctive tokens) catches cases where the LLM cited
    only the brand suffix — e.g. 'The Marion' (fragment of 'Uniting – The
    Marion') correctly counts as employer-named via the 'marion' token.
    Exact-string substring matching would have missed this and replaced
    valid content with a template.
    """
    del cv_tools  # intentionally ignored; see docstring
    if not s2:
        return False
    low = s2.lower()
    for emp in employer_names:
        # Whole-name exact substring match (cheap, common case).
        if emp.lower() in low:
            return True
        # Distinctive-token match: at least one proper-noun token from the
        # employer name appears as a whole word in S2.
        for tok in _distinctive_employer_tokens(emp):
            if re.search(r"\b" + re.escape(tok) + r"\b", low):
                return True
    if _METRIC_TOKEN_RE.search(s2):
        return True
    return False


def _compose_concrete_s2(employer_names: list[str], cv_tools: list[str]) -> str:
    """Build a deterministic S2 from Present-employer names.

    Per the composition prompt's "NO TOOL NAMES in S2" rule, tools are
    deliberately NOT named here — naming BESTMed/MedMobile in S2 was the
    source of the universally-canned "Currently delivering care at X using
    BESTMed and MedMobile" sentence that read identical across many CVs.
    Tools live in the Skills section; this template anchors S2 on the
    employer only and stays brief.

    Templates:
      • 2+ employers → "Recent experience at [Emp1] and [Emp2]."
      • 1  employer  → "Recent experience at [Emp1]."
      • 0  employers → "" (caller leaves S2 untouched)

    The cv_tools parameter is kept for signature stability (callers pass
    attributable_tools); it is intentionally unused.
    """
    del cv_tools  # intentionally unused; see docstring
    if not employer_names:
        return ""
    emps = employer_names[:2]
    emp_clause = emps[0] if len(emps) == 1 else f"{emps[0]} and {emps[1]}"
    return f"Recent experience at {emp_clause}."


def enforce_summary_concreteness(markdown: str, original_cv_text: str) -> str:
    """Sprint E: replace a generic Professional Summary S2 with a deterministic
    employer/tool-naming sentence built from the original CV.

    'Generic' means S2 contains NO employer name from Experience, NO CV-named
    brand tool, AND NO numeric metric. When that's true, the S2 is wasted
    surface — the writer is filling space without selling. Replacing it is
    safe because:
      • S1 (the role-identity sentence) is preserved unchanged.
      • The replacement only names content the original CV literally evidences.
      • Idempotent: if S2 is already concrete, no change.

    No-op when:
      • No Summary section present.
      • Less than 2 sentences in the Summary.
      • S2 already has at least one concrete token.
      • No Present-role employers can be extracted from the CV.
    """
    if not markdown or not original_cv_text:
        return markdown
    lines = markdown.split("\n")
    bounds = _find_summary_section(lines)
    if not bounds:
        return markdown
    start, end = bounds
    prose, prose_idx = _extract_summary_prose(lines, start, end)
    if not prose:
        return markdown
    sentences = [s.strip() for s in _SENT_END_RE.split(prose) if s.strip()]
    if len(sentences) < 2:
        return markdown

    s1, s2 = sentences[0], sentences[1]
    rest = sentences[2:] if len(sentences) > 2 else []

    # Prefer the tailored markdown for employer extraction — it has the
    # canonical ## Experience / ### Employer structure that Sprint B
    # enforces, so parsing is reliable. Fall back to the raw cv_text if
    # the markdown for any reason yields nothing (defensive — should not
    # happen in production).
    employers = _extract_present_employers_from_experience(markdown)
    if not employers:
        employers = _extract_present_employers_from_experience(original_cv_text)
    # Tools: combine matches from BOTH the markdown and the original CV
    # text. Some brand mentions only survive in one source.
    tools_md = _extract_cv_named_tools_for_summary(markdown)
    tools_cv = _extract_cv_named_tools_for_summary(original_cv_text)
    # Preserve order, dedupe.
    seen: set[str] = set()
    tools: list[str] = []
    for t in tools_md + tools_cv:
        if t.lower() not in seen:
            seen.add(t.lower())
            tools.append(t)

    if _s2_has_concrete_evidence(s2, employers, tools):
        return markdown  # already concrete

    # Honest tool attribution — only attribute tools to an employer when the
    # CV actually evidences that connection. Without this guard, a candidate
    # whose tools were used at PreviousEmployer gets the fabricated S2
    # "Currently delivering care at CurrentEmployer using TOOL1 and TOOL2"
    # because the composer blindly conflates "most recent employer" with
    # "all CV tools". The reporting candidate (and recruiters who check)
    # will notice this immediately.
    attributable_tools: list[str] = []
    if employers and tools:
        attributable_tools = _tools_attributable_to_employer(
            original_cv_text, markdown, employers[0], tools,
        )
        # When there are 2 employers in the clause, include tools attributable
        # to EITHER (the AND clause covers both — keeps the OR semantically
        # correct).
        if len(employers) > 1:
            also = _tools_attributable_to_employer(
                original_cv_text, markdown, employers[1], tools,
            )
            for t in also:
                if t not in attributable_tools:
                    attributable_tools.append(t)

    new_s2 = _compose_concrete_s2(employers, attributable_tools)
    if not new_s2:
        return markdown  # no employers to name → leave S2 as is

    # Compose new prose: S1 + new_s2 + any trailing sentences (rare).
    new_prose = " ".join([s1, new_s2] + rest).strip()
    # Emit on the first prose line; blank the others to avoid leftovers.
    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose

    logger.info(
        "sprint-E summary S2 enforcer: replaced generic S2 with deterministic '%s'",
        new_s2,
    )
    return "\n".join(lines)


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

# Skills-section hygiene was extracted to writers.skills_section. Re-imported so
# _impl's remaining code + the test-suite (and the rescorer's import of
# _NON_SKILL_PATTERN/_EXACT/_PREFIXES) keep referencing them unqualified.
from app.services.eval.writers.skills_section import (  # noqa: E402,F401
    _NON_SKILL_EXACT, _NON_SKILL_PREFIXES, _NON_SKILL_PATTERN, _is_non_skill_phrase, _SKILLS_LINE_RE, _LEADING_SKILL_QUALIFIER_RE, _STRIPPABLE_SKILL_BASE_RE, _TRAILING_SKILLS_WORD_RE, _tidy_skill_qualifiers, _strip_non_skill_phrases, _KNOWN_ACRONYMS, _smartcase_atom, _smartcase_skill, _normalise_skills_case, _BR_AM_SKILL_SUBS, _canonicalise_skill_spelling, _dedupe_skills_across_lines,
)
# Awards/certification parsing helpers were extracted to writers.awards_parsing.
# Re-imported here so the rest of _impl + the test-suite keep referencing them
# unqualified (behaviour-preserving — same objects, new home).
from app.services.eval.writers.awards_parsing import (  # noqa: E402
    _AWARD_RE, _CERT_LIKE_RE, _AWARDS_SOURCE_HEADINGS, _DATE_TAIL_RE, _LEADING_DATE_RE,
    _AU_LOCATION_TAIL_RE, _AU_LOCATION_TAIL_NOCOMMA_RE, _DESCRIPTION_PREFIX_RE,
    _LOCATION_ANCHOR_RE, _is_valid_date, _add_desc_sentence, _parse_award_parts,
    _strip_duplicate_trailing_word, _strip_au_location, _format_award_entry,
    _format_award_bullet, _classify_entry_line, _looks_like_location,
    _split_award_name_org, _parse_award_raw_entry,
)
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

    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family.id)
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
    role_family_id = up["jd_analysis"].get("role_family")
    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family_id)
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
    final_md = _postprocess(raw, up["feasibility"], contact_details, role_family_id=role_family.id)
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


# Setting classification + summary bridges were extracted to writers.bridges.
# Re-imported so _impl's remaining code + the test-suite keep referencing them
# unqualified.
from app.services.eval.writers.bridges import (  # noqa: E402,F401
    _SETTING_HOME, _SETTING_HOSPITAL, _SETTING_NDIS, _SETTING_LIFESTYLE, _SETTING_THEATRE, _SETTING_RESIDENTIAL, _classify_jd_setting, _build_jd_setting_block, _CANNED_SUMMARY_RE, _HIGHLIGHT_HEADINGS_SET, _strip_canned_summary_phrase, _S1_RESIDENTIAL_RE, _SETTING_BRIDGES, _CV_HOSPITAL_MARKERS_RE, _scan_experience_section, _cv_has_hospital_experience, _CV_HOME_MARKERS_RE, _CV_NDIS_MARKERS_RE, _CV_LIFESTYLE_MARKERS_RE, _CV_THEATRE_MARKERS_RE, _cv_has_home_care_experience, _cv_has_ndis_experience, _cv_has_lifestyle_experience, _cv_has_theatre_experience, _BRIDGE_EVIDENCE_GATES, _apply_setting_bridge,
)
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

    # Deterministic JD setting classification — prepended to the user message so
    # it arrives before the CV text and cannot be overridden by the model's
    # residential-setting prior derived from the candidate's employer history.
    _setting       = _classify_jd_setting(jd_text, up["jd_analysis"])
    _setting_block = _build_jd_setting_block(_setting)
    _setting_prefix = (_setting_block + "\n\n") if _setting_block else ""
    logger.info("w8_integrated: JD setting classified as %s", _setting)

    user_prompt = _setting_prefix + COMPOSITION_USER_TEMPLATE.format(
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
    # Pass the family-aware label map so inject_directly domain keywords land on
    # the correct category line. For nursing: domain_knowledge → "**Care Skills:**"
    # not "**Other Skills:**". Without this, wound care / continence care injected
    # here would wrongly appear on the Other Skills line.
    md = _inject_missing_skills(md, up["feasibility"], family_label_map=build_family_label_map(role_family))
    md = stamp_contact_line(md, contact_details, role_family.id)
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
    # 3a-pre-2. Move obviously-technical skills out of Soft/Care lines.
    #     'Basic Smartphone Skills' / 'Computer Skills' / brand tools that
    #     end up on the wrong line because the LLM mis-classified them.
    if role_family.injection_policy != "none":
        md = _move_misplaced_technical_skills(md, role_family)
    # 3a-bis. Strip non-skill entries (qualifications, eligibility/compliance,
    #     bare sector names, JD-phrasing fillers) from the Skills section, no
    #     matter whether the base classifier or the surfacing pass added them.
    md = _strip_non_skill_phrases(md)
    # 3a-ter-pre. Re-route mis-bucketed Skills entries to the lexicon-correct
    #     line (e.g. 'Clinical Documentation' on Other Skills → Care Skills for
    #     nursing). Uses classify(entry, vertical) as the authority. Unknown
    #     entries stay put. Follow with enforce to re-cap any line that grew.
    md = reroute_skills_by_lexicon(md, vertical)
    md = enforce_skills_section(md)
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
    # 4c-tris. Stamp the user-saved References block (role-family agnostic).
    #          mode=details renders a 2-col table; mode=on_request renders
    #          a single line; mode=none omits the section entirely.
    final_md = stamp_references(final_md, contact_details)
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
    # 4j. Sprint E — enforce Professional Summary S2 concreteness. If S2
    #     contains no employer/tool/metric token, replace with a deterministic
    #     employer-naming sentence built from CV evidence. Fixes generic
    #     filler like "Provides safe support for older people in facility
    #     environments." S1 is preserved unchanged.
    final_md = enforce_summary_concreteness(final_md, cv_text)

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
            "jd_setting": _setting,  # passed to _writer_w8_verified for bridge pass
        },
    )


# ---------------------------------------------------------------------------
# Targeted bullet rewrite pass.
#
# After composition + verify_claims + all deterministic passes, some
# inject_as_extension keywords from the feasibility plan may still be absent
# from the generated CV — the composition LLM paraphrased instead of applying
# the approved rewrite. This pass detects missed items and runs one small,
# focused LLM call per bullet to incorporate the keyword.
#
# Only fires for inject_as_extension (not inject_directly — those are Skills
# section items already handled by _inject_approved_skills; not
# inject_with_inference — inference is too speculative for auto-rewrite).
#
# Role-category labels (home care, aged care, disability support …) reach this
# function and are correctly injected into bullets/summary — they are NOT
# filtered here. The Skills-section filter (_ROLE_CATEGORY_LABELS) runs
# separately in _approved_skill_entries and reroute_skills_by_lexicon.
# ---------------------------------------------------------------------------

_BULLET_MARKERS: Tuple[str, ...] = ("- ", "* ", "• ")


def _kw_norm(text: str) -> str:
    """Lower + collapse non-alphanumerics to single spaces, padded for substring checks."""
    return " " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "


async def _targeted_bullet_rewrites(
    client: "AIClient",
    markdown: str,
    feasibility: Optional[Dict[str, Any]],
) -> str:
    """Inject missed inject_as_extension keywords into experience bullets.

    For each approved extension keyword absent from the generated CV, find the
    most relevant experience bullet, then run ONE focused LLM call per bullet
    that incorporates ALL keywords routed to it. Grouping by bullet is what
    makes this collision-proof: two keywords sharing the same evidence (and
    therefore the same target bullet) are handled in a single rewrite rather
    than two concurrent calls that clobber each other's write.

    Each call's result is kept only if at least one of its keywords actually
    landed in the rewrite — otherwise the original bullet is preserved (the LLM
    paraphrased without using the phrase, so the rewrite buys nothing and risks
    fidelity loss).

    Returns the markdown unchanged when there are no missed items (zero latency
    cost on a clean run).
    """
    import asyncio

    plan = (feasibility or {}).get("feasibility_plan") or {}
    extensions = plan.get("inject_as_extension") or []
    if not extensions:
        return markdown

    md_norm = _kw_norm(markdown)

    def _kw_present_in(text_norm: str, kw: str) -> bool:
        kn = _kw_norm(kw).strip()
        return bool(kn) and (" " + kn + " ") in text_norm

    missed = [
        e for e in extensions
        if isinstance(e, dict)
        and str(e.get("keyword") or "").strip()
        and not _kw_present_in(md_norm, str(e.get("keyword")))
    ]
    if not missed:
        return markdown

    logger.info(
        "targeted_bullet_rewrites: %d missed inject_as_extension item(s): %s",
        len(missed), [str(e.get("keyword")) for e in missed],
    )

    lines = markdown.split("\n")

    # Locate ## Skills section so we never rewrite Skills lines.
    skills_start = next(
        (i for i, ln in enumerate(lines) if ln.strip().lower() == "## skills"), None
    )
    skills_end = len(lines)
    if skills_start is not None:
        for i in range(skills_start + 1, len(lines)):
            if lines[i].startswith("## "):
                skills_end = i
                break

    def _is_experience_bullet(i: int, line: str) -> bool:
        stripped = line.strip()
        if not stripped.startswith(_BULLET_MARKERS):
            return False
        if ":**" in stripped:      # Skills label line, e.g. "- **Care Skills:** ..."
            return False
        if skills_start is not None and skills_start < i < skills_end:
            return False
        return True

    def _find_best_bullet(evidence: str) -> Optional[int]:
        """Index of the experience bullet that best matches `evidence`."""
        ev_words = set(re.sub(r"[^a-z0-9 ]+", " ", evidence.lower()).split())
        if not ev_words:
            return None
        best_idx, best_score = None, 0
        for i, line in enumerate(lines):
            if not _is_experience_bullet(i, line):
                continue
            lw = set(re.sub(r"[^a-z0-9 ]+", " ", line.lower()).split())
            score = len(ev_words & lw)
            if score > best_score:
                best_score, best_idx = score, i
        return best_idx if best_score >= 3 else None

    # Group missed keywords by target bullet index. Each entry carries its
    # keyword + the plan's suggested_rewrite (a strong, pre-vetted reference).
    by_bullet: Dict[int, list] = {}
    for entry in missed:
        kw = str(entry.get("keyword") or "").strip()
        evidence = str(entry.get("evidence") or "").strip()
        if not evidence:
            logger.info("targeted_bullet_rewrites: no evidence for %r — skipped", kw)
            continue
        idx = _find_best_bullet(evidence)
        if idx is None:
            logger.info("targeted_bullet_rewrites: no matching bullet for %r — skipped", kw)
            continue
        by_bullet.setdefault(idx, []).append({
            "keyword": kw,
            "suggested_rewrite": str(entry.get("suggested_rewrite") or "").strip(),
        })

    if not by_bullet:
        return markdown

    def _strip_marker(line: str) -> str:
        s = line.strip()
        for mk in _BULLET_MARKERS:
            if s.startswith(mk):
                return s[len(mk):].strip()
        return s.lstrip("-*•").strip()

    async def _rewrite_bullet(idx: int, items: list) -> Optional[tuple]:
        original = _strip_marker(lines[idx])
        keywords = [it["keyword"] for it in items]
        kw_block = "\n".join(f"- {it['keyword']}" for it in items)
        ref_block = "\n".join(
            f"- {it['suggested_rewrite']}" for it in items if it["suggested_rewrite"]
        )
        try:
            rewritten = await client.complete(
                system=(
                    "You are a CV bullet editor. Rewrite the provided experience bullet "
                    "to naturally incorporate ALL of the listed keyword phrases. "
                    "Rules: preserve every existing fact verbatim; do not invent new "
                    "claims, employers, metrics, or credentials; every listed keyword "
                    "must appear in your rewrite; keep it to one concise sentence. "
                    "Return only the rewritten bullet text — no dash prefix, no commentary."
                ),
                user=(
                    f"Keywords to incorporate:\n{kw_block}\n\n"
                    f"Bullet to rewrite:\n{original}\n\n"
                    + (f"Reference rewrites (already vetted for honesty):\n{ref_block}\n"
                       if ref_block else "")
                ),
                max_tokens=220,
                temperature=0.2,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("targeted_bullet_rewrites: LLM call failed for bullet %d: %s", idx, exc)
            return None

        if not rewritten or len(rewritten.strip()) < 20:
            return None
        candidate = rewritten.strip()
        cand_norm = _kw_norm(candidate)
        landed = [k for k in keywords if _kw_present_in(cand_norm, k)]
        if not landed:
            logger.info(
                "targeted_bullet_rewrites: bullet %d rewrite dropped — no keyword landed (%s)",
                idx, keywords,
            )
            return None
        if len(landed) < len(keywords):
            logger.info(
                "targeted_bullet_rewrites: bullet %d partial — landed %s of %s",
                idx, landed, keywords,
            )
        return (idx, "- " + candidate, landed)

    results = await asyncio.gather(*[
        _rewrite_bullet(idx, items) for idx, items in by_bullet.items()
    ])

    applied = 0
    for item in results:
        if item:
            idx, new_line, landed = item
            lines[idx] = new_line
            applied += 1
            logger.info("targeted_bullet_rewrites: applied bullet %d, landed %s", idx, landed)

    logger.info("targeted_bullet_rewrites: %d/%d bullet(s) rewritten", applied, len(by_bullet))
    return "\n".join(lines)


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
    verified_md = reroute_skills_by_lexicon(verified_md, vertical)
    verified_md = enforce_skills_section(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # ── PHASE 2 RE-RUN ──────────────────────────────────────────────────────
    # verify_claims is an AI step that can rewrite ANY section, undoing the
    # Phase 2 sprints that ran inside _writer_w8_integrated. Re-run them here
    # so the final output is always Phase-2-canonical regardless of what the
    # verifier emits. All passes are idempotent → cheap re-run.
    #   • Sprint A: split mixed Certifications back into Awards + Certs
    #   • Sprint B: chronological order + bullet tense
    #   • Sprint C: body spelling, italic title case, date format
    #   • Sprint E: enforce Summary S2 concreteness
    # Sprint D is implicit in _normalise_awards_entries above.
    verified_md = split_awards_and_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    verified_md = sort_experience_chronologically(verified_md)
    verified_md = normalise_experience_tense(verified_md)
    verified_md = canonicalise_body_spelling(verified_md)
    verified_md = normalise_heading_title_case(verified_md)
    verified_md = normalise_date_formats(verified_md)
    # Strip the canned "Currently delivering care at X using BESTMed and
    # MedMobile" phrase BEFORE enforce_summary_concreteness so the concreteness
    # pass can replace it with a specific, JD-relevant achievement.
    verified_md = _strip_canned_summary_phrase(verified_md)
    # Deterministic setting bridge — replaces "residential aged care settings"
    # in S1 with the correct bridge phrase for home care, hospital, NDIS, or
    # theatre JDs. Re-classifies directly from jd_text + result.jd_analysis
    # rather than trusting result.extras, which can be stale in resume paths.
    # No-op for residential JDs.
    _setting_for_bridge = _classify_jd_setting(jd_text, result.jd_analysis)
    logger.info("w8_verified: S1 bridge — JD setting = %s", _setting_for_bridge)
    verified_md = _apply_setting_bridge(
        verified_md, _setting_for_bridge, cv_text=cv_text,
    )
    verified_md = enforce_summary_concreteness(verified_md, cv_text)
    # Targeted bullet rewrites — for inject_as_extension keywords the composition
    # LLM missed, run one small focused call per bullet concurrently. Zero cost
    # when the LLM applied all rewrites correctly (no missed items → no calls).
    # Runs AFTER all deterministic passes so rewrites are applied to the final
    # experience text, not an intermediate state.
    verified_md = await _targeted_bullet_rewrites(client, verified_md, result.feasibility)
    # Hard cap FIRST so each line is at DEFAULT_SKILL_CAPS (14/6/6) before
    # injection. Then cap-aware inject: approved keywords get priority over
    # writer-only tail items; writer-only items displaced when at cap.
    # NO enforce_skills_section after inject — it would truncate the
    # just-placed approved keywords off the tail (the pre-Fix-C regression).
    verified_md = enforce_skills_section(verified_md)
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
        md = _inject_missing_skills(md, result.feasibility, family_label_map=build_family_label_map(role_family))
        md = stamp_contact_line(md, contact_details, role_family.id)
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
    verified_md = reroute_skills_by_lexicon(verified_md, vertical)
    verified_md = enforce_skills_section(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # ── PHASE 2 RE-RUN (mirrors _writer_w8_verified) ────────────────────────
    verified_md = split_awards_and_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    verified_md = sort_experience_chronologically(verified_md)
    verified_md = normalise_experience_tense(verified_md)
    verified_md = canonicalise_body_spelling(verified_md)
    verified_md = normalise_heading_title_case(verified_md)
    verified_md = normalise_date_formats(verified_md)
    verified_md = enforce_summary_concreteness(verified_md, cv_text)
    # Cap FIRST, then cap-aware inject (mirrors _writer_w8_verified ordering).
    verified_md = enforce_skills_section(verified_md)
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
    # Derive lexicon vertical from the already-resolved role_family stored in
    # jd_analysis. Without this the re-router (and any future vertical-aware
    # pass) silently no-ops because vertical=None bypasses all lexicon logic.
    _FAMILY_TO_VERTICAL = {"tech": "tech", "nursing": "nursing", "manual": "cleaning"}
    vertical = _FAMILY_TO_VERTICAL.get(str(jd_analysis.get("role_family") or ""))
    result = await _writer_w8_verified(
        client, cv_text, jd_text, contact_details,
        vertical=vertical, upstream=upstream,
    )
    md = result.tailored_md
    if not md or len(md.strip()) < 200:
        raise ValueError("w8_verified tailored CV: response too short")
    storage_path = _upload_to_storage(user_id, run_id, md)
    return md, storage_path
