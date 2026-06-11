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

# Professional Summary S2 enforcement was extracted to writers.summary.
# Re-imported so _impl's remaining code + the test-suite keep referencing
# these unqualified.
from app.services.eval.writers.summary import (  # noqa: E402,F401
    _SUMMARY_HEADINGS, _SENT_END_RE, _METRIC_TOKEN_RE, _find_summary_section, _extract_summary_prose, _extract_present_employers_from_experience, _extract_cv_named_tools_for_summary, _employer_block_text, _block_until_next_section, _tools_attributable_to_employer, _EMPLOYER_GENERIC_TOKENS, _distinctive_employer_tokens, _s2_has_concrete_evidence, _compose_concrete_s2, enforce_summary_concreteness,
)

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
# Awards/credentials section logic was extracted to writers.awards.
# Re-imported so _impl's remaining code + the test-suite keep referencing
# these unqualified.
from app.services.eval.writers.awards import (  # noqa: E402,F401
    _is_description_only_entry, _normalise_awards_entries, _relabel_awards_only_certifications, _entry_is_award, _entry_is_cert, _registration_section_text, _credential_already_in_registration, split_awards_and_certifications, _drop_sections_by_ranges, _CRED_KEYWORDS, _OTHER_SECTION_WORDS, _is_cred_heading, _cv_heading_word, _extract_original_credentials, _awards_section_text, ensure_awards, _GROUNDED_SECTION_WORDS, _PLACEHOLDER_RE, _strip_ungrounded_credentials,
)


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
