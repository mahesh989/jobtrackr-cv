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
from app.services.eval.enforce_w3 import apply_w3_gates
from app.services.eval.role_families import (
    resolve_role_family,
    resolve_seniority,
)
from app.services.cv.contact_line import stamp_contact_line
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
)

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
    client: AIClient, cv_text: str, jd_text: str,
) -> Dict[str, Any]:
    jd_analysis = await run_jd_analysis(client, jd_text)
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)
    ats = run_ats_scoring(cv_text, jd_analysis, matching)
    input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)
    feasibility = await run_keyword_feasibility(
        client, cv_text, jd_analysis, matching, input_recs,
    )
    return {
        "jd_analysis": jd_analysis,
        "matching":    matching,
        "ats":         ats,
        "input_recs":  input_recs,
        "feasibility": feasibility,
    }


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
    up = await _run_upstream(client, cv_text, jd_text)
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
    up = await _run_upstream(client, cv_text, jd_text)
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
    up = await _run_upstream(client, cv_text, jd_text)
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
    up = await _run_upstream(client, cv_text, jd_text)

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


async def _writer_w5_surfacing(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
) -> WriterResult:
    up = await _run_upstream(client, cv_text, jd_text)

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
    up = await _run_upstream(client, cv_text, jd_text)
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
    up = await _run_upstream(client, cv_text, jd_text)
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


WRITER_VARIANTS: Dict[str, WriterFn] = {
    "w1_current":     _writer_w1_current,
    "w2_general":     _writer_w2_general,
    "w3_composition": _writer_w3_composition,
    "w4_chat":        _writer_w4_chat,
    "w5_surfacing":   _writer_w5_surfacing,
    "w6_general":     _writer_w6_general,
    "w7_converged":   _writer_w7_converged,
}


def get_writer(writer_variant: str) -> WriterFn:
    fn = WRITER_VARIANTS.get(writer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown writer_variant '{writer_variant}'. "
            f"Known: {sorted(WRITER_VARIANTS)}"
        )
    return fn
