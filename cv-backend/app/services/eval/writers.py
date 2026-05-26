"""
Writer variant registry (Track W).

A writer takes the raw CV + JD (and BYOK client) and returns a WriterResult:
the tailored markdown plus the intermediate artifacts the runner needs to
score and report (jd_analysis, matching, initial ats, feasibility).

Phase 1 ships W1 only — a FAITHFUL reproduction of the production pipeline.
It reuses the existing step functions verbatim (no copies, no edits), so W1's
output is exactly what users get today. W2 (generalised), W3 (composition),
and W4 (chat single-call) plug in here later.

Note on storage: run_tailored_cv() uploads the markdown to the tailored-cvs
bucket as a side effect. For eval runs we pass a sentinel user_id
(all-zero UUID) + a random run_id so eval artifacts are easy to identify and
purge, and we ignore the returned storage path — the markdown itself is what
we persist to eval_runs.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional

from app.services.ai.client import AIClient
from app.services.pipeline.steps.jd_analysis import run_jd_analysis
from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
from app.services.pipeline.steps.ats_scoring import run_ats_scoring
from app.services.pipeline.steps.input_recommendations import run_input_recommendations
from app.services.pipeline.steps.keyword_feasibility import run_keyword_feasibility
from app.services.pipeline.steps.ai_recommendations import run_ai_recommendations
from app.services.pipeline.steps.tailored_cv import run_tailored_cv

_EVAL_USER_ID = uuid.UUID(int=0)  # sentinel: eval artifacts live under 0000…/


@dataclass
class WriterResult:
    tailored_md: str
    jd_analysis: Dict[str, Any]
    matching: Dict[str, Any]
    initial_ats_internal: Dict[str, Any]   # the pipeline's own ATS (used for input_recs + rescore baseline)
    feasibility: Dict[str, Any]
    extras: Dict[str, Any] = field(default_factory=dict)


# Signature: (client, cv_text, jd_text, contact_details) -> WriterResult
WriterFn = Callable[[AIClient, str, str, Optional[Dict[str, Any]]], Awaitable[WriterResult]]


async def _writer_w1_current(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
) -> WriterResult:
    """Faithful reproduction of the production tailoring pipeline (orchestrator steps 1-6)."""
    jd_analysis = await run_jd_analysis(client, jd_text)
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)
    ats = run_ats_scoring(cv_text, jd_analysis, matching)
    input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)
    feasibility = await run_keyword_feasibility(
        client, cv_text, jd_analysis, matching, input_recs
    )
    recs_md = await run_ai_recommendations(
        client, cv_text, jd_analysis, matching, input_recs, feasibility
    )
    tailored_md, _storage_path = await run_tailored_cv(
        client,
        _EVAL_USER_ID,
        uuid.uuid4(),
        cv_text,
        jd_analysis,
        recs_md,
        feasibility,
        contact_details=contact_details,
    )
    return WriterResult(
        tailored_md=tailored_md,
        jd_analysis=jd_analysis,
        matching=matching,
        initial_ats_internal=ats,
        feasibility=feasibility,
        extras={"input_recommendations": input_recs},
    )


WRITER_VARIANTS: Dict[str, WriterFn] = {
    "w1_current": _writer_w1_current,
}


def get_writer(writer_variant: str) -> WriterFn:
    fn = WRITER_VARIANTS.get(writer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown writer_variant '{writer_variant}'. "
            f"Known: {sorted(WRITER_VARIANTS)}"
        )
    return fn
