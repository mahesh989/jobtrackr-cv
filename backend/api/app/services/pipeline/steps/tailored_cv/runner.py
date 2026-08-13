"""Pipeline entry point — generate the tailored CV and store it.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

import asyncio
from app.services.ai.client import AIClient, TAILORED_CV_GENERATION
from typing import Any, Dict, Optional, Tuple
from app.services.ai.prompts import (
    TAILORED_CV_SYSTEM,
    TAILORED_CV_USER_TEMPLATE,
)
from app.config import get_settings
from app.database import get_supabase
import json
from app.services.cv.contact_line import stamp_contact_line
import uuid
from ._common import logger
from .credentials import _cert_policy_for
from .skills_injection import (
    _inject_missing_skills,
    build_family_label_map,
)
from .structure import _enforce_structure

async def run_tailored_cv(
    client: AIClient,
    user_id: uuid.UUID,
    run_id: uuid.UUID,
    cv_text: str,
    jd_analysis: Dict[str, Any],
    ai_recommendations_md: str,
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str]:
    """
    Returns:
        (markdown, storage_path)
    """
    # The prompt only needs the plan itself, not the summary block.
    feasibility_for_prompt = (feasibility or {}).get("feasibility_plan") or {}

    user_prompt = TAILORED_CV_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(jd_analysis, indent=2),
        ai_recommendations_md=ai_recommendations_md,
        feasibility_json=json.dumps(feasibility_for_prompt, indent=2),
    )
    # Bumped from cv-magic's 4096 to 6144. The tailored CV is the longest
    # AI output in the pipeline; verbose JDs + multi-role CVs can produce
    # markdown that hits 4096 and gets cut off mid-section, failing
    # _enforce_structure downstream. The AI client also retries on
    # truncation, but raising the first-try ceiling avoids the extra
    # round-trip in the common case.
    markdown = await client.complete(
        system=TAILORED_CV_SYSTEM,
        user=user_prompt,
        max_tokens=6144,
        operation="tailored_cv",
        **TAILORED_CV_GENERATION,
    )

    if not markdown or len(markdown.strip()) < 200:
        raise ValueError("Tailored CV: response too short")

    enforced_md = _enforce_structure(
        markdown.strip(),
        jd_job_title=str(jd_analysis.get("job_title") or ""),
        cv_text=cv_text,
        cert_policy=_cert_policy_for(jd_analysis),
    )

    role_family_id = jd_analysis.get("role_family")
    family_label_map = None
    if role_family_id:
        try:
            from app.services.eval.role_families import resolve_role_family
            rf = resolve_role_family(role_family_id, jd_analysis)
            if rf:
                family_label_map = build_family_label_map(rf)
        except Exception:
            logger.warning("Tailored CV: failed to resolve family %s for label map", role_family_id)

    # Deterministic safety net: ensure every approved Skills-targeted keyword
    # actually lands in the Skills section, even if the AI dropped or omitted
    # it. Avoids needing further prompt tightening for keyword recall.
    enforced_md = _inject_missing_skills(enforced_md, feasibility, family_label_map=family_label_map)

    # Stamp the user's saved contact details onto the contact line so the
    # output is consistent regardless of what the AI emitted.
    final_md = stamp_contact_line(enforced_md, contact_details, role_family_id=role_family_id)

    # Blocking Supabase Storage upload — run off the event loop the same way
    # pdf_output.py's identical upload_or_update call already does (its own
    # header explains why: this is the DEFAULT w8_verified path, so blocking
    # the shared event loop here stalls every other concurrent pipeline run,
    # not just this one — #12 audit).
    storage_path = await asyncio.to_thread(_upload_to_storage, user_id, run_id, final_md)
    return final_md, storage_path


def _upload_to_storage(user_id: uuid.UUID, run_id: uuid.UUID, markdown: str) -> str:
    from app.database import upload_or_update

    settings = get_settings()
    supabase = get_supabase()
    storage_path = f"{user_id}/{run_id}.md"

    upload_or_update(
        settings.SUPABASE_TAILORED_CV_BUCKET,
        storage_path,
        markdown.encode("utf-8"),
        "text/markdown",
        supabase=supabase,
    )

    return storage_path
